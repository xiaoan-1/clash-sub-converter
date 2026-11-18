const express = require('express');
const path = require('path');
const guests = require('./src/user/guests');
const logger = require('./src/logger');
const apiRouter = require('./server/api');
const subRouter = require('./server/sub');

const os = require('os');

const app = express();
const PORT = process.env.PORT || 25500;
// 监听地址：默认 0.0.0.0（所有网卡，局域网/容器都能访问，与改动前一致）。
// 只想本机访问、不暴露到局域网时设 HOST=127.0.0.1。
const HOST = process.env.HOST || '0.0.0.0';

/**
 * 部署子路径（默认空 = 直接挂在根路径，行为与以前完全一致）。
 *
 * 设 BASE_PATH=/clash 后，服务自身全部路由挪到 /clash 之下：
 *   /clash/             使用说明页（/clash 会 301 过来）
 *   /clash/cfg          配置界面
 *   /clash/api/...      配置接口
 *   /clash/sub          订阅转换
 *
 * 页面里的资源引用全部是相对路径（./config.css、./api/config …），无论挂在根路径还是
 * 子路径都指向服务自身，nginx 只需一条 location：
 *   根路径：location /       { proxy_pass http://127.0.0.1:25500; }
 *   子路径：location /clash  { proxy_pass http://127.0.0.1:25500/clash; }
 * ⚠️ 子路径部署时 /clash（不带尾斜杠）必须 301 到 /clash/：否则相对路径的基准目录会
 *    算成 /，./config.css 会被解析到 /config.css 去。
 */
function normalizeBasePath(raw) {
	const v = String(raw || '')
		.trim()
		.replace(/\/+$/, '');
	if (!v || v === '/') return '';
	return v.startsWith('/') ? v : `/${v}`;
}
const BASE_PATH = normalizeBasePath(process.env.BASE_PATH);

// 反向代理后面必须设置 TRUST_PROXY，否则 req.ip 恒为 127.0.0.1，
// 所有访客会被判定成同一个人（详见 src/user/guests.js）
const TRUST_PROXY = guests.parseTrustProxy(process.env.TRUST_PROXY);
app.set('trust proxy', TRUST_PROXY);

const bootLog = logger.create('app');

/**
 * 列出本机所有 IPv4 地址（遍历全部网卡，不做任何筛选 / 排序）。
 *
 * 之所以不取「第一张网卡」：os.networkInterfaces() 的顺序由系统决定，
 * 同一台机器上第一张可能是 172.30 这类虚拟网卡，于是启动日志里的
 * 示例地址时对时错。全列出来最不容易出错 —— 哪个能用一目了然。
 *
 * @returns {Array<{name:string,address:string,internal:boolean}>}
 */
function listLocalAddresses() {
	const out = [];
	const nets = os.networkInterfaces();
	for (const name of Object.keys(nets)) {
		for (const net of nets[name] || []) {
			if (net.family !== 'IPv4') continue;
			out.push({ name, address: net.address, internal: !!net.internal });
		}
	}
	return out;
}

// 中间件
// 订阅正文动辄几百 KB（YAML 格式常达 200KB~1MB），/api/convert-file 与
// /api/convert 的 rawContent 都要收全文。默认 100kb 会让大订阅直接 413，
// 且前端只看到「request entity too large」不知所以然，因此放宽到 10MB。
const BODY_LIMIT = process.env.BODY_LIMIT || '10mb';
app.use(express.json({ limit: BODY_LIMIT }));

// 所有路由都注册在这个 router 上，最后整体挂到 BASE_PATH。
// 这样内部路径（/cfg、/api/...、/sub）无论部署在哪一级都不用改。
const router = express.Router();

/**
 * 基础安全响应头。
 *
 * 不引入 helmet 之类的依赖（本项目零运行时依赖），只加真正有意义的几条：
 *   - X-Content-Type-Options: nosniff
 *     阻止浏览器把响应「嗅探」成别的类型。订阅正文是用户可控内容，
 *     缺了这条时某些浏览器可能把 text/yaml 当 HTML 执行。
 *   - X-Frame-Options: DENY + CSP frame-ancestors 'none'
 *     阻止配置页被第三方站点用 iframe 嵌套（点击劫持 —— 诱导用户在
 *     看不见的 iframe 里改配置）。
 *   - Referrer-Policy: no-referrer
 *     订阅地址常把 token 放在路径/查询串里，避免它随 Referer 泄漏给第三方。
 *
 * 不加 CSP script-src：页面用了内联 onclick，加严格 CSP 会直接白屏，
 * 而这里没有外部脚本注入面，收益不抵风险。
 */
router.use((req, res, next) => {
	res.setHeader('X-Content-Type-Options', 'nosniff');
	res.setHeader('X-Frame-Options', 'DENY');
	res.setHeader('Referrer-Policy', 'no-referrer');
	next();
});

router.use(express.static(path.join(__dirname, 'web')));

/**
 * CORS：只给只读的 /sub 开，且不带凭据。
 *
 * /sub 是 GET、无副作用，浏览器端的第三方工具（如订阅管理面板）读它时需要
 * 跨域，并需要能读到 subscription-userinfo 等自定义响应头，故显式暴露。
 * 写接口（/api/config、/api/rules）不开 CORS —— 它们同源调用即可，
 * 开着反而给 CSRF 开了门（`Allow-Origin: *` 会让任意站点读到响应）。
 */
router.use('/sub', (req, res, next) => {
	res.header('Access-Control-Allow-Origin', '*');
	res.header(
		'Access-Control-Expose-Headers',
		'subscription-userinfo, profile-web-page-url, profile-update-interval, Content-Disposition',
	);
	if (req.method === 'OPTIONS') return res.sendStatus(200);
	next();
});

/**
 * 写请求的来源校验（轻量 CSRF 防护）。
 *
 * 浏览器发起跨域 POST/PUT/DELETE 时**一定**带 Origin 头，且不受脚本控制；
 * 因此「Origin 存在但与本站 host 不符」即可判定为跨站写请求，直接拒绝。
 * 无 Origin（curl / OpenClash / 服务端调用）不拦 —— 它们本就不是浏览器，
 * 不存在被第三方页面诱导的问题。
 *
 * host 的取值优先级：X-Forwarded-Host > Host。
 * 反向代理若把 Host 改写成上游地址（如 proxy_set_header Host 127.0.0.1），
 * 只用 Host 会导致「Origin 是真实域名」的正常写请求被误判成跨站而 403。
 * X-Forwarded-Host 是反代透传原始 Host 的标准头，优先用它即可避免误拒。
 * 注意这不降低安全性：攻击者要绕过仍须让浏览器发出的 Origin 与这两个头之一
 * 完全一致，而浏览器不允许脚本伪造这两者中的任何一个。
 */
function guardWriteOrigin(req, res, next) {
	if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
	const origin = req.get('origin');
	if (!origin) return next();

	let originHost;
	try {
		originHost = new URL(origin).host;
	} catch {
		return res.status(403).json({ error: '来源非法（Origin 无法解析）' });
	}

	// X-Forwarded-Host 只在显式启用了 trust proxy 时才采信：
	// 没部署在反向代理后面时，这个头完全由客户端控制，采信它等于允许
	// 攻击者伪造「请求来源主机」，从而绕过本校验。
	const forwarded = TRUST_PROXY ? (req.get('x-forwarded-host') || '').split(',')[0].trim() : '';
	const candidates = [forwarded, req.get('host')].filter(Boolean);

	if (!candidates.includes(originHost)) {
		return res.status(403).json({ error: '跨站写入被拒绝（Origin 与本站不符）' });
	}
	next();
}
router.use(guardWriteOrigin);

// ===================== 路由 =====================

/**
 * 同时进行的转换请求上限。
 *
 * js-yaml 的解析是同步的：单个大订阅就能把事件循环占住几十毫秒，
 * 一批并发请求叠加会连配置页都打不开。这里做的是「快速失败」而不是排队 ——
 * 订阅客户端本来就会定时重试，排队只会让请求越积越多。
 */
const MAX_CONVERTS =
	Number(process.env.MAX_CONCURRENT_CONVERTS) > 0
		? Number(process.env.MAX_CONCURRENT_CONVERTS)
		: 4;
let activeConverts = 0;

function limitConverts(req, res, next) {
	if (activeConverts >= MAX_CONVERTS) {
		// 503 + Retry-After：客户端（及订阅客户端）据此退避重试
		res.setHeader('Retry-After', '5');
		return res.status(503).json({
			error: '转换请求过多，请稍后重试',
			hint: `当前并发上限为 ${MAX_CONVERTS}，可用环境变量 MAX_CONCURRENT_CONVERTS 调整。`,
		});
	}
	activeConverts++;
	// close 在响应完成或被客户端中断时都会触发（Node 16+），
	// 用 once 保证计数只减一次
	res.once('close', () => {
		activeConverts--;
	});
	next();
}

// 只限制真正做解析 / 拉取的两个入口，配置页等静态请求不受影响
router.use('/sub', limitConverts);
router.use('/api/convert', limitConverts);

// 配置页面（子路径部署时为 域名/clash/cfg）
router.get('/cfg', (req, res) => {
	res.sendFile(path.join(__dirname, 'web', 'config.html'));
});

// 配置 API
router.use('/api', apiRouter);

// 首页
router.get('/', (req, res) => {
	res.sendFile(path.join(__dirname, 'web', 'index.html'));
});

// 订阅转换端点（OpenClash 兼容）
router.use('/sub', subRouter);

// ===================== 挂载与启动 =====================

// 部署在子路径时，域名/clash（不带尾斜杠）301 到 域名/clash/：
// 统一子路径下的地址形式；将来前端若改用相对路径引用，缺了尾斜杠会被解析到上一级去。
// 必须注册在 app.use(BASE_PATH, router) 之前，否则会被 router 的 '/' 抢先生效。
// 注意：Express 默认不区分尾斜杠，app.get('/clash') 连 '/clash/' 也会命中，
// 那样重定向目标又落回自己，会无限循环 —— 所以这里显式比对 req.path。
if (BASE_PATH) {
	app.get(BASE_PATH, (req, res, next) => {
		if (req.path !== BASE_PATH) return next();
		res.redirect(301, `${BASE_PATH}/`);
	});
}

// 根路径部署时为 '/'，子路径部署时为 '/clash'
app.use(BASE_PATH || '/', router);

/**
 * 统一错误处理（必须放在所有路由之后，且四个参数缺一不可）。
 *
 * 主要处理 express.json 抛出的解析类错误 —— 默认会返回 HTML 错误页，
 * 调用方（尤其前端 fetch）拿到的不是 JSON，无法展示有意义的信息。
 */
app.use((err, req, res, next) => {
	if (res.headersSent) return next(err);
	if (err.type === 'entity.too.large') {
		return res.status(413).json({
			error: `请求体过大（上限 ${BODY_LIMIT}）`,
			hint: '订阅正文超出上限，请改用「订阅链接」而非直接粘贴内容，或调大 BODY_LIMIT 环境变量',
		});
	}
	if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
		return res.status(400).json({ error: '请求体不是合法 JSON' });
	}
	logger.create('app').fail('未处理的请求错误', err, {
		method: req.method,
		path: req.path,
	});
	res.status(500).json({ error: '服务器内部错误' });
});

// ===================== 启动 =====================

/**
 * 进程级兜底。
 *
 * 异步代码里漏写的 try/catch 最终会落在这里 —— 至少留下一条完整日志，
 * 而不是让进程静静地死掉（表现为「服务莫名其妙不响应」）。
 * uncaughtException 之后进程状态已不可信，直接退出交给 PM2 重启。
 */
process.on('unhandledRejection', reason => {
	const err = reason instanceof Error ? reason : new Error(String(reason));
	bootLog.fail('未处理的 Promise 拒绝', err);
});
process.on('uncaughtException', err => {
	bootLog.fail('未捕获异常，进程即将退出（PM2 会自动重启）', err);
	process.exit(1);
});

/**
 * 启动成功后的启动信息（打印访问地址与关键部署参数）。
 */
function onListening() {
	// 部署子路径时把前缀一并打出来，免得照着终端里的地址去填 OpenClash 却是 404
	const p = BASE_PATH;
	const addrs = listLocalAddresses();
	// 本机地址永远可用，作为主示例 —— 之前取「第一张网卡」，
	// 而这台机器的第一张是 172.30 的虚拟网卡，示例地址于是变成了一个
	// 其他设备连不上的地址（看起来还像是公网 IP）。
	const localBase = `http://127.0.0.1:${PORT}${p}`;
	const guestCount = guests.listGuestIds().length;

	console.log(`\n🚀 Clash 订阅转换器已启动（端口 ${PORT}）\n`);
	console.log(`   使用说明页  ${localBase}/`);
	console.log(`   配置界面    ${localBase}/cfg`);
	console.log(`   订阅转换    ${localBase}/sub?target=clash&url=<订阅链接>`);

	// 监听范围：想给手机 / 其他设备填地址时看这一段
	console.log('');
	if (HOST !== '0.0.0.0') {
		console.log(
			`   监听 ${HOST}:${PORT}${p}（未绑 0.0.0.0，局域网其他设备访问不到；需要时设 HOST=0.0.0.0）`,
		);
	} else if (!addrs.length) {
		console.log(`   监听 0.0.0.0:${PORT}${p}（未发现任何网卡地址）`);
	} else {
		console.log(`   监听 0.0.0.0:${PORT}${p}，可用地址：`);
		for (const a of addrs) {
			const url = `http://${a.address}:${PORT}${p}`;
			console.log(`     ${url.padEnd(34)}（${a.name}${a.internal ? '，本机' : ''}）`);
		}
	}

	// 所有访问者（含本机）都各写自己的访客配置；基准靠改 config/default.json
	console.log(`   访客 ${guestCount} 个文件 · 反向代理 ${TRUST_PROXY ? '已启用' : '未启用'}`);
	if (!TRUST_PROXY) {
		console.log(
			`   ⚠ 未设 TRUST_PROXY：在 Nginx / Caddy 后面时 req.ip 恒为 127.0.0.1，所有访客会被当成同一个人`,
		);
	}
	console.log(`   基准配置    config/default.json（由部署人员直接编辑）`);
	console.log('');

	bootLog.info('服务已启动', {
		port: PORT,
		host: HOST,
		url: localBase,
		// 全部网卡地址（含网卡名），排查「手机连不上」时先看它
		ips: addrs.length ? addrs.map(a => `${a.address}(${a.name})`) : undefined,
		pid: process.pid,
		node: process.version,
		env: process.env.NODE_ENV || 'development',
		'base-path': BASE_PATH || '/',
		'app.log': logger.APP_LOG,
		'file-level': logger.level.fileName,
		'console-level': logger.level.consoleName,
		'trust-proxy': TRUST_PROXY,
		'guest-dir': guests.GUEST_DIR,
		guests: guestCount,
	});
	bootLog.info('排查提示：完整流程日志在 logs/app.log，仅问题在 logs/error.log');
}

/**
 * 启动 HTTP 服务。
 *
 * 不在模块顶层直接 listen：那样任何 `require('./index')`（脚本 / 单测）
 * 都会占住端口。只有作为入口运行时才自动启动（见下方 require.main 判断）。
 *
 * @returns {import('http').Server}
 */
function start() {
	return app.listen(PORT, HOST, onListening);
}

if (require.main === module) start();

module.exports = { app, start };

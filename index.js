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
// 所有访客会被判定成同一个人（详见 src/guests.js）
const TRUST_PROXY = guests.parseTrustProxy(process.env.TRUST_PROXY);
app.set('trust proxy', TRUST_PROXY);

const bootLog = logger.create('app');

// 获取本机所有局域网 IPv4（可能有不止一张网卡：有线 + 无线 + Docker/虚拟机虚拟网卡）
function getLocalIPs() {
	const out = [];
	const nets = os.networkInterfaces();
	for (const name of Object.keys(nets)) {
		for (const net of nets[name] || []) {
			if (net.family === 'IPv4' && !net.internal) out.push(net.address);
		}
	}
	return out;
}

// 中间件
app.use(express.json());

// 所有路由都注册在这个 router 上，最后整体挂到 BASE_PATH。
// 这样内部路径（/cfg、/api/...、/sub）无论部署在哪一级都不用改。
const router = express.Router();

router.use(express.static(path.join(__dirname, 'web')));
router.use((req, res, next) => {
	res.header('Access-Control-Allow-Origin', '*');
	// 订阅元信息走自定义响应头（subscription-userinfo 等），
	// 浏览器调用时需要显式暴露才能读到。
	res.header(
		'Access-Control-Expose-Headers',
		'subscription-userinfo, profile-web-page-url, profile-update-interval, Content-Disposition',
	);
	if (req.method === 'OPTIONS') return res.sendStatus(200);
	next();
});

// ===================== 路由 =====================

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

// 启动服务
app.listen(PORT, HOST, () => {
	// 部署子路径时把前缀一并打出来，免得照着终端里的地址去填 OpenClash 却是 404
	const p = BASE_PATH;
	const ips = getLocalIPs();
	// 示例地址用第一张网卡的 IP；仅监听指定地址时就用该地址
	const base = `http://${HOST === '0.0.0.0' ? ips[0] || '127.0.0.1' : HOST}:${PORT}${p}`;
	const adminList = guests.adminIps(TRUST_PROXY);
	const guestCount = guests.listGuestIds().length;

	console.log(`\n🚀 Clash 订阅转换器已启动（端口 ${PORT}）\n`);
	console.log(`   使用说明页  ${base}/`);
	console.log(`   配置界面    ${base}/cfg`);
	console.log(`   订阅转换    ${base}/sub?target=clash&url=<订阅链接>`);

	// 监听范围：想给手机 / 其他设备填地址时看这一行
	console.log('');
	console.log(
		HOST === '0.0.0.0'
			? `   监听 0.0.0.0:${PORT}${p}（本机 127.0.0.1 / 网卡 ${ips.join(' / ') || '无'}）`
			: `   监听 ${HOST}:${PORT}${p}（未绑 0.0.0.0，局域网其他设备访问不到）`,
	);

	// 访客隔离最容易出事的地方是「以为在隔离，其实全用同一份配置」，所以启动时
	// 把判定依据（管理员 IP 列表 / 是否启用反代）直接打在控制台上
	console.log(
		`   访客 ${guestCount} 个文件 · 管理员 ${adminList.join(', ') || '(空，请在 ADMIN_IPS 里配置)'} · 反向代理 ${TRUST_PROXY ? '已启用' : '未启用'}`,
	);
	if (!TRUST_PROXY) {
		console.log(
			`   ⚠ 未设 TRUST_PROXY：在 Nginx / Caddy 后面时 req.ip 恒为 127.0.0.1，所有访客会被当成同一个人`,
		);
	}
	console.log('');

	bootLog.info('服务已启动', {
		port: PORT,
		host: HOST,
		url: base,
		pid: process.pid,
		node: process.version,
		env: process.env.NODE_ENV || 'development',
		'base-path': BASE_PATH || '/',
		'app.log': logger.APP_LOG,
		'file-level': logger.level.fileName,
		'console-level': logger.level.consoleName,
		'trust-proxy': TRUST_PROXY,
		'admin-ips': adminList,
		'guest-dir': guests.GUEST_DIR,
		guests: guestCount,
	});
	bootLog.info('排查提示：完整流程日志在 logs/app.log，仅问题在 logs/error.log');
});

module.exports = app;

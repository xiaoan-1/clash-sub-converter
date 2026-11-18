/**
 * 订阅拉取
 *
 * 负责代拉订阅源，并把机场下发的元信息（流量 / 到期 / 官网 / 文件名）
 * 转发给客户端。UA 可配置：机场会校验拉取订阅的客户端标识，
 * 若与你的实际客户端不一致，可能被判定为「非本人操作 / 订阅地址泄漏」
 * 而作废订阅地址。
 */
const { resolveUserAgent, FALLBACK_UA } = require('./user/user-agents');
const { validateSubscriptionUrl, assertSubscriptionHostAllowed } = require('./utils/url-guard');
const logger = require('./logger');
const {
	readSubHeader,
	parseUserInfo,
	mergeUserInfo,
	formatUserInfo,
	sanitizeHomeUrl,
	parseUpdateInterval,
	parseFileName,
	buildContentDisposition,
} = require('./utils/subscription-meta');

const log = logger.create('fetch');

/** 默认 UA（未做任何配置时使用），与 user-agents 的兜底值同源 */
const DEFAULT_FETCH_UA = FALLBACK_UA;

/** 拉取订阅的超时时间。超时与其它失败要分开报，排查方向完全不同 */
const SUBSCRIBE_TIMEOUT_MS = 15000;

/**
 * 单份订阅正文的体积上限（可用 MAX_SUB_BYTES 覆盖）。
 *
 * 订阅正文是外部可控内容：没有上限时一个几百 MB 的响应就能把内存吃满
 * （订阅客户端还会定时刷新，多个客户端叠加更糟）。正常机场订阅在
 * 200KB~2MB，32MB 足够宽松。
 */
const MAX_RESPONSE_BYTES =
	Number(process.env.MAX_SUB_BYTES) > 0 ? Number(process.env.MAX_SUB_BYTES) : 32 * 1024 * 1024;

/**
 * 跟随重定向的最大跳数。
 *
 * 必须自己跟随（redirect: 'manual'）而不是交给 fetch 的 follow ——
 * 后者只在第一跳做 SSRF 校验，`302 → http://169.254.169.254/` 会直接放行。
 * 每一跳都重新过 validateSubscriptionUrl + DNS 校验。
 */
const MAX_REDIRECTS = 5;

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/**
 * 单次请求最多接受的订阅份数（可用 MAX_SUB_URLS 覆盖）。
 *
 * 多订阅是串行拉取的，份数不设上限时一个 `/sub?url=a|b|c|...` 就能让
 * 单个请求占用几分钟（每份最多 15s）—— 既是自伤也是打机场。
 */
const MAX_URLS = Number(process.env.MAX_SUB_URLS) > 0 ? Number(process.env.MAX_SUB_URLS) : 10;

/**
 * 一次请求内所有订阅共享的总耗时预算（可用 SUB_TOTAL_TIMEOUT_MS 覆盖）。
 *
 * 单份超时是 15s，10 份就是 150s —— 客户端早就断开了，服务却还在拉。
 * 超过预算后剩余订阅直接判失败，让请求尽快返回并给出可操作提示。
 */
const TOTAL_TIMEOUT_MS =
	Number(process.env.SUB_TOTAL_TIMEOUT_MS) > 0 ? Number(process.env.SUB_TOTAL_TIMEOUT_MS) : 60000;

/** 为一次请求创建总预算截止时间，传给 requestSubscription 的 deadline */
function newDeadline() {
	return Date.now() + TOTAL_TIMEOUT_MS;
}

/**
 * 失败时预览响应正文的上限，超过就不读了，避免把大文件拉进内存。
 * 与 logger 的预览阈值共用同一常量，避免两处各调一次而悄悄分叉。
 */
const MAX_PREVIEW_SOURCE_BYTES = logger.MAX_PREVIEW_SOURCE_BYTES;

/**
 * 判断一个异常是否由超时触发。
 *
 * AbortSignal.timeout 抛出的异常在 err 与 err.cause 上表现不一致，
 * 这里顺着 cause 链扫一遍，两者都认。
 */
function isTimeoutError(err) {
	for (let e = err, depth = 0; e && depth < 4; e = e.cause, depth++) {
		const name = String(e.name || '');
		if (name === 'TimeoutError' || name === 'AbortError') return true;
		if (String(e.code || '') === 'UND_ERR_ABORTED') return true;
	}
	return false;
}

/** 构造一个「正文过大」的异常，调用方据此区分「读完了」与「拒绝继续读」 */
function bodyTooLargeError(limit) {
	const err = new Error(`响应体超过上限 ${logger.formatBytes(limit)}`);
	err.code = 'BODY_TOO_LARGE';
	return err;
}

/**
 * 流式读取响应正文，超过上限立即中止。
 *
 * 不能用 `response.text()`：它会把整个响应读进内存后才知道有多大。
 * 这里边读边累计，越界就 cancel 掉剩余的流，避免把几十 MB 拉进来。
 *
 * @param {Response} response
 * @param {number} limit 字节上限
 * @returns {Promise<string>} UTF-8 正文
 * @throws {Error} 超过上限时抛 code=BODY_TOO_LARGE
 */
async function readBodyLimited(response, limit) {
	if (!response.body) return '';

	const declared = Number(response.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > limit) {
		try {
			await response.body.cancel();
		} catch {
			/* 忽略 */
		}
		throw bodyTooLargeError(limit);
	}

	const reader = response.body.getReader();
	const chunks = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.length;
			if (total > limit) {
				try {
					await reader.cancel();
				} catch {
					/* 忽略 */
				}
				throw bodyTooLargeError(limit);
			}
			chunks.push(Buffer.from(value));
		}
	} finally {
		try {
			reader.releaseLock();
		} catch {
			/* 忽略 */
		}
	}
	return Buffer.concat(chunks).toString('utf-8');
}

/** 组装「订阅地址不安全」的异常（stage=guard，上层据此返回 400） */
function guardError(reason, hint) {
	const err = new Error(reason);
	err.hint = hint || reason;
	err.stage = 'guard';
	err.failReason = reason;
	return err;
}

/**
 * 把一个失败的 HTTP 响应拆成可落盘的诊断字段。
 *
 * 重点是 `body`：机场在 token 失效 / 订阅过期 / 限流时，通常会在正文里
 * 直接写明原因（`订阅已过期` / `token is invalid` / `请求过于频繁`），
 * 这比状态码本身有用得多。正文统一过 preview() 脱敏 + 截断。
 */
async function describeHttpFailure(response) {
	const headers = response.headers;
	const out = {
		'content-type': headers.get('content-type') || '-',
		reason: `HTTP ${response.status}${response.statusText ? ' ' + response.statusText : ''}`,
		hint: logger.httpHint(response.status),
		// 以下头部用于判断「是谁返回的这个错误」：CDN 拦截或机场自己的错误页
		server: headers.get('server') || undefined,
		'cf-ray': headers.get('cf-ray') || undefined,
		via: headers.get('via') || undefined,
		'www-authenticate': headers.get('www-authenticate') || undefined,
		'retry-after': headers.get('retry-after') || undefined,
		location: headers.get('location') || undefined,
	};

	const declared = Number(headers.get('content-length'));
	if (Number.isFinite(declared) && declared > MAX_PREVIEW_SOURCE_BYTES) {
		return { ...out, body: `(响应体 ${logger.formatBytes(declared)}，过大未读取)` };
	}

	try {
		// 预览也走流式限长：没有 content-length 的响应同样不能无限读
		const text = await readBodyLimited(response, MAX_PREVIEW_SOURCE_BYTES);
		out['body-bytes'] = logger.formatBytes(Buffer.byteLength(text, 'utf-8'));
		out.body = logger.preview(text, 200) || '(空)';
	} catch (err) {
		out.body =
			err.code === 'BODY_TOO_LARGE'
				? `(响应体超过 ${logger.formatBytes(MAX_PREVIEW_SOURCE_BYTES)}，未读取)`
				: `(读取响应体失败：${err.message})`;
	}
	return out;
}

/**
 * 请求订阅源，返回正文与元信息响应头。
 *
 * @param {string} url
 * @param {Object} [options]
 * @param {string} [options.userAgent] - 直接指定 UA（优先级最高）
 * @param {string} [options.uaSource]  - 这个 UA 是哪来的（仅用于日志）
 * @param {Object} [options.fetchCfg]  - 配置中的 fetch 段 { userAgent, customUserAgent }
 * @param {string} [options.callerUA]  - 调用方请求头里的 UA（供 auto 模式透传）
 * @returns {Promise<{text:string,userInfo:Object|null,homeUrl:string,updateInterval:string,fileName:string}>}
 */
async function requestSubscription(url, options = {}) {
	let ua = options.userAgent;
	let uaSource = options.uaSource;
	if (!ua) {
		// 调用方未预先算 UA 时的兜底，顺带取回「这个 UA 是哪来的」供日志使用
		const resolved = resolveUserAgent(options.fetchCfg || {}, options.callerUA || '');
		ua = resolved.ua;
		uaSource = resolved.source;
	}
	ua = ua || DEFAULT_FETCH_UA;
	uaSource = uaSource || '未标注';

	const safe = logger.safeUrl(url);
	const host = logger.hostOf(url);
	const t = logger.timer();

	// SSRF 防护：订阅地址是外部可控输入，先校验协议与目标地址，
	// 拒绝 file:// 等协议与内网 / 回环 / 云元数据地址。
	const guard = validateSubscriptionUrl(url);
	if (!guard.ok) {
		log.warn('订阅地址未通过安全校验，已拒绝', { url: safe, host, reason: guard.reason });
		throw guardError(guard.reason);
	}

	// 域名可能解析到内网（DNS rebinding 的简化版），解析后再判一次
	await assertSubscriptionHostAllowed(guard.url);

	// 整体预算：所有 URL 共用 options.deadline（见 /sub 与 /api/convert），
	// 单份订阅最多用 SUBSCRIBE_TIMEOUT_MS，且不会超过剩余预算。
	const deadline =
		Number(options.deadline) > 0 ? Number(options.deadline) : Date.now() + SUBSCRIBE_TIMEOUT_MS;
	const remainingMs = () => deadline - Date.now();

	// 「用什么去订阅的」：UA 是机场风控的第一道门槛，UV 报 403 时先看这行
	log.debug('发起订阅请求', {
		method: 'GET',
		url: safe,
		host,
		ua,
		'ua-source': uaSource,
		accept: '*/*',
		timeout: logger.formatMs(SUBSCRIBE_TIMEOUT_MS),
		'redirect-mode': 'manual',
	});

	let response;
	let currentUrl = guard.url;
	let redirects = 0;
	/**
	 * 元信息头按「首个非空」跨跳收集。
	 *
	 * 部分机场 / 对象存储在 **302 响应**上下发订阅信息，最终 200 里没有
	 * （跳转到临时签名 URL 后，S3/CDN 不会重复下发机场的业务头）。
	 * 只取最终响应会让客户端「有节点、没有流量和到期时间」；
	 * 自己跟随重定向时这些头正好在我们手里，顺手收集即可。
	 */
	const subHeaders = { userinfo: '', homeUrl: '', interval: '', fileName: '' };

	/** 从一份响应头里补齐还缺的元信息（已有值不覆盖，先到先得） */
	const collectMeta = headers => {
		if (!headers) return;
		if (!subHeaders.userinfo)
			subHeaders.userinfo = readSubHeader(headers, 'subscription-userinfo');
		if (!subHeaders.homeUrl)
			subHeaders.homeUrl = readSubHeader(headers, 'profile-web-page-url');
		if (!subHeaders.interval) {
			subHeaders.interval = readSubHeader(headers, 'profile-update-interval');
		}
		if (!subHeaders.fileName)
			subHeaders.fileName = readSubHeader(headers, 'content-disposition');
	};

	for (;;) {
		const budget = Math.min(SUBSCRIBE_TIMEOUT_MS, remainingMs());
		if (budget <= 0) {
			const err = new Error(`请求超出总时长预算（${logger.formatMs(SUBSCRIBE_TIMEOUT_MS)}）`);
			err.stage = 'timeout';
			err.failReason = '超出本次请求的总时长预算，已中止';
			err.hint = '订阅份数过多或订阅源过慢：减少订阅数量，或稍后重试。';
			log.warn('拉取订阅失败：超出总预算', { url: safe, host, redirects });
			throw err;
		}

		try {
			response = await fetch(currentUrl, {
				headers: { 'User-Agent': ua, Accept: '*/*' },
				signal: AbortSignal.timeout(budget),
				// 自己跟随重定向：交给 fetch 的 follow 会绕过逐跳 SSRF 校验
				redirect: 'manual',
			});
		} catch (err) {
			// 超时 / DNS / TLS / 连接被拒都在这里。区分超时与其他，排查方向完全不同
			const timeout = isTimeoutError(err);
			const d = logger.describeError(err);
			const hint = timeout
				? '只有这一个订阅超时 → 多半是机场侧问题；所有订阅都超时 → 检查本机网络 / DNS / 代理。'
				: '连接阶段就失败，说明还没到机场的鉴权环节：先确认订阅域名能 ping 通 / 能解析。';
			log.warn('拉取订阅失败：请求未能完成', {
				url: safe,
				host,
				ua,
				'ua-source': uaSource,
				dur: t.text(),
				'fail-stage': timeout ? 'timeout' : 'connect',
				reason: timeout ? `超时（${logger.formatMs(budget)} 内未拿到响应）` : d.reason,
				'net-code': d['net-code'],
				'net-cause': d['net-cause'],
				'net-detail': d['net-detail'],
				'net-hint':
					d['net-hint'] ||
					(timeout ? '对端在超时时间内未响应：机场侧慢或被网络阻断' : undefined),
				hint,
			});
			// 把翻译结果挂到异常上，供上层（/sub、/api/convert）汇总时复用：
			// Node fetch 的原始错误码在 err.cause 里，上层直接读 err.code 只会拿到空值
			err.netCode = d['net-code'];
			err.hint = err.hint || hint;
			err.stage = timeout ? 'timeout' : 'connect';
			// 上层汇总用这句，而不是 undici 那句英文的 aborted due to timeout
			err.failReason = timeout
				? `超时（${logger.formatMs(budget)} 内未拿到响应）`
				: err.message;
			throw err;
		}

		// 重定向：每一跳都重新做协议 / 地址 / DNS 校验，否则第一跳合法、
		// 第二跳指向 169.254.169.254 就能绕过整套防护。
		// 元信息头无论落在哪一跳都要收下来（见 subHeaders 的说明）。
		if (!REDIRECT_STATUS.has(response.status)) break;

		collectMeta(response.headers);

		const location = response.headers.get('location');
		try {
			await response.body?.cancel();
		} catch {
			/* 忽略 */
		}

		if (!location) {
			log.warn('拉取订阅失败：重定向缺少 Location', { url: safe, status: response.status });
			const err = new Error(`HTTP ${response.status} 重定向缺少 Location`);
			err.status = response.status;
			err.stage = 'http';
			err.failReason = '重定向响应缺少 Location 头';
			throw err;
		}
		if (redirects >= MAX_REDIRECTS) {
			log.warn('拉取订阅失败：重定向次数过多', { url: safe, redirects });
			const err = new Error(`重定向超过 ${MAX_REDIRECTS} 次`);
			err.stage = 'http';
			err.failReason = `重定向超过 ${MAX_REDIRECTS} 次，已中止`;
			err.hint = '订阅地址指向了环链或过多的跳转，请检查机场给出的地址。';
			throw err;
		}

		let next;
		try {
			next = new URL(location, currentUrl).toString();
		} catch {
			log.warn('拉取订阅失败：重定向地址非法', {
				url: safe,
				location: logger.safeUrl(location),
			});
			const err = new Error('重定向地址非法');
			err.stage = 'http';
			err.failReason = '重定向地址非法';
			throw err;
		}

		const nextGuard = validateSubscriptionUrl(next);
		if (!nextGuard.ok) {
			log.warn('重定向目标未通过安全校验，已拒绝', {
				url: safe,
				to: logger.safeUrl(next),
				reason: nextGuard.reason,
			});
			throw guardError(`重定向目标不安全：${nextGuard.reason}`);
		}
		await assertSubscriptionHostAllowed(nextGuard.url);

		redirects++;
		currentUrl = nextGuard.url;
		log.debug('跟随重定向', { hop: redirects, to: logger.safeUrl(currentUrl) });
	}

	// HTTP 层失败：带上状态行、关键响应头与正文摘要。
	// 机场的「token 失效 / 订阅过期 / 请求过于频繁」通常直接写在正文里。
	if (!response.ok) {
		const meta = await describeHttpFailure(response);
		log.warn('拉取订阅失败：服务端返回错误状态码', {
			url: safe,
			host,
			ua,
			'ua-source': uaSource,
			dur: t.text(),
			'fail-stage': 'http',
			status: response.status,
			'status-text': response.statusText || '-',
			server: meta.server,
			'cf-ray': meta['cf-ray'],
			via: meta.via,
			'www-authenticate': meta['www-authenticate'],
			'retry-after': meta['retry-after'],
			location: meta.location,
			'content-type': meta['content-type'],
			'body-bytes': meta['body-bytes'],
			'response-body': meta.body,
			reason: meta.reason,
			hint: meta.hint,
		});

		// 把诊断信息挂到异常上，供上层（/sub、/api/convert）汇总时复用
		const e = new Error(`HTTP ${response.status}`);
		e.status = response.status;
		e.statusText = response.statusText || '';
		e.responseBody = meta.body;
		e.hint = meta.hint;
		e.stage = 'http';
		e.failReason = meta.reason;
		throw e;
	}

	const headers = response.headers;
	let text;
	try {
		text = await readBodyLimited(response, MAX_RESPONSE_BYTES);
	} catch (err) {
		if (err.code === 'BODY_TOO_LARGE') {
			log.warn('拉取订阅失败：响应体超过上限', {
				url: safe,
				host,
				limit: logger.formatBytes(MAX_RESPONSE_BYTES),
			});
			const e = new Error(`订阅正文超过上限 ${logger.formatBytes(MAX_RESPONSE_BYTES)}`);
			e.stage = 'size';
			e.failReason = `订阅正文超过上限 ${logger.formatBytes(MAX_RESPONSE_BYTES)}`;
			e.hint =
				'该订阅体积异常偏大（可能是错误页或二进制内容），请确认订阅地址是否正确；确属正常可调大 MAX_SUB_BYTES。';
			throw e;
		}
		throw err;
	}

	// 最终响应也要收（先到先得，跳转里的不覆盖最终响应的真实值）
	collectMeta(headers);

	const userInfo = parseUserInfo(subHeaders.userinfo);
	const homeUrl = sanitizeHomeUrl(subHeaders.homeUrl);
	const updateInterval = parseUpdateInterval(subHeaders.interval);
	const fileName = parseFileName(subHeaders.fileName);

	log.info('拉取订阅成功', {
		url: safe,
		host,
		ua,
		'ua-source': uaSource,
		dur: t.text(),
		status: response.status,
		'content-type': headers.get('content-type') || '-',
		bytes: logger.formatBytes(Buffer.byteLength(text, 'utf-8')),
		// age>0 表示这次命中了 CDN 缓存，拿到的是旧订阅，可解释「订阅没更新」
		'cdn-cache': headers.get('cf-cache-status') || headers.get('x-cache') || undefined,
		age: headers.get('age') || undefined,
		redirects: redirects || undefined,
	});

	// 机场元信息逐项记录：客户端「订阅详情」空白时，靠这几行判断是机场没下发还是本地没转发
	log.debug('订阅元信息', {
		url: safe,
		userinfo: userInfo ? formatUserInfo(userInfo) : '(无)',
		homeUrl: homeUrl || '(无)',
		interval: updateInterval || '(无)',
		fileName: fileName || '(无)',
		// 原样保留 / 解析失败时才有值：机场写法不规范时（如 expire 给了非法值），
		// 光看「(无)」无法区分「没下发」与「下发了但解析不出来」
		raw: {
			userinfo: subHeaders.userinfo || undefined,
			interval: subHeaders.interval || undefined,
		},
		// 没拿到流量信息时，列出所有「可能是元信息」的响应头名（只列名字，不列值）：
		// 有些机场把信息放进了非标准头（x-userinfo / subscription-info …），
		// 有了这份清单就能一眼看出该给哪个头补兼容，而不是反复猜。
		'hint-header-names': userInfo
			? undefined
			: [...headers.keys()].filter(k => /info|sub|traffic|user|expire|profile/i.test(k)),
	});

	return { text, userInfo, homeUrl, updateInterval, fileName };
}

/** 只需订阅正文时的便捷包装 */
async function fetchSubscription(url, options = {}) {
	return (await requestSubscription(url, options)).text;
}

/**
 * 把订阅源下发的元信息响应头转发给客户端。
 *
 * Clash / Clash Verge / ClashX 等客户端靠这些头展示订阅流量、到期时间、
 * 官网入口与自动更新间隔。转换器若只转发 YAML 正文，这些信息会全部丢失，
 * 客户端面板上的订阅详情就是空白。
 *
 * @param {import('express').Response} res
 * @param {Array} metas - requestSubscription 的返回值列表
 */
function applySubscriptionHeaders(res, metas) {
	const list = (metas || []).filter(Boolean);
	if (!list.length) {
		log.debug('无需转发订阅信息：没有成功拉取到的订阅元信息');
		return;
	}

	const userInfo = mergeUserInfo(list.map(m => m.userInfo));
	if (userInfo) res.setHeader('subscription-userinfo', formatUserInfo(userInfo));

	// 多订阅时以下三项只取第一份非空的：把「取自哪一份」一并记下，
	// 否则订阅名/官网与用户预期不符时无从判断是不是取错了源。
	const pickFirst = key => {
		const idx = list.findIndex(m => m[key]);
		return idx < 0 ? '' : list[idx][key];
	};
	const homeUrl = pickFirst('homeUrl');
	if (homeUrl) res.setHeader('profile-web-page-url', homeUrl);

	const interval = pickFirst('updateInterval');
	if (interval) res.setHeader('profile-update-interval', interval);

	const fileName = pickFirst('fileName');
	if (fileName) {
		try {
			res.setHeader('Content-Disposition', buildContentDisposition(fileName));
		} catch {
			// 文件名含响应头不支持的字符时跳过，不影响正文
		}
	}

	log.debug('订阅信息转发结果', {
		sources: list.length,
		userinfo: userInfo ? formatUserInfo(userInfo) : '(机场未下发)',
		homeUrl: homeUrl || '(无)',
		interval: interval || '(无)',
		fileName: fileName || '(无)',
		// 多订阅时注明各项取自第几份，便于对照订阅名/官网是否来自预期的那一份
		pickedFrom:
			list.length > 1
				? {
						homeUrl: homeUrl ? list.findIndex(m => m.homeUrl) + 1 : undefined,
						interval: interval ? list.findIndex(m => m.updateInterval) + 1 : undefined,
						fileName: fileName ? list.findIndex(m => m.fileName) + 1 : undefined,
					}
				: undefined,
	});
}

module.exports = {
	requestSubscription,
	fetchSubscription,
	applySubscriptionHeaders,
	MAX_URLS,
	TOTAL_TIMEOUT_MS,
	newDeadline,
};

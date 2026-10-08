const express = require('express');
const { parseSubscriptionList, extractClashDns } = require('../src/parser');
const { convertToClash, convertToSurge } = require('../src/converter');
const { requestSubscription, applySubscriptionHeaders } = require('../src/fetcher');
const { parseRuleOptions } = require('../src/rule-groups');
const { readConfig } = require('../src/user/user-config');
const { resolveUserAgent, sanitizeUa } = require('../src/user/user-agents');
const guests = require('../src/user/guests');
const logger = require('../src/logger');

const router = express.Router();

/**
 * subconverter 兼容端点 - 专供 OpenClash
 * OpenClash 发送: /sub?target=clash&url=...&include=...&exclude=...&ua=...
 *
 * 本 router 由 index.js 挂载到 /sub（router.use('/sub', subRouter)），
 * 因此内部路由使用根路径 '/'，避免路径叠加成 /sub/sub。
 *
 * 只实现上面这几个参数。subconverter 的 emoji / udp / scv / sort /
 * append_type / config（外部模板 URL）本服务一律不支持，此前虽被解构出来
 * 却从未使用，读代码时容易误以为它们有效，故不再解构：
 *   - udp    节点是否 UDP 由订阅自身决定（parser 里统一置 true）
 *   - scv    skip-cert-verify 同样只来自订阅
 *   - emoji  不做节点名 emoji 处理
 *   - sort   保持订阅原有顺序
 *   - config 本服务自带分组 / 规则体系，不套用外部模板
 */
router.get('/', async (req, res) => {
	// 每次请求一个编号，同一请求的多行日志都能用 [sub#xxxxxx] 串起来
	const log = logger.create(`sub#${logger.reqId()}`);
	const timer = logger.timer();

	res.on('finish', () => {
		log.info('请求结束', {
			status: res.statusCode,
			dur: timer.text(),
		});
	});

	try {
		const { target = 'clash', url, include, exclude, ua } = req.query;

		const scope = guests.scopeOf(req);
		const client = scope.ip;

		if (!url) {
			log.warn('缺少 url 参数', { client, 'user-agent': req.get('user-agent') || '-' });
			return res.status(400).json({ error: 'Missing url parameter' });
		}

		// 多个 URL 用 | 分隔
		const urls = url
			.split('|')
			.map(u => u.trim())
			.filter(Boolean);

		// 拉取订阅时使用的 UA：?ua= 显式指定 > 配置 > 透传调用方（浏览器则回退预设）
		// 这里读的是「本访客那份配置」：UA / 过滤 / 分组都随访客各自生效
		const callerUA = req.get('user-agent') || '';
		const { fetch: fetchCfg = {} } = readConfig(scope.guest);
		// 连同「这个 UA 是怎么定出来的」一起带下去：机场因 UA 不一致作废订阅时靠它定位
		// ?ua= 来自查询串（外部可控），同样要过一遍清洗，避免控制字符进日志 / 发给机场
		const queryUa = sanitizeUa(ua);
		const uaResolved = queryUa
			? { ua: queryUa, source: '?ua= 显式指定' }
			: resolveUserAgent(fetchCfg, callerUA);
		const fetchOpts = { userAgent: uaResolved.ua, uaSource: uaResolved.source };

		log.info('请求进入', {
			target,
			urls: urls.length,
			client,
			scope: scope.guest || '站点基准',
			'caller-ua': callerUA || '(空)',
			mode: ua ? 'query' : fetchCfg.userAgent || 'auto',
			'send-ua': fetchOpts.userAgent,
			'ua-source': uaResolved.source,
			include: include || '-',
			exclude: exclude || '-',
		});
		log.debug('订阅地址清单', { urls: urls.map(u => logger.safeUrl(u)) });

		// 获取所有订阅内容，同时收集机场下发的元信息（流量 / 到期 / 官网 / 文件名）
		let allContent = '';
		const metas = [];
		const failures = [];
		const fetchTimer = logger.timer();

		for (let i = 0; i < urls.length; i++) {
			const u = urls[i];
			try {
				const decodedUrl = u.startsWith('http') ? u : decodeURIComponent(u);
				log.debug(`拉取订阅 ${i + 1}/${urls.length}`, { url: logger.safeUrl(decodedUrl) });
				const result = await requestSubscription(decodedUrl, fetchOpts);
				allContent += (allContent ? '\n' : '') + result.text;
				metas.push(result);
			} catch (err) {
				// 日志/响应里隐去订阅地址中的凭据，避免泄漏 token
				const safe = logger.safeUrl(u);
				// 这里只做一条带编号的短行（requestSubscription 已打过完整诊断），
				// 但保留 status / net-code，方便没开 DEBUG 时也能直接定位
				const item = {
					url: safe,
					reason: err.failReason || err.message,
					stage: err.stage,
					status: err.status,
					code: err.status ? undefined : err.netCode,
				};
				failures.push(item);
				log.warn(`拉取订阅 ${i + 1}/${urls.length} 失败`, {
					url: safe,
					host: logger.hostOf(u),
					'fail-stage': err.stage,
					status: err.status,
					'net-code': err.netCode,
					reason: item.reason,
					hint: err.hint,
				});
			}
		}

		log.info('订阅拉取阶段结束', {
			total: urls.length,
			ok: metas.length,
			failed: failures.length,
			bytes: logger.formatBytes(Buffer.byteLength(allContent, 'utf-8')),
			dur: fetchTimer.text(),
		});

		if (!allContent) {
			// 常见原因：机场安全规则拦截（403/451）、订阅地址已失效、拉取 UA 与客户端不一致
			const hasHttpError = failures.some(f => /HTTP 4\d\d/.test(f.reason));
			const hint = hasHttpError
				? '订阅源返回了错误状态码：订阅地址可能已失效，或拉取所用 UA 被机场安全规则拦截。请先在「配置界面 → 订阅拉取设置」中选择与你客户端一致的 UA。'
				: '无法连接到订阅源，请检查网络或订阅地址。';
			log.warn('全部订阅拉取失败，终止转换', {
				total: urls.length,
				'by-stage': logger.countBy(failures, f => f.stage || '其他'),
				'by-reason': logger.countBy(failures, f => f.reason),
				'by-net-code': logger.countBy(
					failures.filter(f => f.code),
					f => f.code,
				),
				'ua-used': fetchOpts.userAgent,
				'ua-source': uaResolved.source,
				failures: failures.map(
					f => `${f.url} → ${f.reason}${f.code ? `（${f.code}）` : ''}`,
				),
				hint,
			});
			return res
				.status(400)
				.json({ error: 'Failed to fetch any subscription', hint, failures });
		}

		// 多订阅必须分别解析再合并：把多份 YAML 直接拼接会产生重复根键，
		// yaml.load 会直接失败（表现为「No valid proxies found」）。
		const { proxies, dropped } = parseSubscriptionList(metas.map(m => m.text));
		if (dropped) log.info('合并多订阅时丢弃同名节点', { dropped });

		if (proxies.length === 0) {
			log.warn('解析后没有任何有效节点，终止转换', { sources: metas.length });
			return res.status(400).json({ error: 'No valid proxies found' });
		}

		log.info('解析结果', {
			proxies: proxies.length,
			types: logger.countBy(proxies, p => p.type),
		});

		// 把机场的流量 / 到期 / 官网信息转发给客户端，否则 Clash 面板上订阅详情为空白
		applySubscriptionHeaders(res, metas);
		const forwarded = [
			'subscription-userinfo',
			'profile-web-page-url',
			'profile-update-interval',
			'Content-Disposition',
		]
			.filter(h => res.getHeader(h))
			.map(h => `${h}=${res.getHeader(h)}`);
		if (forwarded.length) {
			log.info('已转发订阅信息给客户端', { headers: forwarded });
		} else {
			log.warn('订阅源未下发流量 / 到期信息（该机场不支持），客户端订阅详情将为空白');
		}

		const ruleOptions = parseRuleOptions(include, exclude);
		log.debug('规则组开关', { ruleOptions });

		const convertTimer = logger.timer();
		let output;
		let outType;

		if (target.startsWith('surge')) {
			output = convertToSurge(proxies, { ruleOptions, guestId: scope.guest });
			outType = 'text/plain';
		} else {
			// 源订阅若自带 Clash DNS 配置则透传，保证与直接导入等价。
			// 必须扫全部订阅再取第一个命中的：早期只取 metas[0]，
			// 于是「第一份是 URI 列表、第二份是 Clash YAML」时 dns 会静默丢失，
			// 与 /api/convert（sources.map(extractClashDns).find(Boolean)）行为不一致。
			const srcDns = metas.map(m => extractClashDns(m.text)).find(Boolean);
			// guestId 决定用哪份过滤开关 / 分组策略
			const convertOptions = { ruleOptions, guestId: scope.guest };
			if (srcDns) convertOptions.dns = srcDns;
			log.debug('源订阅 DNS 透传', { dns: srcDns ? '有' : '无' });
			output = convertToClash(proxies, convertOptions).yaml;
			outType = 'text/yaml';
		}

		log.info('转换完成，准备响应', {
			target,
			out: logger.formatBytes(Buffer.byteLength(output, 'utf-8')),
			convertDur: convertTimer.text(),
			totalDur: timer.text(),
		});

		res.type(outType).send(output);
	} catch (err) {
		// 全部节点被过滤属用户配置问题：返回 400 + 可操作提示，而非 500 服务端错误
		if (err.code === 'ALL_PROXIES_FILTERED') {
			log.warn('全部节点被过滤条件排除，返回 400', { err: err.message, hint: err.hint });
			// 上边的 applySubscriptionHeaders 可能已设置下载头，
			// 这里必须撤掉，否则浏览器会把错误 JSON 当成文件下载。
			res.removeHeader('Content-Disposition');
			return res.status(400).json({ error: err.message, hint: err.hint });
		}
		log.fail('转换过程中发生未预期的错误', err);
		res.status(500).json({ error: 'Convert failed: ' + err.message });
	}
});

module.exports = router;

const express = require('express');
const {
	parseSubscriptionList,
	extractClashDns,
	decodeSubscriptionContent,
} = require('../src/parser');
const { convertToClash, convertToSurge } = require('../src/converter');
const {
	requestSubscription,
	applySubscriptionHeaders,
	MAX_URLS,
	newDeadline,
} = require('../src/fetcher');
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
		const { target = 'clash', url, include, exclude, ua, config: templateUrl } = req.query;

		const scope = guests.scopeOf(req);
		const client = scope.ip;

		// OpenClash 走转换时必定带 config=<模板地址>；本服务不套用模板，忽略即可
		if (templateUrl !== undefined) {
			log.debug('已忽略订阅转换模板参数', { 'config-empty': !templateUrl });
		}

		// 本访客生效配置：UA / 过滤 / 分组 / 已保存的订阅地址都来自这一份
		const guestCfg = readConfig(scope.guest);

		// 订阅地址来源：
		//   ?url= 显式指定  → 优先（保留原有 subconverter 兼容行为）
		//   未带 url         → 用本访客在配置页保存的地址，客户端直接填 /sub 即可
		let urls;
		let urlSource;
		if (url) {
			urlSource = 'query';
			urls = url
				.split('|')
				.map(u => u.trim())
				.filter(Boolean);
		} else {
			urlSource = 'guest';
			urls = Array.isArray(guestCfg.subscriptions) ? guestCfg.subscriptions.slice() : [];
			if (!urls.length) {
				// 这里最常见的困惑是「我明明保存了，但客户端拉取说没有地址」——
				// 原因几乎都是保存与拉取来自不同出口 IP（手机 / 路由器与电脑不同 IP）。
				const subBase = (req.baseUrl || '/sub').replace(/\/sub$/, '');
				const pageUrl = `${req.protocol}://${req.get('host') || 'localhost'}${subBase}/cfg`;
				log.warn('未提供 url，且本访客未保存订阅地址', {
					client,
					guest: scope.guest,
					pageUrl,
				});
				return res.status(400).json({
					error: '未提供订阅地址，且当前 IP 尚未保存订阅地址',
					hint:
						`请先在 ${pageUrl} 的「我的订阅」里保存订阅链接，` +
						'之后代理软件直接填本地址即可。注意：保存与拉取需来自同一出口 IP。',
					configUrl: pageUrl,
				});
			}
		}

		// 份数上限：串行拉取下每份最多 15s，不设上限时单个请求能占用几分钟
		if (urls.length > MAX_URLS) {
			log.warn('订阅份数超过上限', { urls: urls.length, limit: MAX_URLS });
			return res.status(400).json({
				error: `订阅份数超过上限（${MAX_URLS}）`,
				hint: `请把订阅合并到 ${MAX_URLS} 个以内，或调大环境变量 MAX_SUB_URLS。`,
			});
		}

		// 拉取订阅时使用的 UA：?ua= 显式指定 > 配置 > 透传调用方（浏览器则回退预设）
		// 这里读的是「本访客那份配置」：UA / 过滤 / 分组都随访客各自生效
		const callerUA = req.get('user-agent') || '';
		const fetchCfg = guestCfg.fetch || {};
		// 连同「这个 UA 是怎么定出来的」一起带下去：机场因 UA 不一致作废订阅时靠它定位
		// ?ua= 来自查询串（外部可控），同样要过一遍清洗，避免控制字符进日志 / 发给机场
		const queryUa = sanitizeUa(ua);
		const uaResolved = queryUa
			? { ua: queryUa, source: '?ua= 显式指定' }
			: resolveUserAgent(fetchCfg, callerUA);
		const fetchOpts = {
			userAgent: uaResolved.ua,
			uaSource: uaResolved.source,
			// 所有订阅共享这一份总预算，避免「10 份 × 15s」长时间占住请求
			deadline: newDeadline(),
		};

		log.info('请求进入', {
			target,
			urls: urls.length,
			// query = 调用方自带地址；guest = 用的是本访客保存的地址
			'url-source': urlSource,
			client,
			scope: scope.guest,
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
				// 订阅地址可能被调用方 encodeURIComponent 过，这里解回原文。
				// 但畸形编码（如 %E4%B8%AD 截断）会让 decodeURIComponent 抛 URIError，
				// 直接冒泡到外层 catch 会变成 500 —— 对用户输入问题应回退原串。
				let decodedUrl = u;
				if (!u.startsWith('http')) {
					try {
						decodedUrl = decodeURIComponent(u);
					} catch {
						decodedUrl = u;
					}
				}
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
		// 解码只做一次：判格式、解析、DNS 提取共用同一个结果。
		const sourceTexts = metas.map(m => m.text);
		const decodedSources = sourceTexts.map(decodeSubscriptionContent);
		const { proxies, dropped } = parseSubscriptionList(sourceTexts, decodedSources);
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

		// 只有请求带了 include/exclude 才覆盖配置里的分组开关；
		// parseRuleOptions(undefined, undefined) 会返回「全部启用」，直接传会覆盖用户配置
		const hasRuleFilter = Boolean(include || exclude);
		const ruleOptions = hasRuleFilter ? parseRuleOptions(include, exclude) : undefined;
		log.debug('规则组开关', {
			'from-query': hasRuleFilter,
			enabled: ruleOptions
				? Object.keys(ruleOptions).filter(k => ruleOptions[k])
				: '(按配置)',
		});

		const convertTimer = logger.timer();
		let output;
		let outType;
		// 分组数取自转换器的 summary（需排除末尾 2 个系统条目）
		let groupCount;

		if (target.startsWith('surge')) {
			output = convertToSurge(proxies, { ruleOptions, guestId: scope.guest });
			outType = 'text/plain';
		} else {
			// 源订阅自带 Clash DNS 则透传，保证与直接导入等价
			const srcDns = sourceTexts
				.map((t, i) => extractClashDns(t, decodedSources[i]))
				.find(Boolean);
			const convertOptions = { ruleOptions, guestId: scope.guest };
			if (srcDns) convertOptions.dns = srcDns;
			log.debug('源订阅 DNS 透传', { dns: srcDns ? '有' : '无' });
			const result = convertToClash(proxies, convertOptions);
			output = result.yaml;
			groupCount = result.summary.groups.filter(g => g.type !== 'system').length;
			outType = 'text/yaml';
		}

		if (hasRuleFilter) {
			log.info('按 include/exclude 生成的分组', { target, groups: groupCount });
		}

		log.info('转换完成，准备响应', {
			target,
			out: logger.formatBytes(Buffer.byteLength(output, 'utf-8')),
			convertDur: convertTimer.text(),
			totalDur: timer.text(),
		});

		res.type(outType).send(output);
	} catch (err) {
		// 输入 / 配置问题 → 400，其余才是服务端故障：
		//   ALL_PROXIES_FILTERED 全部节点被过滤
		//   stage=guard          订阅地址未通过安全校验（SSRF）
		//   stage=size           订阅正文超过上限
		const userError =
			err.code === 'ALL_PROXIES_FILTERED' || err.stage === 'guard' || err.stage === 'size';
		if (userError) {
			log.warn('请求被拒绝（属输入 / 配置问题）', {
				err: err.message,
				hint: err.hint,
				stage: err.stage,
				code: err.code,
			});
			// 上边的 applySubscriptionHeaders 可能已设置下载头，
			// 这里必须撤掉，否则浏览器会把错误 JSON 当成文件下载。
			res.removeHeader('Content-Disposition');
			return res.status(400).json({
				error: err.message,
				hint: err.hint,
				...(err.code === 'ALL_PROXIES_FILTERED' ? { totalNodes: err.totalNodes } : {}),
			});
		}
		log.fail('转换过程中发生未预期的错误', err);
		res.status(500).json({ error: 'Convert failed: ' + err.message });
	}
});

module.exports = router;

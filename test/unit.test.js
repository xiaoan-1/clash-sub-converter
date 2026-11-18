/**
 * 单元测试（node:test）
 *
 * 覆盖那些「出错了也不会在端到端测试里暴露」的纯函数：
 *   - SSRF 地址判定（IPv4 / IPv6 / IPv4-mapped / 数字型写法）
 *   - 规则出口识别（no-resolve 修饰段）
 *   - 地区识别边界（CN2 GIA 不能被当成国内）
 *   - 节点 URL 解析（IPv6 方括号 / userinfo 百分号编码）
 *   - 分组引用（无悬空引用、无循环引用）
 *
 * 端到端的那部分（把配置交给真实 mihomo 加载）在 verify-with-mihomo.js 里，
 * 两者都由 `pnpm test` 执行。
 */

const test = require('node:test');
const assert = require('node:assert');

const { validateSubscriptionUrl } = require('../src/utils/url-guard');
const { ruleTargetOf } = require('../src/rule-manager');
const { generateProxyGroups, isDomestic, getRegion } = require('../src/proxy-groups');
const { parseNodeUrl } = require('../src/parser/utils');

// ===================== SSRF =====================

test('SSRF：拒绝内网 / 回环 / 云元数据 / IPv4-mapped IPv6', () => {
	const blocked = [
		'http://127.0.0.1/x',
		'http://127.1.2.3/',
		'http://10.0.0.1/',
		'http://172.16.0.1/',
		'http://192.168.1.1/',
		'http://169.254.169.254/latest/meta-data/',
		'http://[::1]/',
		'http://[::]/',
		// URL 会把这类写法规范化成 127.0.0.1 —— 规范化后仍必须被拦
		'http://2130706433/',
		'http://0x7f.1/',
		// IPv4-mapped IPv6：URL 会写成 [::ffff:a9fe:a9fe]，肉眼已看不出是内网
		'http://[::ffff:169.254.169.254]/',
		'http://[::ffff:a9fe:a9fe]/',
		'http://[::ffff:127.0.0.1]/',
		// ULA / link-local
		'http://[fd00::1]/',
		'http://[fe80::1]/',
		// 内网域名
		'http://localhost:8080/',
		'http://router.local/',
		'http://foo.internal/',
		// 协议白名单
		'file:///etc/passwd',
		'gopher://example.com/',
	];

	for (const url of blocked) {
		assert.equal(validateSubscriptionUrl(url).ok, false, url);
	}
});

test('SSRF：允许公网地址', () => {
	const allowed = [
		'https://example.com/sub',
		'http://1.1.1.1/x',
		'https://[2606:4700::1111]/',
		'https://sub.example.com:8443/path?token=x',
	];
	for (const url of allowed) {
		assert.equal(validateSubscriptionUrl(url).ok, true, url);
	}
});

test('SSRF：空地址与畸形地址返回原因而非抛错', () => {
	const empty = validateSubscriptionUrl('');
	assert.equal(empty.ok, false);
	assert.equal(empty.reason, '订阅地址为空');

	const broken = validateSubscriptionUrl('not a url');
	assert.equal(broken.ok, false);
	assert.equal(broken.reason, '订阅地址格式非法');
});

// ===================== 规则出口识别 =====================

test('规则出口识别：支持 no-resolve / src 修饰段', () => {
	// 修饰段在 target 之后，target 必须从右往左跳过修饰段才取得到
	assert.equal(ruleTargetOf('IP-CIDR,10.0.0.0/8,DIRECT,no-resolve'), 'DIRECT');
	assert.equal(ruleTargetOf('IP-CIDR6,fc00::/7,DIRECT,no-resolve'), 'DIRECT');
	assert.equal(ruleTargetOf('GEOIP,CN,DIRECT'), 'DIRECT');
	assert.equal(ruleTargetOf('DOMAIN-SUFFIX,t.me,💬 Telegram'), '💬 Telegram');
	assert.equal(ruleTargetOf('MATCH,🐟 漏网之鱼'), '🐟 漏网之鱼');
	assert.equal(ruleTargetOf('FINAL,🐟 漏网之鱼'), '🐟 漏网之鱼');
});

test('规则出口识别：没有 target 的规则返回空串', () => {
	assert.equal(ruleTargetOf('IP-CIDR,1.2.3.4/32,no-resolve'), '');
	assert.equal(ruleTargetOf('DOMAIN,example.com'), '');
});

// ===================== 地区识别 =====================

test('地区识别：短英文关键词按词边界匹配', () => {
	// CN2 GIA 里的 CN 不是「中国大陆」，IN 不能命中 KINX
	assert.equal(isDomestic('CN2 GIA 洛杉矶'), false);
	assert.equal(isDomestic('KINX 韩国'), false);
	// 真正的国内节点
	assert.equal(isDomestic('上海 电信'), true);
	assert.equal(isDomestic('香港 01'), false);
});

test('地区识别：先匹配具体地区，再判断国内', () => {
	// 「台湾省」含「省」，「中华电信」含「电信」—— 必须判成台湾而非国内
	assert.equal(getRegion('[台湾省] 中华电信'), '🇹🇼 台湾');
	assert.equal(getRegion('🇭🇰 深港专线'), '🇭🇰 香港');
	assert.equal(getRegion('完全看不懂的名字'), null);
});

// ===================== 节点 URL 解析 =====================

test('节点 URL：IPv6 去掉方括号', () => {
	const parsed = parseNodeUrl('trojan://pw@[2001:db8::1]:443#节点');
	assert.ok(parsed);
	assert.equal(parsed.server, '2001:db8::1');
	assert.equal(parsed.name, '节点');
});

test('节点 URL：userinfo 解百分号编码', () => {
	// URL 会保留编码形态，不解码就会把 p%40ss 当作真实密码
	const parsed = parseNodeUrl('trojan://p%40ss@example.com:443#x');
	assert.equal(parsed.username, 'p@ss');
});

test('节点 URL：名称里的裸 % 不会让整条节点被丢弃', () => {
	// decodeURIComponent 遇到裸 % 会抛 URIError，必须宽容回退
	const parsed = parseNodeUrl('trojan://pw@example.com:443#100%稳定');
	assert.ok(parsed);
	assert.equal(parsed.name, '100%稳定');
});

test('节点 URL：畸形链接返回 null 而不是抛错', () => {
	assert.equal(parseNodeUrl('trojan://pw@:443'), null);
	assert.equal(parseNodeUrl('完全不是链接'), null);
});

// ===================== 分组引用 =====================

const BUILTINS = new Set(['DIRECT', 'REJECT', 'PASS', 'GLOBAL']);

/** 断言：所有分组引用的目标都存在，且分组之间没有环 */
function assertReferentialIntegrity(groups, proxyNames) {
	const byName = new Map(groups.map(g => [g.name, g]));
	const valid = new Set([...byName.keys(), ...BUILTINS, ...proxyNames]);

	for (const group of groups) {
		assert.ok(group.proxies.length > 0, `${group.name} 是空分组`);
		for (const ref of group.proxies) {
			assert.ok(valid.has(ref), `${group.name} 引用了不存在的 ${ref}`);
		}
	}

	const visiting = new Set();
	const done = new Set();
	const visit = name => {
		if (done.has(name)) return;
		assert.ok(!visiting.has(name), `分组存在循环引用：${name}`);
		visiting.add(name);
		const g = byName.get(name);
		if (g) {
			for (const ref of g.proxies) {
				if (byName.has(ref)) visit(ref);
			}
		}
		visiting.delete(name);
		done.add(name);
	};
	for (const g of groups) visit(g.name);
}

test('分组：地区分组开启后无悬空引用、无循环引用', () => {
	const proxies = [
		{ name: '🇭🇰 香港 01', type: 'vmess' },
		{ name: '🇯🇵 日本 01', type: 'vmess' },
		{ name: '上海 电信', type: 'vmess' },
		{ name: '无法识别地区的节点', type: 'vmess' },
	];
	const groups = generateProxyGroups(proxies, {
		userGroups: [{ builtin: 'regions', enabled: true, type: 'url-test' }],
	});

	assertReferentialIntegrity(
		groups,
		proxies.map(p => p.name),
	);
});

test('分组：地区分组关闭时上层分组直接列节点', () => {
	const proxies = [
		{ name: '🇭🇰 香港 01', type: 'vmess' },
		{ name: '🇯🇵 日本 01', type: 'vmess' },
	];
	const groups = generateProxyGroups(proxies, {
		userGroups: [{ builtin: 'regions', enabled: false }],
	});

	assertReferentialIntegrity(
		groups,
		proxies.map(p => p.name),
	);
	const select = groups.find(g => g.name === '🚀 节点选择');
	assert.ok(select.proxies.includes('🇭🇰 香港 01'));
});

test('分组：🐟 漏网之鱼的默认出口来自配置', () => {
	const groups = generateProxyGroups([{ name: '🇭🇰 香港 01', type: 'vmess' }], {
		userGroups: [{ builtin: 'fallback', name: '🐟 漏网之鱼', defaultProxy: 'DIRECT' }],
	});
	const fallback = groups.find(g => g.name === '🐟 漏网之鱼');
	assert.equal(fallback.proxies[0], 'DIRECT');
});

test('分组：🇨🇳 中国大陆的默认出口来自配置', () => {
	const groups = generateProxyGroups([{ name: '上海 电信', type: 'vmess' }], {
		userGroups: [{ builtin: 'domestic', name: '🇨🇳 中国大陆', defaultProxy: '上海 电信' }],
	});
	const cn = groups.find(g => g.name === '🇨🇳 中国大陆');
	assert.equal(cn.proxies[0], '上海 电信');
	assert.ok(cn.proxies.includes('DIRECT'));
});

/**
 * 巡检分流规则里的域名是否还活着
 *
 * 用来回答一个问题：`config/rules/*.json` 里哪些域名已经不存在了，可以删掉。
 *
 * 为什么必须走 DoH
 * ----------------
 * 本机（开发机）的 UDP:53 被 Clash TUN 接管，`dns.resolve4()` / `Resolve-DnsName`
 * 对**任何**域名都返回 fake-ip（`198.18.x.x`），连 `setServers(['8.8.8.8'])` 也没用。
 * 只有 DoH over HTTPS 能拿到真实结果。所以这里直接查 Cloudflare / Google。
 *
 * 什么结论能用来删规则
 * --------------------
 *   NXDOMAIN   域名已不存在 → **可以删**（规则永远不可能命中）
 *   LIVE       有 A 记录     → 保留
 *   NO-A       无 A 记录     → **不能删**！
 *   UNKNOWN    查询失败      → 不能删，重跑再看
 *
 * ⚠️ `NO-A` 绝对不等于「域名死了」。大量域名是**只在子域上提供服务的命名空间**，
 * apex 本来就没有 A 记录，例如：
 *   microsoftonline.com（只有 login./login.microsoftonline.com 在服务）
 *   trafficmanager.net、windowsupdate.com、onmicrosoft.com、msauth.net、
 *   gfx.ms、sfx.ms、mstea.ms、msecnd.net、msocdn.com、edgesuite.net、
 *   aspnetcdn.com、livefilestore.com …
 * 实测 microsoft.json 的 634 个 DOMAIN-SUFFIX 里，163 个属于这一类。
 *
 * ⚠️ 对 apex 做 HTTP 探测同样没用。这类 apex 压根不建站，175 个 NO-A 域名里
 * 0 个能返回 HTTP 响应（对照组 7/7 正常，探测本身是好的）→ 区分不出
 * 「命名空间」和「真死」。判活只能靠 DNS，判「规则有没有用」得靠域名语义。
 *
 * 用法
 * ----
 *   node test/check-rule-domains.js                 全部规则（约 1~2 分钟）
 *   node test/check-rule-domains.js a.com b.com     只查指定域名
 *   node test/check-rule-domains.js --json          只输出 JSON
 *
 * 退出码：没有 NXDOMAIN 为 0，发现 NXDOMAIN 为 1（可直接接进日常巡检）。
 */

const fs = require('fs');
const path = require('path');

const RULES_DIR = path.join(__dirname, '..', 'config', 'rules');

/** 两个独立的 DoH 解析源，结论必须一致才敢下判断 */
const DOH_ENDPOINTS = [
	name => `https://cloudflare-dns.com/dns-query?name=${name}&type=A`,
	name => `https://dns.google/resolve?name=${name}&type=A`,
];

/** DNS 响应码 */
const RCODE = { 0: 'NOERROR', 2: 'SERVFAIL', 3: 'NXDOMAIN' };

/** 并发数：DoH 是普通 HTTPS，别打太猛被限流 */
const CONCURRENCY = 12;
/** 单个域名的重试次数（限流时返回非 JSON，需要退避重试） */
const RETRIES = 3;

/**
 * 不参与巡检的规则组。
 * `common.json` 放的是局域网 / 私有地址 / 路由器管理页这类**根本不存在于公网 DNS 的域名**
 * （`localhost`、`lan`、`local`、`router.asus.com`、`wifi.cmcc`、`zte.home` …），
 * 拿公网 DoH 去查它们必定 NXDOMAIN，属于必然误报，必须排除。
 */
const SKIP_RULE_IDS = new Set(['common']);

/** 特殊用途域名（RFC 6761 / 6762 ，以及各种路由器默认域名），同样不该查公网 */
const SPECIAL_USE =
	/(^|\.)(local|localhost|internal|lan|home|home\.arpa|in-addr\.arpa|test|invalid|example|onion)$/;

/** 收集规则文件里的域名，并记下它出现在哪些分组 */
function collectDomains() {
	const hosts = new Map();
	for (const f of fs
		.readdirSync(RULES_DIR)
		.filter(f => f.endsWith('.json'))
		.sort()) {
		const j = JSON.parse(fs.readFileSync(path.join(RULES_DIR, f), 'utf8'));
		if (SKIP_RULE_IDS.has(j.id)) continue;
		for (const rule of j.rules) {
			const m = rule.match(/^DOMAIN(?:-SUFFIX)?,([^,]+)$/);
			if (!m) continue; // DOMAIN-KEYWORD / IP-CIDR 不是域名，跳过
			if (SPECIAL_USE.test(m[1])) continue;
			if (!hosts.has(m[1])) hosts.set(m[1], new Set());
			hosts.get(m[1]).add(j.id);
		}
	}
	return hosts;
}

/** 查一个域名的 A 记录，限流时退避重试 */
async function resolveA(host, endpoint) {
	for (let i = 1; i <= RETRIES; i++) {
		try {
			const res = await fetch(endpoint(host), {
				headers: { accept: 'application/dns-json' },
				signal: AbortSignal.timeout(10000),
			});
			const json = await res.json();
			return {
				status: RCODE[json.Status] ?? String(json.Status),
				ips: (json.Answer ?? []).filter(a => a.type === 1).map(a => a.data),
			};
		} catch {
			if (i < RETRIES) await new Promise(r => setTimeout(r, 800 * i));
		}
	}
	return null;
}

/**
 * 双源复核：两个 DoH 都查，取结论更「严重」的那个。
 * 单源可能因为限流 / 上游缓存给出假 NXDOMAIN，必须两个都认同才算数。
 */
async function check(host) {
	const results = [];
	for (const ep of DOH_ENDPOINTS) {
		const r = await resolveA(host, ep);
		if (!r) return { host, verdict: 'UNKNOWN', detail: 'DoH 查询失败' };
		results.push(r);
	}

	const withA = results.find(r => r.ips.length > 0);
	if (withA) return { host, verdict: 'LIVE', detail: withA.ips.join(',') };

	const allError = results.every(r => r.status === RCODE[0]);
	if (allError) return { host, verdict: 'NO-A', detail: 'NOERROR 但无 A 记录' };

	const neverExists = results.every(r => r.status === RCODE[3]);
	if (neverExists) return { host, verdict: 'NXDOMAIN', detail: '域名不存在' };

	return {
		host,
		verdict: 'UNKNOWN',
		detail: results.map(r => r.status).join(' / '),
	};
}

async function main() {
	const args = process.argv.slice(2);
	const jsonOnly = args.includes('--json');
	const only = args.filter(a => !a.startsWith('--'));

	const hosts = collectDomains();
	const targets = only.length ? only : [...hosts.keys()];
	const unknown = only.filter(h => !hosts.has(h));
	if (unknown.length) {
		console.error(`⚠️  这些域名不在规则文件里：${unknown.join(', ')}\n`);
	}
	if (!jsonOnly) console.log(`开始查询 ${targets.length} 个域名（DoH 双源）…\n`);

	const report = [];
	let cursor = 0;
	async function worker() {
		while (cursor < targets.length) report.push(await check(targets[cursor++]));
	}
	await Promise.all(Array.from({ length: CONCURRENCY }, worker));

	report.sort((a, b) => a.host.localeCompare(b.host));
	for (const r of report) r.groups = [...(hosts.get(r.host) ?? [])];
	const by = v => report.filter(r => r.verdict === v);
	const [dead, unknownRows, noA, live] = ['NXDOMAIN', 'UNKNOWN', 'NO-A', 'LIVE'].map(by);

	if (jsonOnly) {
		console.log(JSON.stringify(report, null, '\t'));
		process.exitCode = dead.length ? 1 : 0;
		return;
	}

	console.log(
		`LIVE ${live.length} | NO-A ${noA.length} | NXDOMAIN ${dead.length} | UNKNOWN ${unknownRows.length}\n`,
	);

	if (dead.length) {
		console.log(`=== NXDOMAIN（${dead.length}）—— 域名已不存在，可以删 ===`);
		for (const r of dead) console.log(`  ${r.host.padEnd(48)} ${r.groups.join(',')}`);
		console.log('');
	}
	if (unknownRows.length) {
		console.log(`=== UNKNOWN（${unknownRows.length}）—— 查询失败，重跑再看，别删 ===`);
		for (const r of unknownRows) console.log(`  ${r.host.padEnd(48)} ${r.detail}`);
		console.log('');
	}
	if (noA.length) {
		console.log(`=== NO-A（${noA.length}）—— apex 无 A 记录，但这不代表域名死了 ===`);
		console.log('只收子域的命名空间（microsoftonline.com / trafficmanager.net …）也在这里，');
		console.log('必须逐个按域名语义判断，不要照单删除。');
		for (const r of noA) console.log(`  ${r.host}`);
		console.log('');
	}

	if (dead.length) {
		console.log(`❌ 发现 ${dead.length} 条指向已不存在域名的规则，建议清理。`);
		process.exitCode = 1;
	} else {
		console.log('✅ 没有指向已不存在域名的规则。');
	}
}

main().catch(e => {
	console.error(e);
	process.exitCode = 1;
});

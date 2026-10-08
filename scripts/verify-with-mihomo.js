/**
 * 用真实 mihomo 内核校验生成的配置能否加载
 *
 * 为什么需要它
 * ------------
 * 单元级的检查（悬空引用、字段完整性）覆盖不了内核的**语义约束**：
 *   - 分组循环引用        mihomo: loop is detected in ProxyGroup
 *   - 规则指向已关闭分组  mihomo: proxy [xxx] not found
 * 这两类问题会让内核**拒绝加载整份配置**，用户看到的是「订阅完全不可用」，
 * 而从 YAML 上看不出任何异常。只有真正交给内核才算验证过。
 *
 * 用法
 * ----
 *   1. 把 mihomo 可执行文件放到 tools/ 下（任意文件名，脚本自动识别 .exe）
 *      Windows: https://github.com/MetaCubeX/mihomo/releases 下载
 *              mihomo-windows-amd64-compatible-*.zip 解压到 tools/
 *   2. node scripts/verify-with-mihomo.js
 *
 * 退出码：全部通过 0，有失败 1（可直接用于 CI）。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');

const { parseSubscription } = require('../src/parser');
const { convertToClash } = require('../src/converter');

const ROOT = path.join(__dirname, '..');
const TOOLS = path.join(ROOT, 'tools');
const CASES = path.join(TOOLS, 'verify-cases');
const WORK = path.join(TOOLS, 'verify-work');

/** 全部可配置规则组 id（用于「全部关闭」这类极端用例） */
const ALL_RULE_IDS = [
	'apple',
	'bahamut',
	'bilibili',
	'claude',
	'dazn',
	'disney',
	'gemini',
	'github',
	'microsoft',
	'mihoyo',
	'netflix',
	'openai',
	'pixiv',
	'steam-download',
	'steam-store',
	'telegram',
	'youtube',
];

/** 找到 tools/ 下的 mihomo 可执行文件 */
function findMihomo() {
	if (!fs.existsSync(TOOLS)) return null;
	const exe = fs
		.readdirSync(TOOLS)
		.filter(f => /\.exe$/i.test(f) || /^mihomo$/i.test(f))
		.map(f => path.join(TOOLS, f))
		.find(f => fs.statSync(f).isFile());
	return exe || null;
}

/** 生成全部测试用例 */
function buildCases() {
	const samples = [
		{ file: 'samples/mock-sub.yaml', label: 'mock' },
		{ file: 'samples/订阅.txt', label: 'real' },
	].filter(s => fs.existsSync(path.join(ROOT, s.file)));

	const cases = [];
	for (const { file, label } of samples) {
		const proxies = parseSubscription(fs.readFileSync(path.join(ROOT, file), 'utf8'));
		const off = ALL_RULE_IDS.map(id => ({ ruleId: id, enabled: false }));

		const variants = [
			['默认', undefined],
			['地区组开', [{ builtin: 'regions', enabled: true }]],
			['地区组select', [{ builtin: 'regions', enabled: true, type: 'select' }]],
			['中国大陆关', [{ builtin: 'domestic', enabled: false }]],
			[
				'关部分规则组',
				[
					{ ruleId: 'github', enabled: false },
					{ ruleId: 'netflix', enabled: false },
				],
			],
			['全关规则组', off],
			[
				'全部关',
				[
					{ builtin: 'regions', enabled: false },
					{ builtin: 'domestic', enabled: false },
					...off,
				],
			],
			['空userGroups', []],
		];

		for (const [name, userGroups] of variants) {
			cases.push({
				name: `${label}_${name}`,
				proxies,
				options: userGroups === undefined ? {} : { userGroups },
			});
		}
	}
	return cases;
}

function main() {
	const exe = findMihomo();
	if (!exe) {
		console.error('未找到 mihomo 内核。');
		console.error('请从 https://github.com/MetaCubeX/mihomo/releases 下载');
		console.error('mihomo-windows-amd64-compatible-*.zip 并解压到 tools/ 目录。');
		process.exit(1);
	}

	fs.rmSync(CASES, { recursive: true, force: true });
	fs.mkdirSync(CASES, { recursive: true });
	fs.mkdirSync(WORK, { recursive: true });

	const cases = buildCases();
	if (!cases.length) {
		console.error('未找到 samples/ 下的订阅样例（mock-sub.yaml / 订阅.txt）。');
		process.exit(1);
	}

	let pass = 0;
	const failures = [];

	for (const c of cases) {
		let yamlText;
		try {
			yamlText = convertToClash(c.proxies, {
				nodeFilter: 'all',
				nodeFilters: {},
				excludeKeywords: [],
				...c.options,
			}).yaml;
		} catch (err) {
			failures.push({ name: c.name, reason: `生成失败: ${err.message}` });
			continue;
		}

		const file = path.join(CASES, `${c.name}.yaml`);
		fs.writeFileSync(file, yamlText, 'utf8');

		const doc = yaml.load(yamlText);
		const info = `节点=${doc.proxies.length} 分组=${doc['proxy-groups'].length} 规则=${doc.rules.length}`;

		try {
			execFileSync(exe, ['-t', '-d', WORK, '-f', file], { stdio: 'pipe' });
			pass++;
			console.log(`  ✅ ${c.name.padEnd(28)} ${info}`);
		} catch (err) {
			const output = `${err.stdout || ''}${err.stderr || ''}`;
			// 只挑内核报的 error 行，其余日志噪音没必要展示
			const detail = output
				.split('\n')
				.filter(l => l.includes('level=error'))
				.map(l => l.replace(/^.*level=error msg=/, '').trim())
				.slice(0, 3)
				.join('\n         ');
			failures.push({ name: c.name, reason: detail || '未知错误' });
			console.log(`  ❌ ${c.name.padEnd(28)} ${info}`);
			if (detail) console.log(`         ${detail}`);
		}
	}

	console.log('');
	if (failures.length) {
		console.error(`内核校验：${pass} 通过 / ${failures.length} 失败`);
		process.exit(1);
	}
	console.log(`内核校验：${pass}/${cases.length} 全部通过`);
}

main();

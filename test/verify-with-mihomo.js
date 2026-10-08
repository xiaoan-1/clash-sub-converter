/**
 * 用真实 mihomo 内核校验生成的配置能否加载
 *
 * 这是本项目的端到端测试：不测单个函数，而是把生成结果交给真实内核，
 * 看它愿不愿意加载。`npm test` 会跑到它。
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
 *   npm test                 （推荐）
 *   node test/verify-with-mihomo.js
 *
 * tools/ 下没有内核时会**自动下载**（按当前平台/架构选对应产物并解压），
 * 无需手动准备。可用环境变量覆盖：
 *   MIHOMO_VERSION=v1.19.32     指定版本（默认取 latest）
 *   MIHOMO_FORCE_DOWNLOAD=1     强制重新下载
 *   GITHUB_TOKEN=xxx            带上令牌，避免匿名调用 GitHub API 的限流
 *
 * 退出码：全部通过 0，有失败 1（可直接用于 CI）。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');

const { parseSubscription } = require('../src/parser');
const { convertToClash } = require('../src/converter');

const ROOT = path.join(__dirname, '..');
const TOOLS = path.join(ROOT, 'tools');
const CASES = path.join(TOOLS, 'verify-cases');
const WORK = path.join(TOOLS, 'verify-work');

/** mihomo release 的查询接口（可用 MIHOMO_VERSION 指定 tag） */
const RELEASE_API = 'https://api.github.com/repos/MetaCubeX/mihomo/releases';
/** 下载超时：内核约 23MB，给足时间 */
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

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
	// 优先脚本自己下载的固定名（tools/mihomo.exe 或 tools/mihomo）
	for (const name of ['mihomo.exe', 'mihomo']) {
		const p = path.join(TOOLS, name);
		if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
	}
	// 兼容手工放置（保留原文件名，如 mihomo-windows-amd64-compatible.exe）。
	// 必须排除压缩包 —— mihomo.zip / mihomo-...-v1.19.32.zip 同样以 mihomo 开头，
	// 被误当成内核会让 execFileSync 报 ENOEXEC 而不是去下载。
	const exe = fs
		.readdirSync(TOOLS)
		.filter(f => !/\.(zip|gz|tar|tgz|7z)$/i.test(f))
		.filter(f => /\.exe$/i.test(f) || /^mihomo/i.test(f))
		.map(f => path.join(TOOLS, f))
		.find(f => {
			try {
				return fs.statSync(f).isFile();
			} catch {
				return false;
			}
		});
	return exe || null;
}

/**
 * 当前平台对应的 mihomo 产物信息。
 *
 * amd64 一律选 `-compatible` 变体：它是为不支持新指令集的老 CPU 编译的，
 * 在支持新指令集的机器上同样能跑，兼容性最好（校验配置用不到那点性能差异）。
 */
function platformTag() {
	const osName = { win32: 'windows', linux: 'linux', darwin: 'darwin' }[process.platform];
	if (!osName) return null;
	const arch = { x64: 'amd64', arm64: 'arm64', arm: 'armv7' }[process.arch];
	if (!arch) return null;
	return {
		os: osName,
		arch,
		// 只有 amd64 提供 -compatible 变体
		compatible: arch === 'amd64' ? '-compatible' : '',
		ext: process.platform === 'win32' ? 'zip' : 'gz',
	};
}

/** 从 release 资产里挑出与当前平台匹配的那一个 */
function pickAsset(assets, tag) {
	// 形如 mihomo-windows-amd64-compatible-v1.19.32.zip
	// 用严格正则排除 mihomo-windows-amd64-v1-go120-v1.19.32.zip 这类带 go 版本的变体
	const re = new RegExp(`^mihomo-${tag.os}-${tag.arch}${tag.compatible}-v[0-9.]+\.[a-z]+$`);
	return assets.find(a => re.test(a.name) && a.name.endsWith(`.${tag.ext}`)) || null;
}

/**
 * 纯 JS 解 ZIP，取出第一个文件。
 *
 * 只为了拿一个可执行文件而引入解压依赖（或依赖系统工具）不划算，
 * 这里直接按 ZIP 结构解析：定位 EOCD → 遍历中央目录 → 读本地头取数据。
 * 只需支持存储（method 0）与 deflate（method 8）两种，mihomo 的产物就是后者。
 */
function extractFirstBinary(zip) {
	// 从尾部向前找 EOCD（0x06054b50），注释区最多 64KB
	let eocd = -1;
	const minPos = Math.max(0, zip.length - 22 - 65535);
	for (let i = zip.length - 22; i >= minPos; i--) {
		if (zip.readUInt32LE(i) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new Error('不是有效的 ZIP（未找到 EOCD）');

	const count = zip.readUInt16LE(eocd + 10);
	let offset = zip.readUInt32LE(eocd + 16);

	for (let i = 0; i < count; i++) {
		if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error('ZIP 中央目录损坏');
		const method = zip.readUInt16LE(offset + 10);
		const compSize = zip.readUInt32LE(offset + 20);
		const nameLen = zip.readUInt16LE(offset + 28);
		const extraLen = zip.readUInt16LE(offset + 30);
		const commentLen = zip.readUInt16LE(offset + 32);
		const localOffset = zip.readUInt32LE(offset + 42);
		const name = zip.toString('utf8', offset + 46, offset + 46 + nameLen);

		if (!name.endsWith('/')) {
			if (zip.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('ZIP 本地文件头损坏');
			// 本地头里的文件名/扩展区长度可能与中央目录不同，必须读本地头
			const lNameLen = zip.readUInt16LE(localOffset + 26);
			const lExtraLen = zip.readUInt16LE(localOffset + 28);
			const start = localOffset + 30 + lNameLen + lExtraLen;
			const raw = zip.subarray(start, start + compSize);
			return method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw);
		}
		offset += 46 + nameLen + extraLen + commentLen;
	}
	throw new Error('ZIP 里没有文件');
}

/** 流式下载并打印进度 */
async function download(url, dest) {
	const res = await fetch(url, {
		redirect: 'follow',
		signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
		headers: { 'User-Agent': 'clash-sub-converter-verify' },
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

	const total = Number(res.headers.get('content-length')) || 0;
	const chunks = [];
	let received = 0;
	let lastTick = 0;

	for await (const chunk of Readable.fromWeb(res.body)) {
		chunks.push(chunk);
		received += chunk.length;
		// 每 300ms 刷新一次，避免刷屏
		if (Date.now() - lastTick > 300) {
			lastTick = Date.now();
			const pct = total ? ` ${((received / total) * 100).toFixed(0)}%` : '';
			process.stdout.write(`\r  下载 ${(received / 1048576).toFixed(1)}MB${pct}   `);
		}
	}
	if (received) process.stdout.write('\r');

	const buf = Buffer.concat(chunks);
	fs.writeFileSync(dest, buf);
	return buf;
}

/**
 * 内核能否正常执行（`-v` 打印版本）。
 * 用来识别「文件在但已损坏」——下载被中断、手动放错文件、
 * 或把 mihomo.zip 解压出的非可执行文件重命名过来，都会出现这种情况。
 */
function isRunnable(exe) {
	try {
		const out = execFileSync(exe, ['-v'], { stdio: 'pipe', timeout: 15000 });
		return /mihomo/i.test(String(out));
	} catch {
		return false;
	}
}

/**
 * 确保 tools/ 下有可用内核，没有（或已损坏）则自动下载。
 *
 * 支持的环境变量：
 *   MIHOMO_VERSION        指定 tag（如 v1.19.32），默认取 latest
 *   MIHOMO_FORCE_DOWNLOAD 设 1 强制重新下载
 *   GITHUB_TOKEN          有则带上，避免匿名调用 GitHub API 的限流
 */
async function ensureMihomo() {
	const force = String(process.env.MIHOMO_FORCE_DOWNLOAD || '') === '1';
	const existing = findMihomo();
	if (existing && !force) {
		if (isRunnable(existing)) return existing;
		// 文件在但跑不起来：重下，而不是直接报 ENOEXEC 让用户困惑
		console.warn(`已存在的内核无法执行（${existing}），将重新下载。`);
		fs.rmSync(existing, { force: true });
	}

	const tag = platformTag();
	if (!tag) throw new Error(`不支持的平台：${process.platform}/${process.arch}`);

	const version = String(process.env.MIHOMO_VERSION || '').trim();
	const apiUrl = version ? `${RELEASE_API}/tags/${version}` : `${RELEASE_API}/latest`;
	console.log(`tools/ 下没有可用内核，开始自动下载（${process.platform}/${process.arch}）…`);

	const headers = { 'User-Agent': 'clash-sub-converter-verify' };
	if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
	const res = await fetch(apiUrl, { headers, signal: AbortSignal.timeout(30000) });
	if (!res.ok) {
		const extra =
			res.status === 403 || res.status === 429
				? '（可能触发了 GitHub API 限流，可设 GITHUB_TOKEN）'
				: '';
		throw new Error(`查询 mihomo 版本失败：HTTP ${res.status}${extra}`);
	}

	const release = await res.json();
	const asset = pickAsset(release.assets || [], tag);
	if (!asset) {
		throw new Error(`release ${release.tag_name} 里没有匹配当前平台的产物`);
	}

	console.log(
		`  版本 ${release.tag_name} · ${asset.name}（${(asset.size / 1048576).toFixed(1)}MB）`,
	);
	fs.mkdirSync(TOOLS, { recursive: true });
	const raw = await download(asset.browser_download_url, path.join(TOOLS, asset.name));

	const exePath = path.join(TOOLS, process.platform === 'win32' ? 'mihomo.exe' : 'mihomo');
	if (tag.ext === 'zip') {
		fs.writeFileSync(exePath, extractFirstBinary(raw));
	} else {
		fs.writeFileSync(exePath, zlib.gunzipSync(raw));
	}
	// 压缩包用完即删，避免 tools/ 里堆大文件
	fs.rmSync(path.join(TOOLS, asset.name), { force: true });
	if (process.platform !== 'win32') fs.chmodSync(exePath, 0o755);

	if (!isRunnable(exePath)) {
		fs.rmSync(exePath, { force: true });
		throw new Error('下载的内核无法执行，可能是不完整或平台不匹配的产物');
	}
	console.log(`  已就绪 ${exePath}`);
	return exePath;
}

/**
 * 生成全部测试用例。
 *
 * 样例来源：
 *   samples/mock-sub.yaml  随仓库提交，覆盖全部协议与地区边界（必需）
 *   samples/订阅.txt       本地真实订阅，不入库（可选，有就用真实数据再跑一轮）
 */
function buildCases() {
	const REQUIRED = 'samples/mock-sub.yaml';
	if (!fs.existsSync(path.join(ROOT, REQUIRED))) {
		throw new Error(`缺少测试样例 ${REQUIRED}（应随仓库提交，请检查是否被误删）`);
	}

	const samples = [
		{ file: REQUIRED, label: 'mock' },
		{ file: 'samples/订阅.txt', label: 'real' },
	].filter(s => fs.existsSync(path.join(ROOT, s.file)));

	const cases = [];
	for (const { file, label } of samples) {
		const content = fs.readFileSync(path.join(ROOT, file), 'utf8');
		const proxies = parseSubscription(content);
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

async function main() {
	let exe;
	try {
		exe = await ensureMihomo();
	} catch (err) {
		console.error(`准备 mihomo 内核失败：${err.message}`);
		console.error('也可手动下载 https://github.com/MetaCubeX/mihomo/releases');
		console.error('解压后把可执行文件放到 tools/ 目录（文件名任意）。');
		// 用 exitCode 而非 process.exit()：后者不等 stdout/stderr 刷新，
		// 管道下会截断输出，且在有未完成的 fetch/IO 时触发 libuv 断言。
		process.exitCode = 1;
		return;
	}

	fs.rmSync(CASES, { recursive: true, force: true });
	fs.mkdirSync(CASES, { recursive: true });
	fs.mkdirSync(WORK, { recursive: true });

	// buildCases 在缺样例时抛错，由外层 catch 统一处理
	const cases = buildCases();

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
		process.exitCode = 1;
		return;
	}
	console.log(`内核校验：${pass}/${cases.length} 全部通过`);
}

main().catch(err => {
	console.error(`校验过程出错：${err.message}`);
	process.exitCode = 1;
});

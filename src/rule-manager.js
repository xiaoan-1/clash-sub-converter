/**
 * 规则管理器
 * 从 config/rules/*.json 读取规则配置，提供 CRUD 和规则生成功能
 * 每个 JSON 文件 = 一个分组 + 它的规则（1:1 关系）
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const log = logger.create('rules');

const RULES_DIR = path.join(__dirname, '..', 'config', 'rules');

/**
 * 始终启用的规则分组 id。
 * 它的 target 是 DIRECT，不面向用户选择，因此：
 *   - 不参与 flag / include-exclude 过滤（generateRules）
 *   - 不生成 Clash 分组（proxy-groups）
 *   - 不出现在可选分组列表里（utils.ruleGroupKeys）
 * 这三处判定必须一致，所以共用一个常量而不是各自硬编码字符串。
 */
const ALWAYS_ON_RULE_ID = 'common';

/**
 * 规则尾部的修饰段（不是出口）。这些段出现在 target 之后，
 * 识别 target 时必须跳过 —— 否则 `IP-CIDR,10.0.0.0/8,DIRECT,no-resolve`
 * 的「target」会被当成 no-resolve。
 */
const RULE_MODIFIERS = new Set(['no-resolve', 'src']);

/**
 * 取规则里显式写出的出口（target）。
 *
 * 规则格式为 `TYPE,VALUE[,TARGET][,MODIFIERS]`，所以：
 *   - 少于 3 段 → 没有 target（如 `IP-CIDR,10.0.0.0/8`）
 *   - 跳过尾部修饰段后，最后一段才是 target
 *   - MATCH / FINAL 只有两段，第二段就是 target
 *
 * 仅靠「末段」判断会把 `IP-CIDR,1.2.3.4/32,no-resolve` 误判成「已带 target」
 * 而丢掉出口，mihomo 会拒绝加载整份配置。
 *
 * @param {string} rule
 * @returns {string} 不含 target 时返回空串
 */
function ruleTargetOf(rule) {
	const parts = String(rule)
		.split(',')
		.map(p => p.trim());
	if (!parts.length) return '';
	if (/^(MATCH|FINAL)$/i.test(parts[0])) return parts[1] || '';

	let end = parts.length - 1;
	while (end >= 2 && RULE_MODIFIERS.has(parts[end])) end--;
	return end >= 2 ? parts[end] : '';
}

class RuleManager {
	constructor() {
		this.rules = new Map(); // id -> ruleConfig
		this.loadAll();
	}

	/**
	 * 从磁盘加载所有规则文件
	 */
	loadAll() {
		this.rules.clear();
		if (!fs.existsSync(RULES_DIR)) {
			fs.mkdirSync(RULES_DIR, { recursive: true });
			log.warn('规则目录不存在，已自动创建（此时无任何分流规则）', { dir: RULES_DIR });
			return;
		}

		// 排序：规则是 first-match，顺序直接决定分流结果。
		// readdir 的顺序由文件系统决定，不同机器 / 不同 Node 版本可能不同，
		// 不排序会让同一份配置在不同机器上产生不同的分流行为，且无法复现。
		const files = fs
			.readdirSync(RULES_DIR)
			.filter(f => f.endsWith('.json'))
			.sort();
		const failed = [];
		for (const file of files) {
			try {
				const data = JSON.parse(fs.readFileSync(path.join(RULES_DIR, file), 'utf-8'));
				if (data.id && data.name && Array.isArray(data.rules)) {
					this.rules.set(data.id, data);
				} else {
					failed.push(`${file}（缺少 id / name / rules 字段）`);
				}
			} catch (err) {
				failed.push(`${file}（${err.message}）`);
			}
		}

		if (failed.length) {
			log.warn('部分规则文件未能加载', { failed });
		}
		log.info('分流规则加载完成', {
			dir: RULES_DIR,
			files: files.length,
			loaded: this.rules.size,
			ids: [...this.rules.keys()],
		});
	}

	/**
	 * 获取所有规则配置
	 */
	getAll() {
		return [...this.rules.values()];
	}

	/**
	 * 根据 ID 获取规则配置
	 */
	getById(id) {
		return this.rules.get(id) || null;
	}

	/**
	 * 生成 Clash 分流规则
	 * @param {Object} options - { telegram: true, openai: false, customRules: [...] }
	 *   key 即规则 ID（对应 config/rules/*.json 文件名），value 为 true/undefined 表示启用
	 *   ALWAYS_ON_RULE_ID('common') 始终启用
	 * @returns {string[]} 规则数组，如 ['DOMAIN-SUFFIX,t.me,💬 Telegram', ...]
	 */
	generateRules(options = {}) {
		const { customRules = [], ...flags } = options;

		// 没有任何 flag 时默认全部启用；有 flag 时按 flag 过滤
		const hasFlags = Object.keys(flags).length > 0;

		// 已知的分组名（target）集合：用于判断规则是否已自带 target。
		// 不能靠「逗号段数 >= 3」判断 —— IP-CIDR,1.2.3.4/32,no-resolve 是 3 段但没有 target，
		// 那样会被误判为已带 target 而丢掉出口，mihomo 会拒绝加载整份配置。
		const knownTargets = new Set([
			'DIRECT',
			'REJECT',
			'PASS',
			'GLOBAL',
			...this.getAll().map(r => r.target || r.name),
		]);

		const rules = [];
		const enabledIds = [];
		const disabledIds = [];

		for (const ruleConfig of this.rules.values()) {
			const { id, target: ruleTarget, name, rules: patterns } = ruleConfig;

			// common 始终启用，其他按 flag 决定
			if (id !== ALWAYS_ON_RULE_ID && hasFlags && !flags[id]) {
				disabledIds.push(id);
				continue;
			}
			enabledIds.push(id);

			const target = ruleTarget || name;
			for (const rule of patterns) {
				// 仅当「已带 target」时才不补出口；判定见 ruleTargetOf 的说明。
				const explicit = ruleTargetOf(rule);
				rules.push(knownTargets.has(explicit) ? rule : `${rule},${target}`);
			}
		}

		// GEOIP 国内直连 + 自定义规则 + 兜底
		rules.push(`GEOIP,CN,DIRECT`);
		rules.push(...customRules, 'MATCH,🐟 漏网之鱼');

		log.debug('规则生成', {
			hasFlags,
			groups: enabledIds.length,
			disabled: disabledIds.length ? disabledIds : undefined,
			custom: customRules.length,
			rules: rules.length,
		});

		return rules;
	}
}

// 规则是「基准配置」：新增 / 修改 / 删除一律直接编辑 config/rules/*.json，
// 服务重启后由 loadAll() 重新加载。此处不提供写方法 —— 曾经有过 add / update /
// remove 与配套的 /api/rules 接口，但规则属部署决策（改文件即生效、可纳入版本控制），
// 走 HTTP 写入既无必要也绕过了 git；接口移除后这些方法成了死代码，一并删掉。
const ruleManager = new RuleManager();

module.exports = { ruleManager, ALWAYS_ON_RULE_ID, ruleTargetOf, RULE_MODIFIERS };

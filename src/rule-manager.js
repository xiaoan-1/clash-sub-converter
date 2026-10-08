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

		const files = fs.readdirSync(RULES_DIR).filter(f => f.endsWith('.json'));
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
				// 仅当末段是已知 target 时才认为已自带出口；否则补上本分组的 target
				const last = rule.slice(rule.lastIndexOf(',') + 1).trim();
				rules.push(knownTargets.has(last) ? rule : `${rule},${target}`);
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

module.exports = { ruleManager, ALWAYS_ON_RULE_ID };

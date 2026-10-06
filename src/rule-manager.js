/**
 * 规则管理器
 * 从 config/rules/*.json 读取规则配置，提供 CRUD 和规则生成功能
 * 每个 JSON 文件 = 一个分组 + 它的规则（1:1 关系）
 */

const fs = require('fs');
const path = require('path');

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
      return;
    }

    const files = fs.readdirSync(RULES_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(RULES_DIR, file), 'utf-8'));
        if (data.id && data.name && Array.isArray(data.rules)) {
          this.rules.set(data.id, data);
        }
      } catch (err) {
        console.warn(`[RuleManager] 加载 ${file} 失败: ${err.message}`);
      }
    }
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

    const rules = [];

    for (const ruleConfig of this.rules.values()) {
      const { id, target: ruleTarget, name, rules: patterns } = ruleConfig;

      // common 始终启用，其他按 flag 决定
      if (id !== ALWAYS_ON_RULE_ID && hasFlags && !flags[id]) continue;

      const target = ruleTarget || name;
      for (const rule of patterns) {
        rules.push(rule.split(',').length >= 3 ? rule : `${rule},${target}`);
      }
    }

    // GEOIP 国内直连 + 自定义规则 + 兜底
    rules.push(`GEOIP,CN,DIRECT`);
    rules.push(...customRules, 'MATCH,🐟 漏网之鱼');

    return rules;
  }

  /**
   * 添加规则配置
   */
  add(config) {
    if (!config.id || !config.name || !Array.isArray(config.rules)) {
      throw new Error('无效的规则配置：需要 id, name, rules');
    }
    if (this.rules.has(config.id)) {
      throw new Error(`规则 ${config.id} 已存在`);
    }
    this.rules.set(config.id, config);
    this._save(config.id);
    return config;
  }

  /**
   * 更新规则配置
   */
  update(id, data) {
    const existing = this.rules.get(id);
    if (!existing) throw new Error(`规则 ${id} 不存在`);

    const updated = { ...existing, ...data, id }; // id 不可变
    this.rules.set(id, updated);
    this._save(id);
    return updated;
  }

  /**
   * 删除规则配置
   */
  remove(id) {
    if (!this.rules.has(id)) throw new Error(`规则 ${id} 不存在`);
    this.rules.delete(id);
    const filePath = path.join(RULES_DIR, `${id}.json`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  /**
   * 保存单个规则到磁盘
   */
  _save(id) {
    const config = this.rules.get(id);
    if (!fs.existsSync(RULES_DIR)) fs.mkdirSync(RULES_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(RULES_DIR, `${id}.json`),
      JSON.stringify(config, null, 2),
      'utf-8'
    );
  }
}

// 单例
const ruleManager = new RuleManager();

module.exports = { RuleManager, ruleManager, ALWAYS_ON_RULE_ID };

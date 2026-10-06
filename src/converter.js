const yaml = require('js-yaml');
const { generateProxyGroups, isDomestic, normalizeExcludeKeywords, filterByExcludeKeywords } = require('./proxy-groups');
const { ruleManager } = require('./rule-manager');
const { readConfig } = require('./user-config');

/**
 * 全部节点都被过滤规则排除时抛出。
 * 这是用户的过滤配置问题而非服务端故障，上层应据此返回 400 并给出可操作提示。
 */
class AllProxiesFilteredError extends Error {
  constructor(totalNodes, hint) {
    super(`全部 ${totalNodes} 个节点都被过滤条件排除，无法生成可用配置`);
    this.name = 'AllProxiesFilteredError';
    this.code = 'ALL_PROXIES_FILTERED';
    this.totalNodes = totalNodes;
    this.hint = hint || '请放宽「排除关键词」或「节点过滤」，或检查是否误填了会命中全部节点的关键词';
  }
}

/**
 * 将解析后的代理节点转换为完整的 Clash YAML 配置
 * @param {Array} proxies - 代理节点数组
 * @param {Object} options - 配置选项
 * @returns {string} YAML 格式的配置字符串
 */
function convertToClash(proxies, options = {}) {
  const {
    name = 'Clash 订阅',
    // 基础配置
    mixedPort = 7890,
    allowLan = true,
    mode = 'rule',
    logLevel = 'info',
    externalController = '127.0.0.1:46011',
    secret = '',
    // DNS 配置：默认不注入，交由客户端默认行为（与直接导入等价）
    // 仅当源订阅自带 DNS 时，由调用方传入该 dns 并原样透传
    dns = null,
    // 分组和规则选项
    proxyGroupOptions = {},
    ruleOptions = {},
    // 是否包含默认规则
    includeDefaultRules = true
  } = options;

  // 读取用户配置（options 优先级高于文件配置）
  const userConfig = readConfig();
  const userGroups = options.userGroups || userConfig?.groups || [];
  const nodeFilters = options.nodeFilters || userConfig?.nodeFilters || {};
  const excludeKeywords = options.excludeKeywords || userConfig?.excludeKeywords || [];

  // 0. 关键词排除（空串会命中所有节点，由 filterByExcludeKeywords 内部剔除）
  const afterKeywords = filterByExcludeKeywords(proxies, excludeKeywords);
  let activeProxies = afterKeywords;

  // 0.5 国内/国际过滤
  const { hideDomestic = false, hideInternational = false } = nodeFilters;
  if (hideDomestic && !hideInternational) {
    activeProxies = activeProxies.filter(p => !isDomestic(p.name));
  } else if (hideInternational && !hideDomestic) {
    activeProxies = activeProxies.filter(p => isDomestic(p.name));
  }
  // 两个同时开启 → 不处理（回退为不过滤）

  // 节点被过滤干净时立即失败：否则会产出一份「没有真实节点」的空壳配置，
  // mihomo 能加载但一个节点都用不了，用户只会看到节点凭空消失而无从排查。
  if (proxies.length > 0 && activeProxies.length === 0) {
    const reasons = [];
    // 只列出「真的减少了节点」的条件：默认配置带了一批关键词与开关，
    // 把没起作用的也写进提示会把用户的排查方向带偏。
    if (afterKeywords.length < proxies.length) {
      const hitKeywords = normalizeExcludeKeywords(excludeKeywords).filter(kw =>
        proxies.some(p => String(p.name || '').toUpperCase().includes(kw)));
      if (hitKeywords.length) reasons.push(`排除关键词「${hitKeywords.join('、')}」`);
    }
    if (afterKeywords.length > 0) {
      if (hideDomestic && !hideInternational) reasons.push('隐藏国内节点');
      if (hideInternational && !hideDomestic) reasons.push('隐藏国际节点');
    }
    throw new AllProxiesFilteredError(
      proxies.length,
      reasons.length ? `当前过滤条件（${reasons.join(' + ')}）排除了全部节点` : null
    );
  }

  // 生成代理分组（传入用户配置以覆盖默认分组）
  const proxyGroups = generateProxyGroups(activeProxies, { ...proxyGroupOptions, userGroups, nodeFilters, excludeKeywords });

  // 生成规则
  const rules = includeDefaultRules ? ruleManager.generateRules(ruleOptions) : (ruleOptions.customRules || ['MATCH,🐟 漏网之鱼']);

  // 构建完整的配置对象
  const config = {
    'mixed-port': mixedPort,
    'allow-lan': allowLan,
    'bind-address': '*',
    mode,
    'log-level': logLevel,
    'external-controller': externalController
  };

  if (secret) {
    config.secret = secret;
  }

  // DNS 配置
  if (dns) {
    config.dns = dns;
  }

  // 代理节点
  config.proxies = activeProxies;

  // 代理分组
  config['proxy-groups'] = proxyGroups;

  // 规则
  config.rules = rules;

  // 转换为 YAML
  const yamlStr = yaml.dump(config, {
    lineWidth: -1,
    noRefs: true,
    sortKeys: false,
    quotingType: "'",
    forceQuotes: false
  });

  // 构建结构化摘要（供前端展示）
  const groupList = proxyGroups.map(g => ({
    name: g.name,
    type: g.type,
    proxies: g.proxies || [],
    defaultProxy: g.defaultProxy || (g.proxies && g.proxies[0]) || null
  }));

  // 追加系统规则展示（不可配置）
  groupList.push({
    name: '🏠 本地路由',
    type: 'system',
    proxies: ['DIRECT'],
    defaultProxy: 'DIRECT'
  });
  groupList.push({
    name: '🌐 GEOIP 国内直连',
    type: 'system',
    proxies: ['DIRECT'],
    defaultProxy: 'DIRECT'
  });

  const summary = {
    totalNodes: proxies.length,
    filteredNodes: activeProxies.length,
    groups: groupList
  };

  return { yaml: yamlStr, summary };
}

/**
 * 将配置转换为 Surge 格式（简化版）
 */
function convertToSurge(proxies, options = {}) {
  const lines = [];
  lines.push('#!name = ' + (options.name || 'Clash 订阅'));
  lines.push('');
  lines.push('[General]');
  lines.push('loglevel = notify');
  lines.push('skip-proxy = 127.0.0.1, 192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12, 100.64.0.0/10, localhost, *.local');
  lines.push('dns-server = 223.5.5.5, 119.29.29.29');
  lines.push('');

  lines.push('[Proxy]');
  for (const proxy of proxies) {
    let line;
    switch (proxy.type) {
      case 'vmess':
        line = `${proxy.name} = vmess, ${proxy.server}, ${proxy.port}, username=${proxy.uuid}`;
        if (proxy.tls) line += ', tls=true';
        if (proxy.sni) line += ', sni=' + proxy.sni;
        break;
      case 'vless':
        line = `${proxy.name} = vless, ${proxy.server}, ${proxy.port}, username=${proxy.uuid}`;
        if (proxy.tls) line += ', tls=true';
        // VLESS 内部用 servername（mihomo 字段名），Surge 用 sni
        if (proxy.servername || proxy.sni) line += ', sni=' + (proxy.servername || proxy.sni);
        break;
      case 'ss':
        line = `${proxy.name} = custom, ${proxy.server}, ${proxy.port}, ${proxy.cipher}, ${proxy.password}, https://github.com/crossutility/Quantumult-X/raw/master/Server-Churn-US.snippet`;
        break;
      case 'trojan':
        line = `${proxy.name} = trojan, ${proxy.server}, ${proxy.port}, password=${proxy.password}`;
        if (proxy.sni) line += ', sni=' + proxy.sni;
        break;
      case 'hysteria2':
        line = `${proxy.name} = hysteria2, ${proxy.server}, ${proxy.port}, password=${proxy.password || proxy.auth || ''}`;
        if (proxy.sni) line += ', sni=' + proxy.sni;
        if (proxy['skip-cert-verify']) line += ', skip-cert-verify=true';
        break;
      default:
        // ssr 等 Surge 不支持的协议，静默跳过
        continue;
    }
    if (line) lines.push(line);
  }
  lines.push('');

  lines.push('[Proxy Group]');
  const groups = generateProxyGroups(proxies, options.proxyGroupOptions || {});
  for (const group of groups) {
    const proxyList = group.proxies.join(', ');
    if (group.type === 'select') {
      lines.push(`${group.name} = select, ${proxyList}`);
    } else if (group.type === 'url-test') {
      lines.push(`${group.name} = url-test, ${proxyList}, url=${group.url || 'http://www.gstatic.com/generate_204'}, interval=${group.interval || 300}`);
    }
  }
  lines.push('');

  lines.push('[Rule]');
  const rules = ruleManager.generateRules(options.ruleOptions || {});
  for (const rule of rules) {
    lines.push(rule);
  }

  return lines.join('\n');
}

module.exports = {
  convertToClash,
  convertToSurge,
  AllProxiesFilteredError
};

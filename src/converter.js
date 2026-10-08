const yaml = require('js-yaml');
const { generateProxyGroups, isDomestic, normalizeExcludeKeywords, filterByExcludeKeywords } = require('./proxy-groups');
const { ruleManager } = require('./rule-manager');
const { readConfig } = require('./user-config');
const logger = require('./logger');

const log = logger.create('converter');

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
 * 解析本次转换要用的用户配置。
 * options 显式传入的优先（API 可以按请求覆盖），否则回退到配置文件。
 * Clash 与 Surge 共用，保证两个入口的过滤/分组策略一致。
 *
 * options.guestId 决定读哪一份配置：null/未传 = 站点基准，否则读该访客的配置。
 * 必须由调用方从请求里解析后传进来 —— 转换器本身拿不到 req，
 * 若在这里自己猜，访客就会拿到管理员的分组策略。
 */
function resolveUserConfig(options = {}) {
  const userConfig = readConfig(options.guestId);
  return {
    userGroups: options.userGroups || userConfig?.groups || [],
    nodeFilters: options.nodeFilters || userConfig?.nodeFilters || {},
    excludeKeywords: options.excludeKeywords || userConfig?.excludeKeywords || [],
  };
}

/**
 * 按用户配置过滤节点：先按关键词排除，再按国内/国际开关过滤。
 *
 * 节点被过滤干净时立即抛错：否则会产出一份「没有真实节点」的空壳配置，
 * 客户端能加载但一个节点都用不了，用户只会看到节点凭空消失而无从排查。
 *
 * @param {Array} proxies
 * @param {Object} nodeFilters - { hideDomestic, hideInternational }
 * @param {Array} excludeKeywords
 * @returns {Array} 过滤后的节点
 */
function applyNodeFilters(proxies, nodeFilters = {}, excludeKeywords = []) {
  const { hideDomestic = false, hideInternational = false } = nodeFilters;

  // 0. 关键词排除（空串会命中所有节点，由 filterByExcludeKeywords 内部剔除）
  const afterKeywords = filterByExcludeKeywords(proxies, excludeKeywords);
  let activeProxies = afterKeywords;

  // 0.5 国内/国际过滤（两个同时开启 = 无意义，回退为不过滤）
  if (hideDomestic && !hideInternational) {
    activeProxies = activeProxies.filter(p => !isDomestic(p.name));
  } else if (hideInternational && !hideDomestic) {
    activeProxies = activeProxies.filter(p => isDomestic(p.name));
  }

  // 逐阶段记录数量变化：节点「莫名少了」时，靠这一行就能定位是哪一步吃掉了
  const kwHit = normalizeExcludeKeywords(excludeKeywords).filter(kw =>
    proxies.some(p => String(p.name || '').toUpperCase().includes(kw)));
  log.debug('节点过滤', {
    in: proxies.length,
    afterKeywords: afterKeywords.length,
    hideDomestic,
    hideInternational,
    out: activeProxies.length,
    keywords: excludeKeywords.length,
    hitKeywords: kwHit.length ? kwHit : undefined,
  });

  if (afterKeywords.length !== proxies.length) {
    const kept = new Set(afterKeywords);
    const removed = proxies.filter(p => !kept.has(p));
    log.info('关键词过滤移除了节点', {
      removed: removed.length,
      sample: removed.slice(0, 15).map(p => p.name),
      hitKeywords: kwHit.length ? kwHit : undefined,
    });
  }

  if (proxies.length > 0 && activeProxies.length === 0) {
    const reasons = [];
    // 只列出「真的减少了节点」的条件：默认配置带了一批关键词与开关，
    // 把没起作用的也写进提示会把用户的排查方向带偏。
    if (afterKeywords.length < proxies.length) {
      const hitKeywords = kwHit;
      if (hitKeywords.length) reasons.push(`排除关键词「${hitKeywords.join('、')}」`);
    }
    if (afterKeywords.length > 0) {
      if (hideDomestic && !hideInternational) reasons.push('隐藏国内节点');
      if (hideInternational && !hideDomestic) reasons.push('隐藏国际节点');
    }
    log.warn('全部节点被过滤条件排除', {
      nodes: proxies.length,
      reasons: reasons.length ? reasons : ['（未能定位具体条件）'],
    });
    throw new AllProxiesFilteredError(
      proxies.length,
      reasons.length ? `当前过滤条件（${reasons.join(' + ')}）排除了全部节点` : null
    );
  }

  return activeProxies;
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
  const { userGroups, nodeFilters, excludeKeywords } = resolveUserConfig(options);
  log.debug('转换入参', {
    in: proxies.length,
    name,
    mixedPort,
    mode,
    nodeFilters,
    excludeKeywords: excludeKeywords.length,
    userGroups: userGroups.length,
    dns: dns ? '透传源订阅 dns' : '无',
  });

  const activeProxies = applyNodeFilters(proxies, nodeFilters, excludeKeywords);

  // 生成代理分组。
  // activeProxies 已按用户配置过滤过，此处不再重复传 nodeFilters/excludeKeywords：
  // 过滤只保留 applyNodeFilters 一处，避免两个地方各过滤一遍而悄悄分叉。
  const proxyGroups = generateProxyGroups(activeProxies, { ...proxyGroupOptions, userGroups });

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
    // 活跃节点清单，供前端把节点名填进「分组默认出口」下拉框。
    // 一并返回 domestic 标记，前端就不必再抄一份国内关键词表
    // （关键词表在 config/regions.json，抄过去的那一份必然与后端漂移）。
    nodes: activeProxies.map(p => ({ name: p.name, domestic: isDomestic(p.name) })),
    groups: groupList
  };

  log.info('Clash 配置生成完成', {
    totalNodes: summary.totalNodes,
    filteredNodes: summary.filteredNodes,
    groups: proxyGroups.length,
    rules: rules.length,
    yamlBytes: logger.formatBytes(Buffer.byteLength(yamlStr, 'utf-8')),
    domestic: summary.nodes.filter(n => n.domestic).length,
  });

  return { yaml: yamlStr, summary };
}

/**
 * 将配置转换为 Surge 格式（简化版）
 *
 * 与 convertToClash 共用同一套用户配置解析与节点过滤：
 * 过滤/分组策略必须与 Clash 输出一致，否则同一个订阅在两个入口会得到
 * 不同的节点集合与分组默认项，用户无从判断哪个才是自己要的。
 */
function convertToSurge(proxies, options = {}) {
  const { userGroups, nodeFilters, excludeKeywords } = resolveUserConfig(options);
  const activeProxies = applyNodeFilters(proxies, nodeFilters, excludeKeywords);

  const lines = [];
  lines.push('#!name = ' + (options.name || 'Clash 订阅'));
  lines.push('');
  lines.push('[General]');
  lines.push('loglevel = notify');
  lines.push('skip-proxy = 127.0.0.1, 192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12, 100.64.0.0/10, localhost, *.local');
  lines.push('dns-server = 223.5.5.5, 119.29.29.29');
  lines.push('');

  lines.push('[Proxy]');
  for (const proxy of activeProxies) {
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
      case 'tuic':
        line = `${proxy.name} = tuic, ${proxy.server}, ${proxy.port}, uuid=${proxy.uuid}, password=${proxy.password || proxy.token || ''}`;
        if (proxy.sni) line += ', sni=' + proxy.sni;
        if (proxy['skip-cert-verify']) line += ', skip-cert-verify=true';
        break;
      default:
        // ssr / anytls 等 Surge 不支持的协议，静默跳过
        continue;
    }
    if (line) lines.push(line);
  }
  lines.push('');

  lines.push('[Proxy Group]');
  const groups = generateProxyGroups(activeProxies, { ...(options.proxyGroupOptions || {}), userGroups });
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

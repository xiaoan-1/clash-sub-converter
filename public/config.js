/**
 * 订阅转换 - 配置页面脚本
 */

// ========== 全局状态 ==========
var allNodes = [];
var config = { groups: [], nodeFilter: 'all', excludeKeywords: [] };
var conversionResult = null; // 最近一次转换结果 { yaml, summary }

var KW_PRESETS = ['流量', '官网', '套餐', '到期', '剩余', '应急', '免费', '测试', '失效', '过期', '活动', '优惠', '推荐', '广告', '回国', '禁止', 'ipv6', '中转', '隧道', '倍率', '专线', '-----'];

window.addEventListener('DOMContentLoaded', function() {
  loadConfig();
  initFileZone();
});

// ========== 配置加载 ==========

function loadConfig() {
  fetch('/api/config').then(function(res) { return res.json(); }).then(function(data) {
    config = data;
    if (!config.groups) config.groups = [];
    // nodeFilter 兼容
    if (!config.nodeFilter) {
      if (config.nodeFilters) {
        if (config.nodeFilters.hideDomestic) config.nodeFilter = 'hideDomestic';
        else if (config.nodeFilters.hideInternational) config.nodeFilter = 'hideInternational';
        else config.nodeFilter = 'all';
      } else {
        config.nodeFilter = 'all';
      }
    }
    if (!Array.isArray(config.excludeKeywords)) config.excludeKeywords = [];
    updateSegUI('filterSeg', config.nodeFilter);
    renderKeywords();
    renderPresets();
    renderGroups();
  }).catch(function() {
    config = { subscriptions: [], groups: [], nodeFilter: 'all', excludeKeywords: [] };
    renderGroups();
  });
}

// ========== URL 管理 ==========

function getUrlValues() {
  var text = document.getElementById('subUrls').value;
  return text.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l; });
}

// ========== Tab 切换 ==========

function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach(function(b) {
    b.classList.toggle('active', b.getAttribute('data-tab') === tabName);
  });
  document.querySelectorAll('.tab-panel').forEach(function(p) {
    p.classList.toggle('active', p.id === 'tab' + tabName.charAt(0).toUpperCase() + tabName.slice(1));
  });
}

// ========== 源模式切换 ==========

function switchSourceMode(mode, el) {
  document.querySelectorAll('#sourceMode .seg-btn').forEach(function(b) {
    b.classList.toggle('active', b.getAttribute('data-mode') === mode);
  });
  var showingUrl = mode === 'url';
  document.getElementById('urlInputArea').style.display = showingUrl ? 'block' : 'none';
  document.getElementById('fileInputArea').classList.toggle('show', !showingUrl);
  clearStatus();
}

// ========== 文件拖拽 ==========

function initFileZone() {
  var zone = document.getElementById('fileInputArea');
  if (!zone) return;
  zone.addEventListener('dragover', function(e) {
    e.preventDefault();
    zone.classList.add('drag-over');
  });
  zone.addEventListener('dragleave', function() {
    zone.classList.remove('drag-over');
  });
  zone.addEventListener('drop', function(e) {
    e.preventDefault();
    zone.classList.remove('drag-over');
    var file = e.dataTransfer.files[0];
    if (file) convertFile(file);
  });
}

function handleFileSelect(event) {
  var file = event.target.files[0];
  if (!file) return;
  convertFile(file);
}

function convertFile(file) {
  setStatus('status-loading', '正在转换...');
  var reader = new FileReader();
  reader.onload = function() {
    var content = reader.result;
    // 文件内容直接转换
    fetch('/api/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urls: [],
        nodeFilter: config.nodeFilter,
        excludeKeywords: config.excludeKeywords,
        rawContent: content
      })
    }).then(function(res) { return res.json().then(function(data) { return { ok: res.ok, data: data }; }); })
      .then(function(r) {
        if (!r.ok) throw new Error(r.data.error);
        conversionResult = r.data;
        setStatus('status-ok', '转换成功，共 ' + r.data.summary.filteredNodes + ' 个节点');
        showConversionResult(r.data.summary);
      })
      .catch(function(err) {
        setStatus('status-err', '转换失败: ' + err.message);
      });
  };
  reader.readAsText(file);
}

// ========== 转换 ==========

function doConvert() {
  // 检查当前模式
  var mode = document.querySelector('#sourceMode .seg-btn.active');
  var isFileMode = mode && mode.getAttribute('data-mode') === 'file';

  if (isFileMode) {
    setStatus('status-err', '文件模式下请拖拽文件或点击选择文件');
    return;
  }

  var urls = getUrlValues();
  if (urls.length === 0) {
    setStatus('status-err', '请至少输入一个订阅链接');
    return;
  }

  setStatus('status-loading', '正在转换...');

  fetch('/api/convert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      urls: urls,
      nodeFilter: config.nodeFilter,
      excludeKeywords: config.excludeKeywords
    })
  }).then(function(res) { return res.json().then(function(data) { return { ok: res.ok, data: data }; }); })
    .then(function(r) {
      if (!r.ok) throw new Error(r.data.error);
      conversionResult = r.data;
      setStatus('status-ok', '转换成功，共 ' + r.data.summary.filteredNodes + ' 个节点（原始 ' + r.data.summary.totalNodes + ' 个）');
      showConversionResult(r.data.summary);
    })
    .catch(function(err) {
      setStatus('status-err', '转换失败: ' + err.message);
    });
}

function downloadYaml() {
  if (!conversionResult || !conversionResult.yaml) {
    setStatus('status-err', '请先执行转换');
    return;
  }
  var blob = new Blob([conversionResult.yaml], { type: 'text/yaml' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'clash_config.yaml';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
  setStatus('status-ok', '已下载 clash_config.yaml');
}

// ========== 转换结果展示 ==========

function showConversionResult(summary) {
  var container = document.getElementById('resultContent');
  var card = document.getElementById('resultCard');

  var html = '<div class="result-summary">'
    + '原始节点：' + summary.totalNodes + ' 个 &nbsp;|&nbsp; 过滤后：' + summary.filteredNodes + ' 个 &nbsp;|&nbsp; 分组：' + summary.groups.length + ' 个'
    + '</div>';

  if (!summary.groups || summary.groups.length === 0) {
    html += '<div class="empty-hint">无分组数据</div>';
  } else {
    summary.groups.forEach(function(g, i) {
      var isSystem = g.type === 'system';
      var nodeCount = g.proxies ? g.proxies.length : 0;
      var typeLabel = isSystem ? '系统规则' : esc(g.type || 'select');
      var typeCls = 'result-group-type' + (isSystem ? ' result-group-system' : '');
      var countText = isSystem ? '' : ('<span style="font-size:12px;color:#bbb">' + nodeCount + ' 节点</span>');
      html += '<div class="result-group-card">'
        + '<div class="result-group-header" onclick="toggleResultGroup(this)">'
        + '<span class="result-group-arrow">▶</span>'
        + '<span class="result-group-name">' + esc(g.name) + '</span>'
        + '<span class="' + typeCls + '">' + typeLabel + '</span>'
        + countText
        + '</div>'
        + '<div class="result-group-nodes">';
      if (g.proxies) {
        var defaultP = g.defaultProxy || g.proxies[0];
        g.proxies.forEach(function(name) {
          var cls = 'result-node-tag' + (name === defaultP ? ' result-node-default' : '');
          html += '<span class="' + cls + '">' + esc(name) + '</span>';
        });
      }
      html += '</div></div>';
    });
  }

  container.innerHTML = html;
  card.classList.remove('hidden');
  switchTab('result');
}

function toggleResultGroup(header) {
  var arrow = header.querySelector('.result-group-arrow');
  var nodes = header.nextElementSibling;
  var isOpen = nodes.classList.contains('show');
  if (isOpen) {
    nodes.classList.remove('show');
    arrow.classList.remove('open');
  } else {
    nodes.classList.add('show');
    arrow.classList.add('open');
  }
}

// ========== 节点过滤 ==========

function setFilter(val) {
  config.nodeFilter = val;
  updateSegUI('filterSeg', val);
}

function updateSegUI(containerId, activeVal) {
  document.querySelectorAll('#' + containerId + ' .seg-btn').forEach(function(b) {
    b.classList.toggle('active', b.getAttribute('data-val') === activeVal);
  });
}

// ========== 排除关键词 ==========

function renderKeywords() {
  var container = document.getElementById('kwTags');
  if (!config.excludeKeywords || config.excludeKeywords.length === 0) {
    container.innerHTML = '<span style="font-size:12px;color:#ccc">暂无排除关键词</span>';
  } else {
    container.innerHTML = config.excludeKeywords.map(function(kw, i) {
      return '<span class="kw-tag">' + esc(kw) + '<span class="kw-remove" onclick="removeKeyword(' + i + ')">×</span></span>';
    }).join('');
  }
  renderPresets();
}

function addKeyword() {
  var input = document.getElementById('kwInput');
  var kw = input.value.trim();
  if (!kw) return;
  if (config.excludeKeywords.indexOf(kw) !== -1) {
    input.value = '';
    return;
  }
  config.excludeKeywords.push(kw);
  input.value = '';
  input.focus();
  renderKeywords();
}

function removeKeyword(index) {
  config.excludeKeywords.splice(index, 1);
  renderKeywords();
}

function addPreset(kw) {
  if (config.excludeKeywords.indexOf(kw) !== -1) return;
  config.excludeKeywords.push(kw);
  renderKeywords();
}

function renderPresets() {
  var container = document.getElementById('kwPresets');
  var used = {};
  (config.excludeKeywords || []).forEach(function(k) { used[k] = true; });
  container.innerHTML = KW_PRESETS.map(function(kw) {
    return '<span class="kw-preset' + (used[kw] ? ' used' : '') + '" onclick="addPreset(\'' + esc(kw) + '\')">' + esc(kw) + '</span>';
  }).join('');
}

// ========== 分组配置 ==========

function renderGroups() {
  var list = document.getElementById('groupsList');
  if (!config.groups || config.groups.length === 0) {
    list.innerHTML = '<div class="empty-hint">加载配置中...</div>';
    return;
  }
  var activeNames = getActiveNames();
  var html = '';
  config.groups.forEach(function(g, i) {
    var mandatory = g.builtin === 'select' || g.builtin === 'auto' || g.builtin === 'fallback';
    var enabled = mandatory ? true : (g.enabled !== false);
    var badge = mandatory ? '<span class="group-badge badge-must">必须</span>'
      : g.builtin ? '<span class="group-badge badge-builtin">内置</span>'
      : '<span class="group-badge badge-rule">规则</span>';

    var proxyOptions = ['DIRECT', '♻️ 自动选择'].concat(activeNames);

    html += '<div class="group-card' + (enabled ? '' : ' disabled') + '">'
      + '<span class="group-name">' + esc(g.name) + '</span>'
      + badge
      + '<select class="group-select" onchange="var g=config.groups[' + i + '];g.type=this.value;renderGroups()" ' + (enabled ? '' : 'disabled') + '>'
      + '<option value="select" ' + (g.type === 'select' ? 'selected' : '') + '>手动选择</option>'
      + '<option value="url-test" ' + (g.type === 'url-test' ? 'selected' : '') + '>自动测速</option>'
      + '</select>'
      + '默认: <select class="group-select" onchange="config.groups[' + i + '].defaultProxy=this.value" ' + (enabled ? '' : 'disabled') + '>';

    for (var j = 0; j < proxyOptions.length; j++) {
      html += '<option value="' + esc(proxyOptions[j]) + '" ' + (g.defaultProxy === proxyOptions[j] ? 'selected' : '') + '>' + esc(proxyOptions[j]) + '</option>';
    }

    html += '</select>';

    if (mandatory) {
      html += '<span style="font-size:11px;color:#bbb">(始终启用)</span>';
    } else {
      html += '<label class="group-toggle">'
        + '<input type="checkbox" ' + (enabled ? '' : 'checked') + ' onchange="toggleGroup(' + i + ', !this.checked)">'
        + '<span class="group-switch"></span>'
        + '<span class="toggle-label">' + (enabled ? '已启用' : '已禁用') + '</span>'
        + '</label>';
    }

    html += '</div>';
  });

  // 系统规则（只读展示）
  html += '<div style="margin-top:16px;font-size:12px;color:#999;padding-left:4px">系统规则（不可配置，始终生效）</div>';
  html += '<div class="group-card group-card-system">'
    + '<span class="group-name">🏠 本地路由</span>'
    + '<span class="group-badge badge-system">系统</span>'
    + '<span style="font-size:12px;color:#888;flex:1">LAN / 私有 IP / 路由器 / DDNS → DIRECT</span>'
    + '</div>';
  html += '<div class="group-card group-card-system">'
    + '<span class="group-name">🌐 GEOIP 分流</span>'
    + '<span class="group-badge badge-system">系统</span>'
    + '<span style="font-size:12px;color:#888;flex:1">GEOIP,CN → DIRECT</span>'
    + '</div>';

  list.innerHTML = html;
}

function toggleGroup(index, enabled) {
  config.groups[index].enabled = enabled;
  renderGroups();
}

function buildSavePayload() {
  var payload = JSON.parse(JSON.stringify(config));
  if (config.nodeFilter === 'hideDomestic') {
    payload.nodeFilters = { hideDomestic: true, hideInternational: false };
  } else if (config.nodeFilter === 'hideInternational') {
    payload.nodeFilters = { hideDomestic: false, hideInternational: true };
  } else {
    payload.nodeFilters = { hideDomestic: false, hideInternational: false };
  }
  delete payload.nodeFilter;
  if (!Array.isArray(payload.excludeKeywords)) payload.excludeKeywords = [];
  return payload;
}

function saveConfig() {
  var st = document.getElementById('saveStatus');
  fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildSavePayload()) })
    .then(function(res) { return res.json().then(function(data) { return { ok: res.ok, data: data }; }); })
    .then(function(r) {
      if (!r.ok) throw new Error(r.data.error);
      st.className = 'status status-ok';
      st.textContent = '配置已保存';
      setTimeout(function() { st.className = 'status'; }, 3000);
    })
    .catch(function(err) {
      st.className = 'status status-err';
      st.textContent = '保存失败: ' + err.message;
    });
}

// ========== 工具函数 ==========

function setStatus(className, msg) {
  var st = document.getElementById('convertStatus');
  st.className = 'status ' + className;
  st.textContent = msg;
}

function clearStatus() {
  var st = document.getElementById('convertStatus');
  st.className = 'status';
  st.textContent = '';
}

function esc(s) {
  var d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function getActiveNames() {
  var names = allNodes.map(function(n) { return n.name; });
  if (config.nodeFilter === 'hideDomestic') names = names.filter(function(n) { return !isDomesticNode(n); });
  if (config.nodeFilter === 'hideInternational') names = names.filter(function(n) { return isDomesticNode(n); });
  return names;
}

var CN_KEYWORDS = ['国内','中国','China','CN','广州','上海','北京','深圳','杭州','成都','武汉','移动','联通','电信','广电'];

function isDomesticNode(name) {
  var upper = name.toUpperCase();
  for (var i = 0; i < CN_KEYWORDS.length; i++) {
    if (upper.indexOf(CN_KEYWORDS[i].toUpperCase()) !== -1) return true;
  }
  return false;
}

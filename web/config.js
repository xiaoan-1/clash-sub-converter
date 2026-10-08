/**
 * 订阅转换 - 配置页面脚本
 */

// ========== 全局状态 ==========
var allNodes = []; // 最近一次转换的活跃节点 [{ name, domestic }]
var config = { groups: [], nodeFilter: 'all', excludeKeywords: [] };
var conversionResult = null; // 最近一次转换结果 { yaml, summary }
var uaPresets = []; // 订阅拉取 UA 预设（来自 /api/user-agents）

var KW_PRESETS = [
	'流量',
	'官网',
	'套餐',
	'到期',
	'剩余',
	'应急',
	'免费',
	'测试',
	'失效',
	'过期',
	'活动',
	'优惠',
	'推荐',
	'广告',
	'回国',
	'禁止',
	'ipv6',
	'中转',
	'隧道',
	'倍率',
	'专线',
	'-----',
];

window.addEventListener('DOMContentLoaded', function () {
	// 先拿到 UA 预设，再渲染配置（UA 下拉框为空会导致渲染出错）
	loadUaPresets().then(function () {
		loadUserConfig();
	});
	initFileZone();
});

// ========== 配置加载 ==========

/**
 * 从服务端读回当前请求对应的配置。
 *
 * 服务端按访问者 IP 分文件（管理员用 config.json 站点基准，其余访客各用
 * guests/<IP>.json），响应里的 scope 就是告诉页面「你正在改哪一份」。
 * 只在页面初始化时调用一次 —— 页面不再提供「加载配置」按钮，
 * 因为改动会即时写回，不存在需要重新拉取的草稿。
 */
function loadUserConfig() {
	fetch('./api/config')
		.then(function (res) {
			return res.json();
		})
		.then(function (data) {
			config = data;
			renderScope(config.scope);
			if (!config.groups) config.groups = [];
			// nodeFilter 兼容
			if (!config.nodeFilter) {
				if (config.nodeFilters) {
					if (config.nodeFilters.hideDomestic) config.nodeFilter = 'hideDomestic';
					else if (config.nodeFilters.hideInternational)
						config.nodeFilter = 'hideInternational';
					else config.nodeFilter = 'all';
				} else {
					config.nodeFilter = 'all';
				}
			}
			if (!Array.isArray(config.excludeKeywords)) config.excludeKeywords = [];
			if (!config.fetch) config.fetch = { userAgent: 'auto', customUserAgent: '' };
			if (!config.fetch.userAgent) config.fetch.userAgent = 'auto';
			updateSegUI('filterSeg', config.nodeFilter);
			renderKeywords();
			renderPresets();
			renderUa();
			renderGroups();
			setSaveState('ok');
		})
		.catch(function () {
			config = {
				groups: [],
				nodeFilter: 'all',
				excludeKeywords: [],
				fetch: { userAgent: 'auto', customUserAgent: '' },
			};
			renderUa();
			renderGroups();
			setSaveState('err', '配置加载失败');
		});
}

/**
 * 顶栏显示当前身份：改的是站点基准（管理员）还是自己那份访客配置。
 * 部署到公网后这一步很重要 —— 否则管理员会意识不到自己改的不再是「全局」。
 */
function renderScope(scope) {
	var el = document.getElementById('scopeLabel');
	if (!el || !scope) return;
	el.textContent = scope.admin
		? '👑 管理员 · 站点基准 · ' + scope.ip
		: '👤 访客 · guests/' + scope.guest + '.json';
}

// ========== 订阅拉取 UA ==========

function loadUaPresets() {
	return fetch('./api/user-agents')
		.then(function (res) {
			return res.json();
		})
		.then(function (data) {
			uaPresets = (data && data.presets) || [];
		})
		.catch(function () {
			uaPresets = [];
		});
}

function findUaPreset(id) {
	for (var i = 0; i < uaPresets.length; i++) {
		if (uaPresets[i].id === id) return uaPresets[i];
	}
	return null;
}

function renderUa() {
	var sel = document.getElementById('uaSelect');
	if (!sel) return;
	if (!config.fetch) config.fetch = { userAgent: 'auto', customUserAgent: '' };
	if (!config.fetch.userAgent) config.fetch.userAgent = 'auto';

	sel.innerHTML = uaPresets
		.map(function (p) {
			var label = p.name + (p.platform ? ' — ' + p.platform : '');
			return (
				'<option value="' +
				esc(p.id) +
				'"' +
				(p.id === config.fetch.userAgent ? ' selected' : '') +
				'>' +
				esc(label) +
				'</option>'
			);
		})
		.join('');

	updateUaUi();
}

function updateUaUi() {
	var cur = config.fetch.userAgent;
	var preset = findUaPreset(cur);
	var customRow = document.getElementById('uaCustomRow');
	var customInput = document.getElementById('uaCustomInput');
	var note = document.getElementById('uaNote');
	if (!note) return;

	if (cur === 'custom') {
		customRow.style.display = 'flex';
		if (customInput) customInput.value = config.fetch.customUserAgent || '';
		note.textContent = preset && preset.note ? preset.note : '自定义 UA 将原样发送';
		return;
	}

	customRow.style.display = 'none';
	if (cur === 'auto') {
		note.textContent = (preset && preset.note) || '透传调用方 UA';
	} else {
		note.textContent = '将发送：' + (preset ? preset.ua : '(未知预设)');
	}
}

function onUaChange() {
	var sel = document.getElementById('uaSelect');
	config.fetch.userAgent = sel.value;
	updateUaUi();
	scheduleSave();
}

function onUaCustomInput() {
	config.fetch.customUserAgent = document.getElementById('uaCustomInput').value;
	scheduleSave();
}

// ========== URL 管理 ==========

function getUrlValues() {
	var text = document.getElementById('subUrls').value;
	return text
		.split('\n')
		.map(function (l) {
			return l.trim();
		})
		.filter(function (l) {
			return l;
		});
}

// ========== Tab 切换 ==========

function switchTab(tabName) {
	document.querySelectorAll('.tab-btn').forEach(function (b) {
		b.classList.toggle('active', b.getAttribute('data-tab') === tabName);
	});
	document.querySelectorAll('.tab-panel').forEach(function (p) {
		p.classList.toggle(
			'active',
			p.id === 'tab' + tabName.charAt(0).toUpperCase() + tabName.slice(1),
		);
	});
}

// ========== 源模式切换 ==========

function switchSourceMode(mode, el) {
	document.querySelectorAll('#sourceMode .seg-btn').forEach(function (b) {
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
	zone.addEventListener('dragover', function (e) {
		e.preventDefault();
		zone.classList.add('drag-over');
	});
	zone.addEventListener('dragleave', function () {
		zone.classList.remove('drag-over');
	});
	zone.addEventListener('drop', function (e) {
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
	reader.onload = function () {
		var content = reader.result;
		// 文件内容直接转换
		fetch('./api/convert', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				urls: [],
				nodeFilter: config.nodeFilter,
				excludeKeywords: config.excludeKeywords,
				rawContent: content,
			}),
		})
			.then(function (res) {
				return res.json().then(function (data) {
					return { ok: res.ok, data: data };
				});
			})
			.then(function (r) {
				if (!r.ok) throw new Error(r.data.error);
				conversionResult = r.data;
				applyNodeList(r.data.summary);
				setStatus('status-ok', '转换成功，共 ' + r.data.summary.filteredNodes + ' 个节点');
				showConversionResult(r.data.summary);
			})
			.catch(function (err) {
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

	fetch('./api/convert', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			urls: urls,
			nodeFilter: config.nodeFilter,
			excludeKeywords: config.excludeKeywords,
		}),
	})
		.then(function (res) {
			return res.json().then(function (data) {
				return { ok: res.ok, data: data };
			});
		})
		.then(function (r) {
			if (!r.ok) throw new Error(r.data.error);
			conversionResult = r.data;
			applyNodeList(r.data.summary);
			setStatus(
				'status-ok',
				'转换成功，共 ' +
					r.data.summary.filteredNodes +
					' 个节点（原始 ' +
					r.data.summary.totalNodes +
					' 个）',
			);
			showConversionResult(r.data.summary);
		})
		.catch(function (err) {
			setStatus('status-err', '转换失败: ' + err.message);
		});
}

/**
 * 用转换结果里的节点清单刷新下拉框候选。
 * 节点名只有在解析订阅之后才知道，此前 allNodes 恒为空数组，
 * 于是「分组 → 默认出口」下拉框永远只列 3 个固定项，用户选不到具体节点。
 */
function applyNodeList(summary) {
	allNodes = (summary && summary.nodes) || [];
	renderGroups();
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

	var html =
		'<div class="result-summary">' +
		'原始节点：' +
		summary.totalNodes +
		' 个 &nbsp;|&nbsp; 过滤后：' +
		summary.filteredNodes +
		' 个 &nbsp;|&nbsp; 分组：' +
		summary.groups.length +
		' 个' +
		'</div>';

	if (!summary.groups || summary.groups.length === 0) {
		html += '<div class="empty-hint">无分组数据</div>';
	} else {
		summary.groups.forEach(function (g, i) {
			var isSystem = g.type === 'system';
			var nodeCount = g.proxies ? g.proxies.length : 0;
			var typeLabel = isSystem ? '系统规则' : esc(g.type || 'select');
			var typeCls = 'result-group-type' + (isSystem ? ' result-group-system' : '');
			var countText = isSystem
				? ''
				: '<span style="font-size:12px;color:#bbb">' + nodeCount + ' 节点</span>';
			html +=
				'<div class="result-group-card">' +
				'<div class="result-group-header" onclick="toggleResultGroup(this)">' +
				'<span class="result-group-arrow">▶</span>' +
				'<span class="result-group-name">' +
				esc(g.name) +
				'</span>' +
				'<span class="' +
				typeCls +
				'">' +
				typeLabel +
				'</span>' +
				countText +
				'</div>' +
				'<div class="result-group-nodes">';
			if (g.proxies) {
				var defaultP = g.defaultProxy || g.proxies[0];
				g.proxies.forEach(function (name) {
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
	scheduleSave();
}

function updateSegUI(containerId, activeVal) {
	document.querySelectorAll('#' + containerId + ' .seg-btn').forEach(function (b) {
		b.classList.toggle('active', b.getAttribute('data-val') === activeVal);
	});
}

// ========== 排除关键词 ==========

function renderKeywords() {
	var container = document.getElementById('kwTags');
	if (!config.excludeKeywords || config.excludeKeywords.length === 0) {
		container.innerHTML = '<span style="font-size:12px;color:#ccc">暂无排除关键词</span>';
	} else {
		container.innerHTML = config.excludeKeywords
			.map(function (kw, i) {
				return (
					'<span class="kw-tag">' +
					esc(kw) +
					'<span class="kw-remove" onclick="removeKeyword(' +
					i +
					')">×</span></span>'
				);
			})
			.join('');
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
	scheduleSave();
}

function removeKeyword(index) {
	config.excludeKeywords.splice(index, 1);
	renderKeywords();
	scheduleSave();
}

function addPreset(kw) {
	if (config.excludeKeywords.indexOf(kw) !== -1) return;
	config.excludeKeywords.push(kw);
	renderKeywords();
	scheduleSave();
}

function renderPresets() {
	var container = document.getElementById('kwPresets');
	var used = {};
	(config.excludeKeywords || []).forEach(function (k) {
		used[k] = true;
	});
	container.innerHTML = KW_PRESETS.map(function (kw) {
		return (
			'<span class="kw-preset' +
			(used[kw] ? ' used' : '') +
			'" onclick="addPreset(\'' +
			esc(kw) +
			'\')">' +
			esc(kw) +
			'</span>'
		);
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
	config.groups.forEach(function (g, i) {
		var mandatory = g.builtin === 'select' || g.builtin === 'auto' || g.builtin === 'fallback';
		var enabled = mandatory ? true : g.enabled !== false;
		var badge = mandatory
			? '<span class="group-badge badge-must">必须</span>'
			: g.builtin
				? '<span class="group-badge badge-builtin">内置</span>'
				: '<span class="group-badge badge-rule">规则</span>';

		var proxyOptions = ['🚀 节点选择', '♻️ 自动选择', 'DIRECT'].concat(activeNames);

		html +=
			'<div class="group-card' +
			(enabled ? '' : ' disabled') +
			'">' +
			'<span class="group-name">' +
			esc(g.name) +
			'</span>' +
			badge +
			'<select class="group-select" onchange="var g=config.groups[' +
			i +
			'];g.type=this.value;renderGroups();scheduleSave()" ' +
			(enabled ? '' : 'disabled') +
			'>' +
			'<option value="select" ' +
			(g.type === 'select' ? 'selected' : '') +
			'>手动选择</option>' +
			'<option value="url-test" ' +
			(g.type === 'url-test' ? 'selected' : '') +
			'>自动测速</option>' +
			'</select>' +
			'默认: <select class="group-select" onchange="config.groups[' +
			i +
			'].defaultProxy=this.value;scheduleSave()" ' +
			(enabled ? '' : 'disabled') +
			'>';

		for (var j = 0; j < proxyOptions.length; j++) {
			html +=
				'<option value="' +
				esc(proxyOptions[j]) +
				'" ' +
				(g.defaultProxy === proxyOptions[j] ? 'selected' : '') +
				'>' +
				esc(proxyOptions[j]) +
				'</option>';
		}

		html += '</select>';

		if (mandatory) {
			html += '<span style="font-size:11px;color:#bbb">(始终启用)</span>';
		} else {
			html +=
				'<label class="group-toggle">' +
				'<input type="checkbox" ' +
				(enabled ? '' : 'checked') +
				' onchange="toggleGroup(' +
				i +
				', !this.checked)">' +
				'<span class="group-switch"></span>' +
				'<span class="toggle-label">' +
				(enabled ? '已启用' : '已禁用') +
				'</span>' +
				'</label>';
		}

		html += '</div>';
	});

	// 系统规则（只读展示）
	html +=
		'<div style="margin-top:16px;font-size:12px;color:#999;padding-left:4px">系统规则（不可配置，始终生效）</div>';
	html +=
		'<div class="group-card group-card-system">' +
		'<span class="group-name">🏠 本地路由</span>' +
		'<span class="group-badge badge-system">系统</span>' +
		'<span style="font-size:12px;color:#888;flex:1">LAN / 私有 IP / 路由器 / DDNS → DIRECT</span>' +
		'</div>';
	html +=
		'<div class="group-card group-card-system">' +
		'<span class="group-name">🌐 GEOIP 分流</span>' +
		'<span class="group-badge badge-system">系统</span>' +
		'<span style="font-size:12px;color:#888;flex:1">GEOIP,CN → DIRECT</span>' +
		'</div>';

	list.innerHTML = html;
}

function toggleGroup(index, enabled) {
	config.groups[index].enabled = enabled;
	renderGroups();
	scheduleSave();
}

function buildSavePayload() {
	var payload = JSON.parse(JSON.stringify(config));
	// scope 是只读的身份信息，不能回传给服务端
	delete payload.scope;
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

// ========== 自动保存 ==========
//
// 页面不再保留「改了但没保存」的草稿状态：任何改动（过滤方式 / 排除关键词 /
// 拉取 UA / 分组开关与选项）都会合并写回，因此不需要「加载配置」「保存配置」两个按钮。
//
// 写回的目标由服务端根据访问者 IP 决定：管理员写 config.json（站点基准），
// 其余访客写 guests/<IP>.json，两者都只存差异。
//
// 防抖的用处：自定义 UA 是逐字符触发的，关键词也可能连点，
// 300ms 合并后一次请求即可，同时保证快速连点最终只落盘最终状态。

var SAVE_DEBOUNCE_MS = 300;
var saveTimer = null;
var saveInFlight = false;
var saveDirty = false;

/** 标记有改动并安排写回。所有修改配置的地方都必须调用它。 */
function scheduleSave() {
	saveDirty = true;
	setSaveState('pending');
	clearTimeout(saveTimer);
	saveTimer = setTimeout(autosave, SAVE_DEBOUNCE_MS);
}

/**
 * 写回用户配置。
 * 同一时刻只允许一个请求在飞：并发写同一个文件会互相覆盖，
 * 所以飞行中若有新改动，等回来后再补一次（saveDirty）。
 */
function autosave() {
	clearTimeout(saveTimer);
	if (saveInFlight) return;

	saveInFlight = true;
	saveDirty = false;

	fetch('./api/config', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(buildSavePayload()),
	})
		.then(function (res) {
			return res.json().then(function (data) {
				return { ok: res.ok, data: data };
			});
		})
		.then(function (r) {
			saveInFlight = false;
			if (!r.ok) throw new Error(r.data.error);
			if (saveDirty)
				autosave(); // 飞行期间又改了 → 再写一次
			else setSaveState('ok');
		})
		.catch(function (err) {
			saveInFlight = false;
			setSaveState('err', err.message);
		});
}

/** 顶栏状态提示：pending=保存中 / ok=已保存 / err=保存失败 */
function setSaveState(state, msg) {
	var el = document.getElementById('saveStatus');
	if (!el) return;
	if (state === 'pending') {
		el.className = 'autosave-state autosave-pending';
		el.textContent = '保存中…';
	} else if (state === 'err') {
		el.className = 'autosave-state autosave-err';
		el.textContent = '保存失败：' + (msg || '未知错误');
	} else {
		el.className = 'autosave-state autosave-ok';
		el.textContent = '已自动保存';
	}
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

/**
 * HTML 转义。
 * 同时用于文本位置与属性位置（value="..."、onclick="f('...')"），
 * 而节点名直接来自订阅、完全不可信 —— 引号必须一并转义，
 * 否则一个名为 x" onfocus="alert(1)  的节点就能闭合属性并注入任意属性/事件。
 */
function esc(s) {
	return String(s === null || s === undefined ? '' : s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/**
 * 下拉框候选节点名。
 * domestic 由后端随转换结果给出（后端读 config/regions.json），
 * 前端不再维护第二份关键词表。
 */
function getActiveNames() {
	return allNodes
		.filter(function (n) {
			if (config.nodeFilter === 'hideDomestic') return !n.domestic;
			if (config.nodeFilter === 'hideInternational') return n.domestic;
			return true;
		})
		.map(function (n) {
			return n.name;
		});
}

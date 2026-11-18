/**
 * 订阅转换 - 配置页面脚本
 */

// ========== 全局状态 ==========
var allNodes = []; // 最近一次转换的活跃节点 [{ name, domestic }]
var allRegions = []; // 上层分组的候选（地区分组 + 🇨🇳 中国大陆），供「默认出口」下拉使用
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
	initPresetClicks();
});

/**
 * 预设关键词的点击事件。
 *
 * 用事件委托 + data-kw，而不是在 HTML 里拼 `onclick="addPreset('...')"`：
 * 关键词是可编辑内容，内联事件里即使做了 HTML 转义，`&#39;` 也会在属性
 * 解析时还原成单引号，keyword 一旦含引号就能闭掉字符串执行任意脚本。
 */
function initPresetClicks() {
	var box = document.getElementById('kwPresets');
	if (!box) return;
	box.addEventListener('click', function (e) {
		var el = e.target && e.target.closest ? e.target.closest('[data-kw]') : null;
		if (el) addPreset(el.getAttribute('data-kw'));
	});
}

// ========== 配置加载 ==========

/**
 * 从服务端读回当前访客的生效配置。
 *
 * 服务端按访问者 IP 分文件：基准是 config/default.json（部署人员直接编辑），
 * 每位访客的改动存到 guests/<IP>.json，响应里的 scope 告诉页面「你正在改哪一份」。
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
			if (!Array.isArray(config.subscriptions)) config.subscriptions = [];
			if (!config.limits || typeof config.limits.subscriptions !== 'number') {
				config.limits = { subscriptions: 10 };
			}
			if (!config.fetch) config.fetch = { userAgent: 'auto', customUserAgent: '' };
			if (!config.fetch.userAgent) config.fetch.userAgent = 'auto';
			updateSegUI('filterSeg', config.nodeFilter);
			renderKeywords();
			renderPresets();
			renderSubscriptions();
			renderUa();
			renderGroups();
			setSaveState('ok');
		})
		.catch(function () {
			config = {
				groups: [],
				nodeFilter: 'all',
				excludeKeywords: [],
				subscriptions: [],
				limits: { subscriptions: 10 },
				fetch: { userAgent: 'auto', customUserAgent: '' },
			};
			renderUa();
			renderGroups();
			setSaveState('err', '配置加载失败');
		});
}

/**
 * 顶栏显示当前访客身份：改的是自己那份 guests/<IP>.json。
 * 部署到公网后这一步很重要 —— 让访客知道改动只影响自己，
 * 全局基准由部署人员直接编辑 config/default.json。
 */
function renderScope(scope) {
	var el = document.getElementById('scopeLabel');
	if (!el || !scope) return;
	el.textContent = '👤 访客 · guests/' + scope.guest + '.json · ' + scope.ip;
}

// ========== 我的订阅（按 IP 保存，客户端直接填 /sub） ==========

/** 拉取不到服务端上限时的兜底（与服务端 MAX_URLS 默认值一致） */
var MAX_SAVED_SUBS_FALLBACK = 10;

/**
 * 读取「我的订阅」输入框里的地址。
 *
 * 与服务端 normalizeSubscriptions 保持同一套规则（去空白 / 去重 /
 * 只留 http(s) / 限制条数），这样保存后看到的数量与实际生效的一致。
 */
function readSavedSubUrls() {
	var ta = document.getElementById('savedSubUrls');
	if (!ta) return [];
	var limit = (config.limits && config.limits.subscriptions) || MAX_SAVED_SUBS_FALLBACK;
	var out = [];
	ta.value.split('\n').forEach(function (line) {
		var url = line.trim();
		if (!url) return;
		if (!/^https?:\/\//i.test(url)) return;
		if (out.indexOf(url) !== -1) return;
		if (out.length >= limit) return;
		out.push(url);
	});
	return out;
}

/** 用配置里的订阅地址填充输入框，并更新地址与状态 */
function renderSubscriptions() {
	var ta = document.getElementById('savedSubUrls');
	if (ta) ta.value = (config.subscriptions || []).join('\n');
	renderSubEndpoint();
	var n = (config.subscriptions || []).length;
	setSubSaveState('ok', n ? '已保存 ' + n + ' 个订阅地址' : '尚未保存订阅地址');
}

/**
 * 客户端应填的地址：由当前页面地址推出服务根路径。
 *   http://host/cfg        → http://host/sub
 *   http://host/clash/cfg  → http://host/clash/sub
 * 不能用 './sub' 直接解析：页面被访问成 /cfg/（带尾斜杠）时会得到 /cfg/sub。
 */
function subEndpointUrl() {
	var base = location.href.split('?')[0].split('#')[0].replace(/\/+$/, '');
	return base.replace(/\/cfg$/, '') + '/sub';
}

function renderSubEndpoint() {
	var el = document.getElementById('subEndpoint');
	if (el) el.textContent = subEndpointUrl();
}

function setSubSaveState(state, msg) {
	var el = document.getElementById('subSaveStatus');
	if (!el) return;
	var cls = 'autosave-state';
	if (state === 'pending') cls += ' autosave-pending';
	else if (state === 'err') cls += ' autosave-err';
	else cls += ' autosave-ok';
	el.className = cls;
	el.textContent = msg || '';
}

/** 输入了但还没点保存：明确提示，避免以为已经生效 */
function onSubUrlsInput() {
	setSubSaveState('pending', '有未保存的修改，点「保存订阅地址」后生效');
}

/** 显式保存（不等防抖）：输入框内容写进 config 后立即提交 */
function saveSubscriptions() {
	config.subscriptions = readSavedSubUrls();
	var btn = document.getElementById('subSaveBtn');
	if (btn) btn.disabled = true;
	setSubSaveState('pending', '保存中…');
	saveNow(function (err) {
		if (btn) btn.disabled = false;
		if (err) {
			setSubSaveState('err', '保存失败：' + err.message);
			return;
		}
		var n = config.subscriptions.length;
		setSubSaveState('ok', n ? '已保存 ' + n + ' 个订阅地址' : '已清空订阅地址');
	});
}

function copySubEndpoint() {
	var text = subEndpointUrl();
	if (navigator.clipboard && navigator.clipboard.writeText) {
		navigator.clipboard.writeText(text).then(
			function () {
				setSubSaveState('ok', '地址已复制：' + text);
			},
			function () {
				setSubSaveState('err', '复制失败，请手动选中复制');
			},
		);
	} else {
		setSubSaveState('err', '当前浏览器不支持自动复制，请手动选中复制');
	}
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

	// 拖到拖拽区之外时，浏览器默认会直接导航打开该文件（页面被替换，
	// 用户看到的就是「导入失败」）。必须在 window 上全局阻止默认行为。
	['dragover', 'drop'].forEach(function (type) {
		window.addEventListener(
			type,
			function (e) {
				// 拖拽区内的由上面的监听器处理，此处只阻止其余区域的默认行为
				if (!zone.contains(e.target)) e.preventDefault();
			},
			false,
		);
	});
}

function handleFileSelect(event) {
	var input = event.target;
	var file = input.files[0];
	// 立即清空 value：否则连续选择同一个文件时 change 事件不再触发
	// （浏览器只在值变化时派发），表现为「第二次导入毫无反应」。
	input.value = '';
	if (!file) return;
	convertFile(file);
}

function convertFile(file) {
	setStatus('status-loading', '正在转换...');
	var reader = new FileReader();
	reader.onload = function () {
		var content = reader.result;
		// 读取失败（权限/中断）或空文件：直接给出可读提示，不要发一个空请求
		if (!content || !content.trim()) {
			setStatus('status-err', '文件内容为空或读取失败');
			return;
		}
		// 非 UTF-8（如 GBK）的订阅会被解码成一堆 U+FFFD，导致解析不出任何节点。
		// 提前识别并提示，比让用户看到「未找到有效代理节点」更好排查。
		if (content.indexOf('\uFFFD') !== -1) {
			setStatus('status-err', '文件不是 UTF-8 编码（可能为 GBK），请另存为 UTF-8 后重试');
			return;
		}
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
				if (!r.ok) throw convertError(r.data);
				conversionResult = r.data;
				applyNodeList(r.data.summary);
				setStatus('status-ok', '转换成功，共 ' + r.data.summary.filteredNodes + ' 个节点');
				showConversionResult(r.data.summary);
			})
			.catch(function (err) {
				setStatus('status-err', '转换失败: ' + err.message);
			});
	};
	// 文件被移动/删除/无权限时 FileReader 会失败，必须兜底，否则状态停在「正在转换...」
	reader.onerror = function () {
		setStatus(
			'status-err',
			'文件读取失败：' + (reader.error ? reader.error.message : '未知错误'),
		);
	};
	reader.readAsText(file);
}

// ========== 转换 ==========

/**
 * 把接口返回的错误体拼成一句可操作的话。
 *
 * 后端在 400 时会给 `hint`（下一步怎么做）与 `failures`（逐条订阅为什么失败），
 * 只显示 `error`（「无法获取任何订阅内容」）等于把最有用的排查信息丢掉了。
 */
function convertError(data) {
	var msg = (data && data.error) || '未知错误';
	if (data && data.hint) msg += '\n' + data.hint;
	if (data && data.failures && data.failures.length) {
		msg +=
			'\n' +
			data.failures
				.map(function (f) {
					return '· ' + f.url + ' → ' + f.reason + (f.code ? '（' + f.code + '）' : '');
				})
				.join('\n');
	}
	var e = new Error(msg);
	e.detail = data;
	return e;
}

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
			if (!r.ok) throw convertError(r.data);
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
 *
 * allRegions 用后端给的 summary.regions —— 它是「上层分组的候选清单」
 * （地区分组 + 🇨🇳 中国大陆），前端不去猜哪些分组算地区，避免规则与后端分叉。
 */
function applyNodeList(summary) {
	allNodes = (summary && summary.nodes) || [];
	allRegions = (summary && summary.regions) || [];
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
			// 只有 select 组才有「默认出口」：url-test 由内核按测速挑，
			// fallback 按可用性挑，两者都没有可指定的出口。
			var isSelect = g.type === 'select';
			var nodeCount = g.proxies ? g.proxies.length : 0;
			var typeLabel = isSystem ? '系统规则' : isSelect ? '👆 手动选择' : '⚡ 自动选择';
			var typeCls =
				'result-group-type' +
				(isSystem ? ' result-group-system' : isSelect ? '' : ' result-group-urltest');
			var countText = isSystem
				? ''
				: '<span style="font-size:12px;color:#bbb">' + nodeCount + ' 节点</span>';
			// 默认出口由后端按类型给出（非 select 组为 null），前端不再自己猜
			var hintText = '';
			if (!isSystem) {
				hintText = g.defaultProxy
					? '<span class="result-group-hint">默认出口：' + esc(g.defaultProxy) + '</span>'
					: '<span class="result-group-hint">自动在组内选延迟最低的节点</span>';
			}
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
				hintText +
				'</div>' +
				'<div class="result-group-nodes">';
			if (g.proxies) {
				// 仅手动选择组标出默认出口；测速 / 兜底组高亮任意一项都是误导
				var defaultP = isSelect ? g.defaultProxy : null;
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
			'" data-kw="' +
			esc(kw) +
			'">' +
			esc(kw) +
			'</span>'
		);
	}).join('');
}

// ========== 分组配置 ==========

/**
 * 「默认出口」下拉的候选。
 * 后端采用两级结构：上层 select 分组的候选是地区分组（香港/台湾…），
 * 因此这里必须与后端一致 —— 启用地区分组时只列地区，否则列具体节点。
 *
 * 「中国大陆」是叶子组（被节点选择引用，自己不能再引用分组，否则成环），
 * 所以它的候选只能是具体节点。
 */
function getProxyOptions(g) {
	var fixed = ['🚀 节点选择', '♻️ 自动选择', 'DIRECT'];
	if (g && g.builtin === 'domestic') {
		return ['DIRECT'].concat(
			getActiveNames().filter(function (n) {
				return n !== 'DIRECT';
			}),
		);
	}
	if (allRegions.length) return fixed.concat(allRegions);
	return fixed.concat(getActiveNames());
}

/**
 * 分组列表。
 *
 * 列表里只有「真实分组」（🍎 Apple 服务 / ⌨️ GitHub / 🇨🇳 中国大陆 …）——
 * 它们在输出里存在同名 proxy-group，组内是节点或地区分组。
 *
 * 「🌏 地区分组」不在此列：它是生成器而非分组（输出里没有这个名字），
 * 单独渲染在列表上方的独立区域（见 renderRegionGenerator）。
 */
function renderGroups() {
	// 生成器与分组列表同属「分组区」，统一在此渲染，避免各调用点遗漏其中一个
	renderRegionGenerator();

	var list = document.getElementById('groupsList');
	if (!config.groups || config.groups.length === 0) {
		list.innerHTML = '<div class="empty-hint">加载配置中...</div>';
		return;
	}
	var html = '';
	config.groups.forEach(function (g, i) {
		// 生成器由 renderRegionGenerator 单独渲染，跳过
		if (g.builtin === 'regions') return;

		var mandatory = g.builtin === 'select' || g.builtin === 'auto' || g.builtin === 'fallback';
		var enabled = mandatory ? true : g.enabled !== false;
		var badge = mandatory
			? '<span class="group-badge badge-must">必须</span>'
			: g.builtin
				? '<span class="group-badge badge-builtin">内置</span>'
				: '<span class="group-badge badge-rule">规则</span>';

		var proxyOptions = getProxyOptions(g);

		// 「节点选择」「自动选择」的类型与默认出口由 Clash 的两级结构决定
		// （默认出口 = 候选首项；自动选择由内核按延迟挑），改了也不会体现在输出里，
		// 因此只读展示 —— 否则用户以为改了生效，实际被后端忽略。
		var typeFixed = g.builtin === 'select' || g.builtin === 'auto';
		var defaultFixed = typeFixed;

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
			(enabled && !typeFixed ? '' : 'disabled') +
			'>' +
			'<option value="select" ' +
			(g.type === 'select' ? 'selected' : '') +
			'>手动选择</option>' +
			'<option value="url-test" ' +
			(g.type === 'url-test' ? 'selected' : '') +
			'>自动测速</option>' +
			'</select>';

		if (defaultFixed) {
			html +=
				'<span class="group-fixed" style="font-size:12px;color:#8b949e">默认: ' +
				esc(g.builtin === 'auto' ? '内核自动测速' : '♻️ 自动选择') +
				'</span>';
		} else {
			html +=
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
		}

		if (mandatory) {
			html += '<span style="font-size:11px;color:#bbb">(始终启用)</span>';
		} else {
			// checked 直接表示「启用」：与开关视觉（绿=开）一致，避免反义混淆
			html +=
				'<label class="group-toggle">' +
				'<input type="checkbox" ' +
				(enabled ? 'checked' : '') +
				' onchange="toggleGroup(' +
				i +
				', this.checked)">' +
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

/**
 * 「🌏 地区分组」生成器 —— 渲染在「分组配置」卡片顶部的独立区域。
 *
 * 它不是分组本身：输出里没有这个名字，它批量生成 🇭🇰 香港 / 🇹🇼 台湾 … 等分组。
 * 因此不显示「默认出口」（地区组只装本地区节点，无出口可选），
 * 「类型」是对生成结果的描述（自动测速 / 手动选择），开关控制生成与否。
 *
 * 与分组列表视觉隔离：分组列表是用户常改的（默认出口等），生成器只改一次，
 * 混在一起会让用户以为「香港、台湾」是它下面的节点选项。
 */
function renderRegionGenerator() {
	var box = document.getElementById('regionGenerator');
	if (!box) return;

	var idx = -1;
	for (var k = 0; k < config.groups.length; k++) {
		if (config.groups[k].builtin === 'regions') {
			idx = k;
			break;
		}
	}
	if (idx < 0) {
		box.innerHTML = '';
		return;
	}

	var g = config.groups[idx];
	var enabled = g.enabled !== false;

	box.innerHTML =
		'<div class="region-generator' +
		(enabled ? '' : ' disabled') +
		'">' +
		'<div class="rg-head">' +
		'<span class="rg-title">' +
		esc(g.name) +
		'</span>' +
		'<span class="group-badge badge-generator">生成器</span>' +
		'<label class="group-toggle">' +
		'<input type="checkbox" ' +
		(enabled ? 'checked' : '') +
		' onchange="toggleGroup(' +
		idx +
		', this.checked)">' +
		'<span class="group-switch"></span>' +
		'<span class="toggle-label">' +
		(enabled ? '已启用' : '已禁用') +
		'</span>' +
		'</label>' +
		'</div>' +
		'<div class="rg-desc">' +
		'按节点名自动归类，批量生成 🇭🇰 香港 / 🇹🇼 台湾 / 🇯🇵 日本… 等地区分组。' +
		'这些地区分组会追加在下方分组之后，供「默认出口」选择。' +
		'</div>' +
		'<div class="rg-desc rg-tip">' +
		'💡 节点较多时建议开启：默认关闭是因为分组会随订阅里的地区数量增长，' +
		'节点少的订阅开着反而多出一堆只有一两个节点的分组。' +
		'</div>' +
		'<div class="rg-row">' +
		'<span class="rg-label">生成的地区组类型</span>' +
		'<select class="group-select" onchange="config.groups[' +
		idx +
		'].type=this.value;scheduleSave()" ' +
		(enabled ? '' : 'disabled') +
		'>' +
		'<option value="url-test" ' +
		(g.type !== 'select' ? 'selected' : '') +
		'>⚡ 自动测速（组内选最快）</option>' +
		'<option value="select" ' +
		(g.type === 'select' ? 'selected' : '') +
		'>👆 手动选择</option>' +
		'</select>' +
		'</div>' +
		'</div>';
}

function toggleGroup(index, enabled) {
	config.groups[index].enabled = enabled;
	renderGroups();
	scheduleSave();
}

function buildSavePayload() {
	var payload = JSON.parse(JSON.stringify(config));
	// scope / limits 是只读的身份信息与服务端上限，不能回传给服务端
	delete payload.scope;
	delete payload.limits;
	if (config.nodeFilter === 'hideDomestic') {
		payload.nodeFilters = { hideDomestic: true, hideInternational: false };
	} else if (config.nodeFilter === 'hideInternational') {
		payload.nodeFilters = { hideDomestic: false, hideInternational: true };
	} else {
		payload.nodeFilters = { hideDomestic: false, hideInternational: false };
	}
	delete payload.nodeFilter;
	if (!Array.isArray(payload.excludeKeywords)) payload.excludeKeywords = [];
	if (!Array.isArray(payload.subscriptions)) payload.subscriptions = [];
	return payload;
}

// ========== 自动保存 ==========
//
// 页面不再保留「改了但没保存」的草稿状态：任何改动（过滤方式 / 排除关键词 /
// 拉取 UA / 分组开关与选项）都会合并写回，因此不需要「加载配置」「保存配置」两个按钮。
//
// 写回的目标由服务端根据访问者 IP 决定：所有访问者（含本机）各写自己的
// guests/<IP>.json，只存与基准的差异。全局基准由部署人员直接编辑 config/default.json。
//
// 防抖的用处：自定义 UA 是逐字符触发的，关键词也可能连点，
// 300ms 合并后一次请求即可，同时保证快速连点最终只落盘最终状态。

var SAVE_DEBOUNCE_MS = 300;
var saveTimer = null;
var saveInFlight = false;
var saveDirty = false;
/** 显式保存（如「保存订阅地址」）的完成回调：成功传 null，失败传 Error */
var saveCallbacks = [];

/** 标记有改动并安排写回。所有修改配置的地方都必须调用它。 */
function scheduleSave() {
	saveDirty = true;
	setSaveState('pending');
	clearTimeout(saveTimer);
	saveTimer = setTimeout(autosave, SAVE_DEBOUNCE_MS);
}

/**
 * 立即写回（跳过防抖），完成后回调。
 *
 * 「保存订阅地址」是显式操作：用户点完必须马上落盘并给出结果，
 * 不能等 300ms 防抖后才知道成功与否。
 *
 * @param {Function} [done] (err: Error|null) => void
 */
function saveNow(done) {
	if (typeof done === 'function') saveCallbacks.push(done);
	clearTimeout(saveTimer);
	saveDirty = true;
	setSaveState('pending');
	autosave();
}

/** 通知所有等待者。队列在调用前清空，避免回调里再次触发保存时重复执行。 */
function flushSaveCallbacks(err) {
	var list = saveCallbacks;
	saveCallbacks = [];
	list.forEach(function (cb) {
		try {
			cb(err);
		} catch (e) {
			console.error(e);
		}
	});
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
			if (saveDirty) {
				// 飞行期间又改了 → 再写一次（等待者留在队列里，等最终那次完成）
				autosave();
				return;
			}
			setSaveState('ok');
			flushSaveCallbacks(null);
		})
		.catch(function (err) {
			saveInFlight = false;
			setSaveState('err', err.message);
			flushSaveCallbacks(err);
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
 *
 * 只用于**文本位置与属性值位置**（`>...</...>`、`value="..."`）。
 * 不能用来把值安全地嵌进内联事件（`onclick="f('...')"`）—— 属性解析时
 * `&#39;` 会还原成单引号，照样能闭合字符串。内联事件一律改用
 * data-* 属性 + 事件委托（见 initPresetClicks）。
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

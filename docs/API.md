# Clash 订阅转换器 API 文档

> Base URL: `http://localhost:25500`

---

## 目录

- [1. 订阅转换](#1-订阅转换)
  - [POST /api/convert](#post-apiconvert)
  - [POST /api/convert-file](#post-apiconvert-file)
  - [POST /api/parse](#post-apiparse)
- [2. 兼容端点](#2-兼容端点)
  - [GET /sub](#get-sub)
- [3. 用户配置](#3-用户配置)
  - [GET /api/config](#get-apiconfig)
  - [POST /api/config](#post-apiconfig)
- [4. 规则管理](#4-规则管理)
  - [GET /api/rules](#get-apirules)
  - [GET /api/rules/:id](#get-apirulesid)
  - [POST /api/rules](#post-apirules)
  - [PUT /api/rules/:id](#put-apirulesid)
  - [DELETE /api/rules/:id](#delete-apirulesid)
- [5. 页面路由](#5-页面路由)
- [6. 数据结构参考](#6-数据结构参考)

---

## 1. 订阅转换

### POST /api/convert

完整的订阅转换接口，支持多 URL、节点过滤、关键词排除。

**请求体** `application/json`

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `urls` | `string[]` | 是* | `[]` | 订阅链接列表，支持任意协议 (http/https/vmess/ss/trojan 等) |
| `rawContent` | `string` | 否 | — | 直接传入订阅原始内容，与 `urls` 二选一 |
| `nodeFilter` | `string` | 否 | `"all"` | 节点过滤模式：`"all"` / `"hideDomestic"` / `"hideInternational"` |
| `excludeKeywords` | `string[]` | 否 | `[]` | 排除关键词列表（大小写不敏感），含任一关键词的节点将被移除 |

> *当未提供 `rawContent` 时，`urls` 必填。

**成功响应** `200`

```json
{
  "yaml": "mixed-port: 7890\nallow-lan: true\n...",
  "summary": {
    "totalNodes": 25,
    "filteredNodes": 17,
    "groups": [
      {
        "name": "🚀 节点选择",
        "type": "select",
        "proxies": ["香港01", "日本02", "新加坡03"],
        "defaultProxy": "♻️ 自动选择"
      }
    ]
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `yaml` | `string` | 完整 Clash 配置 YAML |
| `summary.totalNodes` | `number` | 原始节点总数 |
| `summary.filteredNodes` | `number` | 过滤后可用节点数 |
| `summary.groups` | `array` | 分组摘要列表 |
| `summary.groups[].name` | `string` | 分组名称 |
| `summary.groups[].type` | `string` | 分组类型：`select` / `url-test` / `system` |
| `summary.groups[].proxies` | `string[]` | 该分组下的代理名称列表 |
| `summary.groups[].defaultProxy` | `string` | 该分组的默认出口 |

`summary.groups` 末尾固定包含两个 `system` 类型条目：
- `🏠 本地路由` — 局域网 / 私有 IP / 路由器 / DDNS → DIRECT
- `🌐 GEOIP 国内直连` — GEOIP,CN → DIRECT

**错误响应**

| 状态码 | 说明 |
|--------|------|
| `400` | 缺少订阅链接 / 无法获取内容 / 无有效节点 |
| `500` | 转换异常 |

**示例**

```bash
curl -X POST http://localhost:25500/api/convert \
  -H "Content-Type: application/json" \
  -d '{
    "urls": ["https://sub.example.com/link"],
    "nodeFilter": "hideDomestic",
    "excludeKeywords": ["流量", "免费", "测试"]
  }'
```

---

### POST /api/convert-file

直接传入订阅原始内容进行转换（适合文件上传场景）。

**请求体** `application/json`

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `content` | `string` | 是 | 订阅原始内容（base64 编码的 URI 列表 或 Clash YAML） |

**成功响应** `200`

```json
{
  "yaml": "mixed-port: 7890\n...",
  "count": 25
}
```

**示例**

```bash
curl -X POST http://localhost:25500/api/convert-file \
  -H "Content-Type: application/json" \
  -d '{"content": "dm1lc3M6Ly9leUoySWpw...（Base64 订阅内容）"}'
```

---

### POST /api/parse

仅解析订阅链接，返回节点列表（不生成配置）。

**请求体** `application/json`

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `url` | `string` | 是 | 订阅链接 |

**成功响应** `200`

```json
{
  "nodes": [
    { "name": "香港 01 | 1x", "type": "vmess", "region": "🌐 其他" },
    { "name": "上海 CT", "type": "ss", "region": "🇨🇳 中国大陆" }
  ],
  "total": 2
}
```

---

## 2. 兼容端点

### GET /sub

兼容 subconverter 调用格式，专供 OpenClash 等客户端使用。支持多 URL（`|` 分隔）。

**查询参数**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `target` | `string` | 否 | `"clash"` | 输出格式：`"clash"` / `"surge"` |
| `url` | `string` | 是 | — | 订阅链接，多个用 `\|` 分隔 |
| `include` | `string` | 否 | — | 指定启用的规则（逗号分隔） |
| `exclude` | `string` | 否 | — | 指定禁用的规则（逗号分隔） |
| `emoji` | `string` | 否 | — | 是否保留 emoji |
| `udp` | `string` | 否 | — | 是否启用 UDP |
| `config` | `string` | 否 | — | 外部配置模板 URL |

**成功响应** `200` — 直接返回 YAML 文本 (`Content-Type: text/yaml`)

**示例**

```bash
curl "http://localhost:25500/sub?target=clash&url=https://sub1.example.com|https://sub2.example.com&include=openai,netflix"
```

---

## 3. 用户配置

### GET /api/config

获取当前用户配置。首次访问时自动返回默认配置。

**成功响应** `200`

```json
{
  "subscriptions": [
    { "url": "https://sub.example.com/link", "name": "我的订阅" }
  ],
  "groups": [
    {
      "builtin": "select",
      "name": "🚀 节点选择",
      "type": "select",
      "defaultProxy": "♻️ 自动选择"
    },
    {
      "ruleId": "apple",
      "name": "🍎 Apple 服务",
      "type": "select",
      "enabled": true,
      "defaultProxy": "DIRECT"
    }
  ],
  "nodeFilters": {
    "hideDomestic": true,
    "hideInternational": false
  },
  "excludeKeywords": [
    "流量", "官网", "套餐", "到期", "剩余"
  ]
}
```

**默认值**：如果配置不存在或为空，系统自动返回以下默认值：

| 字段 | 默认值 |
|------|--------|
| `nodeFilters.hideDomestic` | `true`（默认隐藏国内节点） |
| `nodeFilters.hideInternational` | `false` |
| `excludeKeywords` | 22 个预设关键词（流量、官网、套餐、到期、剩余、应急、免费、测试、失效、过期、活动、优惠、推荐、广告、回国、禁止、ipv6、中转、隧道、倍率、专线、-----） |
| `groups` | 从 `config/rules/*.json` 自动生成全部规则分组 |

---

### POST /api/config

保存用户配置。

**请求体** `application/json`

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `subscriptions` | `array` | 否 | 订阅链接列表 |
| `groups` | `array` | **是** | 分组配置列表（见下方 Group 结构） |
| `nodeFilters` | `object` | 否 | 节点过滤设置 |
| `excludeKeywords` | `string[]` | 否 | 排除关键词列表 |

**Group 结构**

| 字段 | 类型 | 说明 |
|------|------|------|
| `builtin` | `string` | 内置分组标识：`"select"` / `"auto"` / `"domestic"` / `"fallback"` |
| `ruleId` | `string` | 规则分组标识（对应 `config/rules/*.json` 文件名） |
| `name` | `string` | 分组显示名称 |
| `type` | `string` | 分组类型：`"select"` / `"url-test"` |
| `enabled` | `boolean` | 是否启用（内置分组和 must 分组不受影响） |
| `defaultProxy` | `string` | 默认出口节点名称 |

> `builtin` 和 `ruleId` 互斥 —— 内置分组用 `builtin`，规则分组用 `ruleId`。

**成功响应** `200`

```json
{ "success": true }
```

**错误响应**

| 状态码 | 说明 |
|--------|------|
| `400` | 无效的配置格式（缺少 `groups` 数组） |
| `500` | 保存失败 |

---

## 4. 规则管理

### GET /api/rules

获取所有分流规则定义。

**成功响应** `200`

```json
[
  {
    "id": "apple",
    "name": "🍎 Apple 服务",
    "type": "select",
    "rules": [
      "DOMAIN-SUFFIX,apple.com",
      "DOMAIN-SUFFIX,icloud.com",
      "IP-CIDR,17.0.0.0/8"
    ]
  },
  {
    "id": "microsoft",
    "name": "Ⓜ️ 微软服务",
    "type": "select",
    "rules": [
      "DOMAIN-SUFFIX,office.com",
      "DOMAIN-KEYWORD,microsoft"
    ]
  }
]
```

> 系统规则 `common`（本地路由）不在此列表中，它始终生效且不可配置。

---

### GET /api/rules/:id

获取单个规则详情。

**路径参数**

| 参数 | 说明 |
|------|------|
| `:id` | 规则 ID（对应 `config/rules/*.json` 文件名） |

**成功响应** `200`

```json
{
  "id": "openai",
  "name": "🤖 OpenAI",
  "type": "select",
  "rules": [
    "DOMAIN-SUFFIX,openai.com",
    "DOMAIN-SUFFIX,chatgpt.com",
    "DOMAIN-SUFFIX,oaistatic.com"
  ]
}
```

**错误响应**

| 状态码 | 说明 |
|--------|------|
| `404` | 规则不存在 |

---

### POST /api/rules

创建新规则。

**请求体** `application/json`

```json
{
  "id": "myrule",
  "name": "🔧 自定义规则",
  "type": "select",
  "rules": [
    "DOMAIN-SUFFIX,example.com",
    "IP-CIDR,10.0.0.0/8"
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | `string` | 是 | 规则唯一标识（用作文件名） |
| `name` | `string` | 是 | 规则显示名称 |
| `type` | `string` | 否 | 分组类型，默认 `"select"` |
| `rules` | `string[]` | 是 | Clash 规则数组 |

**成功响应** `200` — 返回创建的规则对象

**错误响应**

| 状态码 | 说明 |
|--------|------|
| `400` | 规则已存在 / 参数无效 |

---

### PUT /api/rules/:id

更新已有规则。

**请求体** 同 POST，所有字段可选（只更新提供的字段）。

**成功响应** `200` — 返回更新后的规则对象

---

### DELETE /api/rules/:id

删除规则。

> `common`（系统规则）不可删除。

**成功响应** `200`

```json
{ "success": true }
```

---

## 5. 页面路由

| 路由 | 说明 |
|------|------|
| `GET /` | 首页（订阅转换） |
| `GET /config` | 配置管理页面 |
| `GET /test/sub` | 🧪 本地测试订阅（返回 `中国国际机场.yaml` 原始内容） |

---

## 6. 数据结构参考

### 节点过滤模式

| `nodeFilter` 值 | 效果 |
|-----------------|------|
| `"all"` | 不过滤，保留全部节点 |
| `"hideDomestic"` | 隐藏国内节点（默认行为） |
| `"hideInternational"` | 仅保留国内节点 |

> 国内节点判定：节点名称含中国大陆地区关键词（如 中国、北京、上海、广东、CN 等）。

### 默认排除关键词

共 22 个预设项：

```
流量, 官网, 套餐, 到期, 剩余, 应急, 免费, 测试, 失效, 过期,
活动, 优惠, 推荐, 广告, 回国, 禁止, ipv6, 中转, 隧道, 倍率,
专线, -----
```

> 匹配为大小写不敏感。`-----` 用于屏蔽名称为分隔线的节点。

### 支持的代理协议

| 协议 | 格式 |
|------|------|
| VMess | `vmess://base64` |
| Shadowsocks | `ss://base64` |
| ShadowsocksR | `ssr://base64` |
| Trojan | `trojan://...` |
| VLESS | `vless://...` |
| Hysteria2 | `hysteria2://...` / `hy2://...` |
| Clash YAML | 含 `proxies:` 数组的完整配置 |

### 完整 Clash 配置结构

生成的 YAML 包含以下顶层字段：

```yaml
mixed-port: 7890
allow-lan: true
bind-address: '*'
mode: rule
log-level: info
external-controller: 127.0.0.1:46011
dns: {...}             # 来自 config/dns.json
proxies: [...]         # 过滤后的节点列表
proxy-groups: [...]    # 用户配置的分组 + 系统分组
rules: [...]           # 分流规则（含 GEOIP,CN,DIRECT + 本地路由）
```

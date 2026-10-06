# Clash 订阅转换器

自部署的代理订阅转换服务，将 VMess / SS / SSR / Trojan / VLESS / Hysteria2 订阅转换为 Clash 配置文件，附带 Web 配置界面、智能分组和 17 组分流规则。

> 替代第三方转换服务，订阅数据不经过外部服务器，安全可控。

## 功能特性

- **多协议解析** — 支持 7 种代理协议，自动识别 Base64 / YAML 格式
- **智能分组** — 根据节点名称自动识别 22 个地区，生成 url-test 分组
- **17 组分流规则** — 覆盖 AI、流媒体、游戏、社交通讯等主流服务
- **Web 配置界面** — 可视化管理过滤规则、分组策略、排除关键词
- **RESTful API** — 完整的 CRUD 接口，支持规则管理、配置持久化
- **OpenClash 兼容** — 提供 `/sub` 端点，可直接填入 OpenClash 使用
- **拉取 UA 可配置** — 可透传客户端 UA 或指定预设，避免机场误判为「订阅地址泄漏」
- **订阅信息透传** — 转发机场的流量 / 到期 / 官网 / 订阅名响应头，Clash Verge 等客户端可正常显示订阅详情
- **节点过滤** — 支持隐藏国内/国际节点、22 个预设关键词排除
- **本地路由** — 内置局域网 / 私有 IP / GEOIP 直连规则，无需额外配置

## 快速开始

### 环境要求

- Node.js ≥ 18
- npm ≥ 9

### 部署安装

```bash
git clone https://github.com/xiaoan-1/clash-sub-converter.git

cd clash-sub-converter

npm install
```

### 进程管理

```bash
npm start        # 启动
npm run restart  # 重启
npm run stop     # 停止
npm run logs     # 查看日志
npm run status   # 状态
```


### 开发模式

```bash
npm run dev
```

## 项目结构

```
clash-sub-converter/
├── index.js                   # 入口（HTTP 服务）
├── package.json
├── ecosystem.config.js        # PM2 配置
├── config/
│   ├── default.json           # 基准配置（21 个分组定义，纳入版本控制）
│   ├── config.json            # 用户配置（仅存差异，被 .gitignore 忽略）
│   ├── regions.json           # 地区分组（22 个地区）
│   └── rules/                 # 分流规则（18 个 JSON 文件）
│       ├── common.json        # 系统规则（本地路由，始终生效）
│       ├── apple.json         # 🍎 Apple 服务
│       ├── microsoft.json     # Ⓜ️ 微软服务
│       ├── openai.json        # 🤖 OpenAI
│       ├── claude.json        # 🤖 Claude
│       ├── gemini.json        # 🤖 Gemini
│       ├── telegram.json      # 💬 Telegram
│       ├── youtube.json       # 📺 YouTube
│       ├── netflix.json       # 🎬 Netflix
│       ├── disney.json        # 🎥 Disney+
│       ├── dazn.json          # 📺 Dazn
│       ├── bilibili.json      # 📺 哔哩哔哩
│       ├── bahamut.json       # 🎮 巴哈姆特
│       ├── github.json        # ⌨️ GitHub
│       ├── pixiv.json         # 🎨 Pixiv
│       ├── steam-store.json   # 🎮 Steam 商店/社区
│       ├── steam-download.json # 🎮 Steam 下载/联机
│       └── mihoyo.json        # ⭕️💰 miHoYo
├── src/
│   ├── parser.js              # 订阅解析器（7 种协议）
│   ├── proxy-groups.js        # 智能代理分组
│   ├── rule-manager.js        # 规则管理器
│   ├── converter.js           # 转换引擎 → Clash YAML
│   ├── api.js                 # API 路由
│   ├── user-config.js         # 用户配置读写（default.json + config.json 合并）
│   ├── user-agents.js         # 拉取订阅的 UA 预设与解析
│   └── utils.js               # 工具函数
├── public/
│   ├── index.html             # 首页（使用说明）
│   ├── config.html            # 配置页面
│   ├── config.css             # 配置页样式
│   └── config.js              # 配置页逻辑
└── docs/
    ├── 接口文档.md            # API 接口文档
    ├── 主流程详解.md           # 端到端流程详解
    ├── 数据流架构.md           # 完整数据流图
    ├── 代理协议解析.md         # 各协议解析结果结构
    ├── 配置文件格式说明.md     # 输入输出格式规范
    └── 配置组装详解.md         # converter.js 内部细节
```

## API 接口

完整 API 文档见 [docs/接口文档.md](docs/接口文档.md)，核心端点：

| 方法 | 端点 | 说明 |
|------|------|------|
| `POST` | `/api/convert` | 完整转换（支持多 URL、过滤参数） |
| `POST` | `/api/convert-file` | 直接传入订阅内容转换 |
| `POST` | `/api/parse` | 解析订阅，返回节点列表 |
| `GET` | `/sub` | OpenClash 兼容端点 |
| `GET/POST` | `/api/config` | 用户配置读写 |
| `GET` | `/api/user-agents` | 可选客户端 UA 预设列表 |
| `GET/POST` | `/api/rules` | 分流规则管理 |
| `GET/PUT/DELETE` | `/api/rules/:id` | 单条规则 CRUD |

### 快速示例

```bash
# API 完整转换
curl -X POST http://127.0.0.1:25500/api/convert \
  -H "Content-Type: application/json" \
  -d '{"urls":["https://sub.example.com/link"]}'

# OpenClash 兼容端点
curl "http://127.0.0.1:25500/sub?target=clash&url=https://sub.example.com/link"

# 指定拉取 UA（若默认透传的 UA 被机场拦截）
curl "http://127.0.0.1:25500/sub?target=clash&ua=clash-verge%2Fv2.0.0&url=https://sub.example.com/link"
```

## 订阅拉取 UA

转换器代替客户端去拉取机场订阅，机场看到的是**转换器发出的 UA**，而非你实际客户端的 UA。
若两者不一致（例如你用 Clash Verge，转换器却以 `ClashForAndroid` 拉取），
部分机场的安全规则会判定为「非本人操作 / 订阅地址可能已泄露」，进而**作废订阅地址**并发送提醒邮件。

因此拉取 UA 可配置，在「配置界面 → 订阅拉取设置」中调整：

| 模式 | 行为 |
|------|------|
| **跟随调用方（推荐）** | 调用方是已知代理客户端时，把其 UA 原样转发给机场，转换器对外完全透明；浏览器 / `curl` / `node` 等非客户端请求回退到 Clash Verge |
| **预设客户端** | 固定使用某个客户端的 UA（Clash Verge / OpenClash / mihomo / Clash for Windows / Stash / Shadowrocket …） |
| **自定义** | 手动填写。用抓包得到的真实 UA 最准确 |

优先级：`?ua=` 查询参数 > 配置中的模式 > 默认（Clash Verge）。

> 若你的机场对 UA 校验较严，请先在客户端或路由器上抓包，拿到真实 UA 后选「自定义」填入。

## 订阅信息（流量 / 到期）

机场把订阅的流量、到期时间、官网地址等信息放在 **HTTP 响应头**里，而不是 YAML 正文中。
若转换器只转发正文，Clash Verge / ClashX 等客户端的订阅详情页就会是空白，也无法一键跳转机场官网。

`/sub` 现已转发下列响应头：

| 响应头 | 作用 |
|--------|------|
| `subscription-userinfo` | 已用 / 总流量与到期时间（客户端展示的核心数据） |
| `profile-web-page-url` | 机场官网入口 |
| `profile-update-interval` | 客户端自动更新间隔 |
| `Content-Disposition` | 订阅名称 |

多订阅（`|` 分隔）合并时，流量累加、到期取最早；同名节点只保留一个。

> 转换器终端会打印 `[sub] 已转发订阅信息: ...`。若显示「订阅源未下发流量 / 到期信息」，
> 说明该机场本就不提供这些头，与转换器无关。

## 支持的协议

| 协议 | 格式 | 传输层 |
|------|------|--------|
| VMess | `vmess://` | WS / H2 / gRPC / HTTP |
| Shadowsocks | `ss://` | SIP002 + 旧格式 |
| ShadowsocksR | `ssr://` | — |
| Trojan | `trojan://` | WS / gRPC |
| VLESS | `vless://` | WS / gRPC |
| Hysteria2 | `hysteria2://` / `hy2://` | — |
| Clash YAML | 含 `proxies:` 的完整配置 | — |

## 节点过滤

配置页面提供三种过滤模式：

| 模式 | 效果 |
|------|------|
| 全部节点 | 保留所有 |
| 隐藏国内 | 移除中国大陆节点（**默认**） |
| 隐藏国际 | 仅保留中国大陆节点 |

### 排除关键词（22 个预设）

名称含以下关键词的节点将被过滤（大小写不敏感）：

> 流量、官网、套餐、到期、剩余、应急、免费、测试、失效、过期、活动、优惠、推荐、广告、回国、禁止、ipv6、中转、隧道、倍率、专线、-----

可在配置页面或 API 中自定义。

## 代理分组

由 `config/regions.json` 定义 22 个地区，自动根据节点名称匹配并生成分组：

> 香港、台湾、日本、韩国、新加坡、美国、英国、德国、法国、加拿大、澳大利亚、印度、泰国、马来西亚、印尼、菲律宾、越南、俄罗斯、荷兰、土耳其、巴西、阿根廷

## 分流规则

18 个规则文件位于 `config/rules/`（17 个可配置服务分组 + 系统本地路由 `common.json`），可通过配置页面或 API 启用/禁用：

| 规则组 | 包含内容 |
|--------|----------|
| 🍎 Apple 服务 | apple.com、icloud.com、iTunes、App Store IP 段（默认 DIRECT） |
| Ⓜ️ 微软服务 | office.com、azure.com、xbox.com、Windows 更新（默认 DIRECT） |
| 🤖 OpenAI | openai.com、chatgpt.com、oaistatic.com |
| 🤖 Claude | anthropic.com、claude.ai |
| 🤖 Gemini | gemini.google.com、generativelanguage.googleapis.com |
| 💬 Telegram | telegram.org、t.me、Telegram CDN / IP 段 |
| 📺 YouTube | youtube.com、googlevideo.com、ytimg.com |
| 🎬 Netflix | netflix.com、nflximg.net、Netflix IP 段 |
| 🎥 Disney+ | disneyplus.com、disney.com、bamgrid.com |
| 📺 Dazn | dazn.com、daznservices.com |
| 📺 哔哩哔哩 | bilibili.com、hdslb.com、bilivideo.com |
| 🎮 巴哈姆特 | bahamut.com.tw、gamer.com.tw |
| ⌨️ GitHub | github.com、githubusercontent.com、githubassets.com |
| ⭕️💰 miHoYo | mihoyo.com、hoyoverse.com、yuanshen.com |
| 🎨 Pixiv | pixiv.net、pximg.net、fanbox.cc、booth.pm |
| 🎮 Steam 商店/社区 | steampowered.com、steamcommunity.com、steamstatic.com（默认 ♻️ 自动选择） |
| 🎮 Steam 下载/联机 | steamcontent.com、steamgames.com、qtlglb.com（默认 DIRECT） |
| 🏠 本地路由 | 局域网、私有 IP、路由器、DDNS、GEOIP 国内（始终生效、不可配置） |

## 在 OpenClash 中使用

1. 启动本服务
2. OpenClash → 全局设置 → 订阅转换
3. 订阅转换服务地址填入：`http://你的IP:25500/sub?target=clash&url=`
4. 原始订阅链接会自动拼接

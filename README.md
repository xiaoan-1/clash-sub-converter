# Clash 订阅转换器

自部署的代理订阅转换服务，将 VMess / SS / SSR / Trojan / VLESS / Hysteria2 订阅转换为 Clash 配置文件，附带 Web 配置界面、智能分组和 15 组分流规则。

> 替代第三方转换服务，订阅数据不经过外部服务器，安全可控。

## 功能特性

- **多协议解析** — 支持 7 种代理协议，自动识别 Base64 / YAML 格式
- **智能分组** — 根据节点名称自动识别 22 个地区，生成 url-test 分组
- **15 组分流规则** — 覆盖 AI、流媒体、游戏、社交通讯等主流服务
- **Web 配置界面** — 可视化管理过滤规则、分组策略、排除关键词
- **RESTful API** — 完整的 CRUD 接口，支持规则管理、配置持久化
- **OpenClash 兼容** — 提供 `/sub` 端点，可直接填入 OpenClash 使用
- **节点过滤** — 支持隐藏国内/国际节点、22 个预设关键词排除
- **本地路由** — 内置局域网 / 私有 IP / GEOIP 直连规则，无需额外配置

## 快速开始

### 环境要求

- Node.js ≥ 18
- npm ≥ 9

### 安装

```bash
git clone <repo-url>
cd clash-sub-converter
npm install
```

### 启动

```bash
npm start
```

服务运行在 `http://127.0.0.1:25500`。浏览器访问 `/config` 进入配置页面。

### 开发模式

```bash
node index.js --server
```

### 命令行转换

```bash
node index.js <订阅文件.yaml>
```

## 项目结构

```
clash-sub-converter/
├── index.js                   # 入口（HTTP 服务 + CLI）
├── package.json
├── ecosystem.config.js        # PM2 配置
├── config/
│   ├── dns.json               # DNS 配置
│   ├── regions.json           # 地区分组（22 个地区）
│   └── rules/                 # 分流规则（15 个 JSON 文件）
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
│       └── mihoyo.json        # ⭕️💰 miHoYo
├── src/
│   ├── parser.js              # 订阅解析器（7 种协议）
│   ├── proxy-groups.js        # 智能代理分组
│   ├── rule-manager.js        # 规则管理器
│   ├── converter.js           # 转换引擎 → Clash YAML
│   ├── api.js                 # API 路由
│   └── utils.js               # 工具函数
├── public/
│   ├── index.html             # 首页（使用说明）
│   ├── config.html            # 配置页面
│   ├── config.css             # 配置页样式
│   └── config.js              # 配置页逻辑
└── docs/
    ├── API.md                 # API 接口文档
    ├── 主流程详解.md
    ├── 数据流通路径.md
    ├── 协议解析输出.md
    ├── 格式说明.md
    └── 配置组装过程.md
```

## API 接口

完整 API 文档见 [docs/API.md](docs/API.md)，核心端点：

| 方法 | 端点 | 说明 |
|------|------|------|
| `POST` | `/api/convert` | 完整转换（支持多 URL、过滤参数） |
| `POST` | `/api/convert-file` | 直接传入订阅内容转换 |
| `POST` | `/api/parse` | 解析订阅，返回节点列表 |
| `GET` | `/sub` | OpenClash 兼容端点 |
| `GET/POST` | `/api/config` | 用户配置读写 |
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

# CLI 本地转换
node index.js 订阅文件.yaml
```

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

15 组分流规则位于 `config/rules/`，可通过配置页面或 API 启用/禁用：

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
| 🏠 本地路由 | 局域网、私有 IP、路由器、DDNS、GEOIP 国内（始终生效、不可配置） |

## 在 OpenClash 中使用

1. 启动本服务
2. OpenClash → 全局设置 → 订阅转换
3. 订阅转换服务地址填入：`http://你的IP:25500/sub?target=clash&url=`
4. 原始订阅链接会自动拼接

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | `25500` |

## PM2 管理

```bash
npm start        # 启动
npm run restart  # 重启
npm run stop     # 停止
npm run logs     # 查看日志
npm run status   # 状态
```

## 依赖

- [express](https://expressjs.com/) — HTTP 框架
- [js-yaml](https://github.com/nodeca/js-yaml) — YAML 序列化

## License

MIT

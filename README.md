# Clash 订阅转换器

自部署的代理订阅转换服务，把机场订阅转换为带智能分组与分流规则的 Clash 配置，
并提供 Web 配置界面。订阅数据全程在本机处理，不经过任何第三方服务器。

## 功能特性

- **多协议支持** — 支持 14 种代理协议，自动识别 Base64 / YAML 格式
- **智能分组** — 按节点名称自动识别 22 个地区，生成延迟测速（url-test）分组
- **18 组分流规则** — 覆盖 AI、流媒体、游戏、社交通讯等主流服务
- **Web 配置界面** — 可视化调整节点过滤、分组策略与排除关键词
- **OpenClash 兼容** — 提供 `/sub` 端点，直接填入 OpenClash 即可使用
- **拉取 UA 可配置** — 可透传客户端 UA 或指定预设，避免机场误判为「订阅地址泄漏」
- **订阅信息透传** — 转发机场的流量 / 到期 / 官网 / 订阅名，客户端可正常显示订阅详情
- **节点过滤** — 支持隐藏国内 / 国际节点，以及 22 个预设关键词排除
- **本地路由** — 内置局域网 / 私有 IP / GEOIP 直连规则，无需额外配置

## 快速开始

### 环境要求

- Node.js ≥ 18
- npm ≥ 9

### 安装

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
npm run log      # 查看日志
npm run status   # 状态
```

启动后终端会打印访问地址，浏览器打开即可进入使用说明页与配置界面。

### 日志

转换全流程的日志写在 `logs/app.log`（全量）与 `logs/error.log`（仅 WARN / ERROR），
每一行都带毫秒时间戳与请求编号。排查方法与级别控制见
[docs/日志与排查.md](docs/日志与排查.md)。

> 若订阅转换正常、但导入 OpenClash 后**节点全部无法使用**，多半是客户端 DNS 问题
> （而非本项目）—— 见 [docs/OpenClash-DNS排查.md](docs/OpenClash-DNS排查.md)。

## 在 OpenClash 中使用

1. 启动本服务
2. OpenClash → 全局设置 → 订阅转换
3. 订阅转换服务地址填入：`http://你的IP:25500/sub`（只填到 `/sub`，`target` 与 `url` 由 OpenClash 自动拼接）
   - 服务挂在子路径时（`BASE_PATH=/clash`）填 `https://你的域名/clash/sub`
4. 原始订阅链接会自动拼接

## 配置界面

浏览器打开配置界面，可以可视化调整以下内容，保存后立即生效：

- **订阅拉取设置** — 拉取订阅时使用的 UA（见下方[订阅拉取 UA](#订阅拉取-ua)）
- **节点过滤** — 隐藏国内 / 国际节点、排除关键词
- **代理分组** — 启用 / 停用各规则分组，设置分组默认出口

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

`/sub` 会转发下列响应头：

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
| Hysteria | `hysteria://` | UDP |
| AnyTLS | `anytls://` | — |
| TUIC | `tuic://` | QUIC |
| Snell | `snell://` | — |
| SOCKS5 | `socks5://` / `socks://` | — |
| HTTP | `http://` / `https://` | TLS |
| WireGuard | `wireguard://` / `wg://` | — |
| ShadowQUIC | `shadowquic://` | QUIC |
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

可在配置页面中自定义。

## 代理分组

按节点名称自动识别 22 个地区，生成 url-test 分组（仅对订阅中实际出现的地区建组）：

> 香港、台湾、日本、韩国、新加坡、美国、英国、德国、法国、加拿大、澳大利亚、印度、泰国、马来西亚、印尼、菲律宾、越南、俄罗斯、荷兰、土耳其、巴西、阿根廷

另含三个必备分组：`🚀 节点选择`、`♻️ 自动选择`、`🐟 漏网之鱼`，以及存在国内节点时的 `🇨🇳 中国大陆` 分组。

> 地区识别遵循「先匹配具体地区、再判断国内」：`[台湾省] 中华电信` 会归入 `🇹🇼 台湾` 而非国内。
> 短英文关键词（CN / IN / HK …）按词边界匹配，`CN2 GIA` 不会被误判为国内节点。

## 分流规则

18 个规则文件（17 个可配置服务分组 + 系统本地路由 `common.json`），可在配置页面启用 / 停用：

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

## 多用户部署（按访问者 IP 隔离）

部署到公网后，**任何访问者改配置都会影响所有人**。本服务按访问者 IP 拆分配置，
一个访客一份文件，互不影响：

| 文件 | 说明 |
|------|------|
| `config/default.json` | **基准配置** —— 由**部署人员直接编辑文件**维护，纳入版本控制 |
| `guests/<访客ID>.json` | **访客配置** —— 只存与基准的差异 |

生效顺序：`config/default.json` ← `guests/<ID>.json`，后者覆盖前者。

- **所有访问者一视同仁**（含本机 `127.0.0.1`）：首次保存配置时自动创建
  `guests/<IP>.json`，初始内容为空差异，即完全继承基准。只打开配置页看看、
  不改任何东西，不会留下文件。
- **想改全局配置**：直接编辑 `config/default.json`（改完重启服务生效）。
  基准是部署决策，不通过 Web 界面修改。
- **只存差异**：访客把某项改回与基准相同时，该字段会从访客文件里删掉，
  于是重新跟随基准后续的改动。
- 删掉 `guests/<IP>.json` 即重置该访客，**不用重启服务**。

配置页顶栏会显示当前改的是哪一份（`👤 访客 · guests/1.2.3.4.json · 1.2.3.4`）。

### 部署在反向代理后面（必看）

若前面有 Nginx / Caddy，**必须**设置 `TRUST_PROXY`，否则 `req.ip` 恒为 `127.0.0.1`，
所有访客会被当成同一个人：

```js
// ecosystem.config.js -> env
TRUST_PROXY: 'loopback',     // 只信任来自回环地址的代理头
```

| `TRUST_PROXY` | 含义 |
|---------------|------|
| 留空 / `0` / `false` | 关闭（默认）。只取 TCP 连接来源地址，`X-Forwarded-For` 被完全忽略 |
| `1` / `true` | 信任最近一跳（两者都按数字 `1` 处理） |
| `loopback` | 只信任回环地址发来的代理头（推荐） |
| `10.0.0.0/8` | 信任指定网段 |
| `2` | 信任前 2 跳 |

> ⚠️ 开启后 `req.ip` 来自 `X-Forwarded-For`，是**攻击者可控输入**。客户端可以伪造 IP
> 冒充别人的配置，所以**前面没有代理时请保持关闭**。
>
> ⚠️ 想只信任一跳请写 `'1'` 或 `'loopback'`，**别写布尔 `true`**：`true` 在 Express 里是
> 「信任**所有**跳」，`req.ip` 会取 `X-Forwarded-For` 的**最左**值 —— 那正是客户端自己填的
> 那一项，任何人都能伪造 IP 冒充他人配置。

### 已知限制

同一出口 IP 的人**共用一份配置**（家里多台设备、公司 NAT 出口都一样）—— 这是按 IP
区分的固有代价。要严格区分得改用路径标识或登录态。

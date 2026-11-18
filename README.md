# Clash 订阅转换器

自部署的代理订阅转换服务，把机场订阅转换为带智能分组与分流规则的 Clash 配置，
并提供 Web 配置界面。订阅数据全程在本机处理，不经过任何第三方服务器。

## 功能特性

- **多协议支持** — 支持 14 种代理协议，自动识别 Base64 / YAML 格式
- **智能分组** — 按节点名称自动识别 35 个地区，生成延迟测速（url-test）分组
- **18 组分流规则** — 覆盖 AI、流媒体、游戏、社交通讯等主流服务
- **Web 配置界面** — 可视化调整节点过滤、分组策略与排除关键词
- **OpenClash 兼容** — 提供 `/sub` 端点，直接填入 OpenClash 即可使用
- **拉取 UA 可配置** — 可透传客户端 UA 或指定预设，避免机场误判为「订阅地址泄漏」
- **订阅信息透传** — 转发机场的流量 / 到期 / 官网 / 订阅名，客户端可正常显示订阅详情
- **节点过滤** — 支持隐藏国内 / 国际节点，以及 22 个预设关键词排除
- **本地路由** — 内置局域网 / 私有 IP / GEOIP 直连规则，无需额外配置

## 快速开始

### 环境要求

- Node.js ≥ 18（代码依赖内置 `fetch` 与 `AbortSignal.timeout`）
- pnpm ≥ 8（本项目统一用 pnpm，`pnpm-lock.yaml` 已纳入版本控制）

### 安装

```bash
git clone https://github.com/xiaoan-1/clash-sub-converter.git

cd clash-sub-converter

pnpm install
```

### 进程管理

```bash
pnpm start        # 启动
pnpm run restart  # 重启
pnpm run stop     # 停止
pnpm run log      # 查看日志
pnpm run status   # 状态
```

启动后终端会打印访问地址，浏览器打开即可进入使用说明页与配置界面。

输出分两段：**本机地址**（`127.0.0.1`，永远可用）在最上面；
下面列出本机所有网卡的 IPv4 地址并标注网卡名 ——
给手机或路由器填地址时，选与目标设备**同一网段**的那个。

### 日志

转换全流程的日志写在 `logs/app.log`（全量）与 `logs/error.log`（仅 WARN / ERROR），
每一行都带毫秒时间戳与请求编号。排查方法与级别控制见
[docs/日志与排查.md](docs/日志与排查.md)。

> 若订阅转换正常、但导入 OpenClash 后**节点全部无法使用**，多半是客户端 DNS 问题
> （而非本项目）—— 见 [docs/OpenClash-DNS排查.md](docs/OpenClash-DNS排查.md)。

### 运行限制与安全开关

以下环境变量都可选，不设时使用括号内的默认值：

| 变量 | 默认 | 作用 |
|---|---|---|
| `HOST` | `0.0.0.0` | 监听地址。只在 nginx 后面时建议改 `127.0.0.1` |
| `PORT` | `25500` | 监听端口 |
| `BASE_PATH` | 空 | 子路径部署，例如 `/clash` |
| `TRUST_PROXY` | 关闭 | 反向代理下必须设置（如 `loopback`），否则所有访客算同一个 IP |
| `ALLOW_PRIVATE_URL` | 关闭 | 允许订阅地址指向内网 / 回环。默认禁止（SSRF 防护），仅在本机订阅场景才打开 |
| `MAX_SUB_URLS` | `10` | 单次请求最多接受的订阅份数 |
| `SUB_TOTAL_TIMEOUT_MS` | `60000` | 单次请求拉取全部订阅的总耗时预算，超出的剩余订阅直接判失败 |
| `MAX_SUB_BYTES` | `32MB` | 单份订阅正文体积上限，超限返回 400 |
| `MAX_CONCURRENT_CONVERTS` | `4` | 同时进行的转换请求数，超出返回 503（`Retry-After: 5`） |
| `MAX_GUESTS` | `1000` | 访客配置文件数量上限 |
| `BODY_LIMIT` | `10mb` | 请求体上限（粘贴订阅内容时用） |
| `LOG_LEVEL` / `LOG_CONSOLE_LEVEL` | `debug` / `info` | 写盘与控制台的日志级别 |
| `LOG_MAX_BYTES` / `LOG_MAX_FILES` | `5MB` / `3` | 日志轮转阈值与保留的历史份数 |

> **SSRF 防护**：订阅地址只允许 `http` / `https`，且会拒绝回环、私有网段、
> link-local（含云元数据 `169.254.169.254`）以及 IPv4-mapped IPv6 等写法。
> 重定向会逐跳重新校验，域名还会在解析后复查一次解析结果。

### 测试（pnpm test）

生成的配置存在一些**只有内核才能发现的语义约束**，例如分组循环引用、
规则指向已关闭的分组 —— 这两类问题都会让 mihomo 直接拒绝加载整份配置，
而从 YAML 上看不出任何异常。因此测试直接交给真实内核判定：

```bash
pnpm test
```

首次运行会按当前平台/架构自动下载 mihomo 到 `tools/`（约 23MB，已 gitignore），
之后直接复用，无需任何手动准备。全部通过时退出码 0，可直接接进 CI。

| 环境变量 | 说明 |
|---|---|
| `MIHOMO_VERSION` | 指定版本，如 `v1.19.32`（默认取 latest） |
| `MIHOMO_FORCE_DOWNLOAD` | 设 `1` 强制重新下载 |
| `GITHUB_TOKEN` | 带上令牌，避免匿名调用 GitHub API 的限流 |

用 `samples/mock-sub.yaml`（随仓库提交，覆盖 14 种协议与各类地区/命名边界）
跑 8 组配置组合（默认 / 地区组开关 / 规则组全关 / 空配置…）。
若本地存在 `samples/订阅.txt`（真实订阅，不入库），会额外用它再跑一轮。

## 在 OpenClash 中使用

### 方式一：订阅转换服务（每次由客户端传订阅链接）

1. 启动本服务
2. OpenClash → 全局设置 → 订阅转换
3. 订阅转换服务地址填入：`http://你的IP:25500/sub`（只填到 `/sub`，`target` 与 `url` 由 OpenClash 自动拼接）
   - 服务挂在子路径时（`BASE_PATH=/clash`）填 `https://你的域名/clash/sub`
4. 原始订阅链接会自动拼接

### 方式二：保存订阅地址后直接填 `/sub`（推荐）

不必每次在客户端里拼订阅链接：

1. 浏览器打开配置界面 → 「📮 我的订阅」，粘入订阅链接（每行一个）→ 点「保存订阅地址」
2. 在代理软件里直接把 `http://你的IP:25500/sub` 填成**订阅地址**（不是「订阅转换服务地址」）
3. 之后每次自动更新都由服务端用这份配置拉取 → 转换 → 返回，无需再打开网页

配置按**请求来源 IP** 区分（`guests/<IP>.json`），所以：

- 保存与拉取须来自同一出口 IP：同一台机器，或同一 NAT 下都能命中
- 路由器（OpenClash）属于另一个 IP，需在路由器所在网络里打开一次配置页保存
- 部署在 Nginx / Caddy 后面时**必须**设 `TRUST_PROXY`，否则所有设备会被当成同一个 IP
- 想查看/修改已保存的地址：随时打开配置页，或用 `GET /api/config`

> 也可以两者混用：`?url=` 显式指定时优先用它，未指定时才回退到保存的地址。

## 配置界面

浏览器打开配置界面，可以可视化调整以下内容，保存后立即生效：

- **我的订阅** — 保存订阅链接，之后客户端直接填 `/sub` 即可（见上一节）
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

重定向（机场 302 到 CDN / 对象存储）时，元信息头**在哪一跳上都算数**：
不少机场只在 302 那次响应里带 `subscription-userinfo`，最终 200 里没有，
所以转换器会跨跳收集（首个非空优先）。

### 为什么客户端看不到流量 / 到期

按可能性从高到低：

1. **导入的是本地文件**（网页「下载配置」得到的 YAML、或「文件模式」上传转换的结果）。
   流量 / 到期**只存在于 HTTP 响应头**，YAML 正文里没有这个位置。
   任何转换器都一样 —— 本地文件 profile 永远不会有订阅信息。
   **解决**：把 `/sub` 作为「远程订阅地址」填进客户端（见[方式二](#方式二保存订阅地址后直接填-sub推荐)）。
2. **机场把信息做成「假节点」**，如 `🇦🇶 [到期: 2026年11月07日]`、`🌔流量剩余: 98.61%`。
   默认的 22 个排除关键词里含 `到期` / `剩余` / `流量` / `官网`，这些节点会被过滤掉。
   这是有意为之（它们会污染分组、且无法连通），但如果你的机场**只**用这种方式展示信息，
   就会觉得「信息没了」—— 到「节点过滤」里删掉这几个关键词即可保留。
3. **机场确实没下发这些头**（部分小机场只给节点）。
   看 `logs/app.log` 里的 `[fetch] 订阅元信息` 一行：
   - `userinfo=(无)` → 机场没发，或发在了非标准头里（日志会同时列出疑似头名）
   - `userinfo=upload=… download=…` → 我们收到了，接着看下一行 `已转发订阅信息给客户端`
4. **链路把响应头吞了**：反向代理 / CDN 显式隐藏了未知头。
   nginx 默认透传，但若配置了 `proxy_hide_header`、或中间套了一层会重写头的服务，就会丢。
   验证：`curl -sI "http://你的地址/sub?url=机场订阅"` 看是否含 `subscription-userinfo`。
5. **`?url=` 里填的是网页地址而不是订阅地址**（拉回来的是 HTML，自然没有这些头）。

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

按节点名称自动识别 35 个地区，生成 url-test 分组（仅对订阅中实际出现的地区建组）：

> 香港、澳门、台湾、日本、韩国、新加坡、马来西亚、印尼、泰国、越南、菲律宾、文莱、缅甸、东帝汶、印度、阿联酋、土耳其、俄罗斯、美国、加拿大、巴西、阿根廷、智利、英国、爱尔兰、德国、法国、荷兰、瑞士、冰岛、格陵兰、澳大利亚、南非、尼日利亚、南极洲

另含三个必备分组：`🚀 节点选择`、`♻️ 自动选择`、`🐟 漏网之鱼`，以及存在国内节点时的 `🇨🇳 中国大陆` 分组。

> `🇭🇰 香港`、`🇹🇼 台湾` 等地区组是**独立分组**（组内是该地区的具体节点），
> 由配置页面的 `🌏 地区分组` 生成器统一开关控制生成（**默认关闭**，节点较多时建议开启）。

> **两级选择**：`🚀 节点选择`、`⌨️ GitHub` 等上层分组的候选是**地区分组**而非上百个具体节点。
> 在客户端先选地区（如 `🇹🇼 台湾`），再进地区组选具体节点（如 `台湾1`），
> 于是「GitHub 走香港」只需把 `⌨️ GitHub` 设为 `🇭🇰 香港` 即可。
> 无法识别地区的节点归入 `🌐 其他地区`，保证不会有节点选不到。

> 地区识别遵循「先匹配具体地区、再判断国内」：`[台湾省] 中华电信` 会归入 `🇹🇼 台湾` 而非国内。
> 短英文关键词（CN / IN / HK …）按词边界匹配，`CN2 GIA` 不会被误判为国内节点。

## 分流规则

18 个规则文件（17 个可配置服务分组 + 系统本地路由 `common.json`），共 1317 条规则：

| 规则组 | 包含内容 |
|--------|----------|
| 🍎 Apple 服务 | apple.com、icloud.com、itunes.com、mzstatic.com、apple-dns.net、TestFlight、App Store / Apple 自有 IP 段（默认 DIRECT） |
| Ⓜ️ 微软服务 | microsoft.com、office365.com、live.com、outlook、onedrive、azure、bing、xbox、visualstudio、vscode.dev、nuget.org、Power BI / Power Apps、Minecraft、Bethesda（默认 DIRECT） |
| 🤖 OpenAI | openai.com、chatgpt.com、oaistatic.com、livekit.cloud、statsig、arkoselabs |
| 🤖 Claude | anthropic.com、claude.ai、servd-anthropic-website.b-cdn.net |
| 🤖 Gemini | gemini.google.com、generativelanguage.googleapis.com、makersuite、deepmind.google、generativeai.google |
| 💬 Telegram | telegram.org、t.me、telegra.ph、telegramdownload.com、Telegram CDN / IPv4 + IPv6 网段 |
| 📺 YouTube | youtube.com 及各国域名、googlevideo.com、ytimg.com、ggpht.com、video.google.com、gvt1 / gvt2.com、YouTube IP 段 |
| 🎬 Netflix | netflix.com（含各国）、nflximg.net、nflxvideo.net、fast.com、netflixdnstest*.com、Netflix IP 段 |
| 🎥 Disney+ | disneyplus.com、disney.com、bamgrid.com、hotstar.com、espn.com、abc.com、marvel.com、nationalgeographic.com |
| 📺 Dazn | dazn.com、daznservices.com、indaznlab.com、DAZN 专用 CDN |
| 📺 哔哩哔哩 | bilibili.com、bilibili.tv、hdslb.com、bilivideo.com、biligame.com、bili22 / 23 / 33.cn、maoercdn.com、mcbbs.net |
| 🎮 巴哈姆特 | bahamut.com.tw、gamer.com.tw、bahamut.akamaized.net |
| ⌨️ GitHub | github.com、githubusercontent.com、githubassets.com、githubcopilot.com、github.io、npmjs.org、rawgit.com |
| ⭕️💰 miHoYo | mihoyo.com、hoyoverse.com、yuanshen.com、starrails.com、juequling.com、mihayo.akamaized.net |
| 🎨 Pixiv | pixiv.net、pximg.net、fanbox.cc、booth.pm、pixiv.cat |
| 🎮 Steam 商店/社区 | steampowered.com、steamcommunity.com、steamstatic.com、steam-chat.com、steamdeck.com、steamstat.us（默认 ♻️ 自动选择） |
| 🎮 Steam 下载/联机 | steamcontent.com、steamgames.com、steamcdn*、steampipe*.akamaized.net、api.steampowered.com、steamserver.net、国内 CDN（默认 DIRECT） |
| 🏠 本地路由 | 局域网、私有 IP、路由器、DDNS、GEOIP 国内（始终生效、不可配置） |

### 编写规则的原则

- **只收录服务自有域名**。跨服务共用的第三方 SaaS（`sentry.io`、`stripe.com`、`auth0.com`、`optimizely.com`、`akadns.net` …）一律不收录 —— 收进某个服务分组会让别家的流量跟着走错出口。
- **不重复**。同一条规则出现在两个分组时，只有**文件名靠前**（按字母序）的分组生效，后面的形同虚设。例：`steam-download` 排在 `steam-store` 之前，所以 `cm.steampowered.com`、`api.steampowered.com` 放在 `steam-download` 里才真正走直连。
- **不留冗余**。同组内若已有 `DOMAIN-SUFFIX,pixiv.net`，再写 `DOMAIN,app-api.pixiv.net` 是多余的 —— `DOMAIN-SUFFIX` 同时匹配自身与所有子域。
- **只收还有流量的域名**。已停运的产品（IE、Windows Phone、Silverlight、Cortana、Wunderlist、HockeyApp）、已结束的营销活动域名、Bing 拼写防抢注域一律不收；定期用 DoH（Cloudflare / Google 双源）复核，`NXDOMAIN` 的直接清掉。判断依据是**域名是否还存在、产品是否还在服务**，而不是「域名能不能解析」—— `microsoftonline.com`、`trafficmanager.net`、`windowsupdate.com` 这类只在子域上提供服务的命名空间，apex 本来就没有 A 记录，必须保留。
- **组内排序**为 `DOMAIN` → `DOMAIN-SUFFIX` → `DOMAIN-KEYWORD` → `IP-CIDR`，精确规则在前。
- **`common.json` 始终生效且不可关闭**，适合放必须直连的本地 / 私有地址；与其他分组重复的规则写在 `common.json` 里才有效。

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

#### Nginx 配置示例

```nginx
# 挂在域名根下
location / {
    proxy_pass http://127.0.0.1:25500;
    proxy_set_header Host              $host;      # 必须保留原始 Host
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host  $host;      # 写接口的来源校验会用到
    proxy_read_timeout 60s;                        # 订阅拉取最慢 15s，留足余量
}

# 挂在子路径（配合 BASE_PATH=/clash）
location /clash {
    proxy_pass http://127.0.0.1:25500/clash;       # 结尾必须带同样的前缀
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host  $host;
}
```

> ⚠️ **`Host` 与 `X-Forwarded-Host` 都要保留原始域名**。写接口会校验
> 「`Origin` 是否与本站 host 一致」来防 CSRF；若代理把 Host 改写成 `127.0.0.1`，
> 页面发出的写请求会被判定为跨站而返回 403（配置保存不了）。

> ⚠️ 子路径部署时 `proxy_pass` **结尾必须带 `/clash`**（与 `BASE_PATH` 一致）。
> 写成 `proxy_pass http://127.0.0.1:25500;` 会导致服务收到 `/xxx` 而非 `/clash/xxx`，全部 404。

### 已知限制

同一出口 IP 的人**共用一份配置**（家里多台设备、公司 NAT 出口都一样）—— 这是按 IP
区分的固有代价。要严格区分得改用路径标识或登录态。

### 其他环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `25500` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址。只想本机访问设 `127.0.0.1` |
| `BASE_PATH` | 空 | 部署子路径，如 `/clash`（nginx 需保留前缀转发） |
| `BODY_LIMIT` | `10mb` | 请求体上限。直接粘贴超大订阅被 413 时可调大 |
| `ALLOW_PRIVATE_URL` | 关闭 | 设 `1` 允许订阅地址指向内网 / 回环（本机或 NAS 上的订阅源）。**默认关闭以防 SSRF**，开放后服务可被诱导请求内网地址 |
| `LOG_LEVEL` | `debug` | 写入 `logs/app.log` 的最低级别 |
| `LOG_CONSOLE_LEVEL` | `info` | 输出到控制台的最低级别 |
| `LOG_MAX_BYTES` | `5242880` | 单个日志文件上限，超出转存为 `.1` |
| `MAX_GUESTS` | 见 `src/user/guests.js` | 访客配置文件数量上限，防止磁盘被写满 |

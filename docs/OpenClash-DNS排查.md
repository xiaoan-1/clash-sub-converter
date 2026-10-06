# OpenClash DNS 排查

适用 OpenClash `v0.47.156` + Mihomo 内核。

## 一句话结论

**导入 OpenClash 后节点全挂、但百度能开** → 九成是客户端 DNS 的问题：
OpenClash 用境外 DoH（`dns.google` / `dns.cloudflare.com`）解析节点域名，而它自己连不上这俩。

## 四个开关

| 界面 | 管什么 |
|---|---|
| **DNS 代理** | 连上游 DNS 时走不走代理（= `dns.respect-rules`）|
| **DNS 覆写** | OpenClash 接管整个 `dns:` 段 |
| **自定义上游 DNS** | **替换** DNS 列表 |
| **追加上游 DNS** | **追加**上级下发的 DNS |

> 「DNS 代理」不是 DNS 总开关。`dns.enable` 被 OpenClash 强制 `true` 且界面不暴露，
> 所以它显示「停用」是正常的。

## 五张名单

| 名单 | 干什么 |
|---|---|
| `default-nameserver` | 解析**其它 DNS 服务器**的域名，只能填 IP |
| `nameserver` | 主 DNS，查绝大多数域名（放国内）|
| `fallback` | 备胎：主 DNS 查出**境外 IP** 时改用它重查（放境外）。存在即启用 `fallback-filter` |
| `proxy-server-nameserver` | **只**用来查代理节点的域名 |
| `nameserver-policy` | 按域名指定解析器 |

> ⚠️ 触发 fallback 看的是**解析出来的 IP 在境外**，不是「域名本身在国外」。

## 事故复盘

**现象**：订阅里有 10 条国内 DoH/DoT（无 fallback），导入后节点全超时；同一个文件在本机
Clash Verge 正常；**百度能开**。

**日志**：

```
all DNS requests failed, first error:
  requesting https://dns.google:443/dns-query: ... context deadline exceeded
```

**链条**：

1. 生效配置 `nameserver` **为空** → OpenClash 兜底，写入
   `fallback = [dns.cloudflare.com, dns.google]`
2. 节点域名解析出**境外 IP** → 判疑似污染 → 改用 `fallback` 重查
3. 那俩是境外 DoH，而「DNS 代理」关着 → **直连** → 国内超时
4. 节点域名查不出 IP → **所有节点挂**（百度结果是 CN IP，不走 fallback，所以正常）

**fallback 从哪来**（两条路，结果一样）：
「自定义上游 DNS」开着（出厂表就勾了这俩）／ `nameserver` 为空被兜底注入。

> 这 2 条**既不在机场订阅里，也不在转换器的输出里** —— 是 OpenClash 自己加的。

## 修复

| 方案 | 做法 |
|---|---|
| **A（推荐）** | 关掉「自定义上游 DNS」，用订阅自带的 DNS |
| **B（推荐）** | 若必须开自定义：在 DNS 表里**取消勾选 fallback 组的境外 DoH** |
| C | 打开「DNS 代理」（有效，但每条查询绕一圈代理，稍慢）|

**排查命令**：

```sh
cat /etc/openclash/config.yaml | sed -n '/^dns:/,/^[a-z]/p'   # 看生效配置
logread -e openclash | grep -i "dns resolve failed"           # 看报错
```

## 和本项目无关

转换器**不改写 DNS**：从源订阅整段原样提取、原样透传，输出里的 `dns:` 与机场原文一致。

```
拉取失败       → logs/app.log（见 docs/日志与排查.md）
节点数不对     → 过滤 / 分组逻辑（见 docs/配置组装详解.md）
能连但节点全挂 → 客户端 DNS（本文档）
```

> 源码依据：`yml_change.sh` L485-500（强制覆写）、L556-565（替换/追加、写 fallback）、
> L775-778（空 nameserver 兜底注入境外 fallback）、L797-808（自动补 `proxy-server-nameserver`）、
> `config-overwrite.lua` L161-175（开关的 UCI 键名）。

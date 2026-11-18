module.exports = {
	apps: [
		{
			name: 'clash-sub-converter',
			script: 'index.js',
			instances: 1,
			exec_mode: 'fork',
			watch: false,
			// max_memory_restart 必须高于「订阅正文上限 × 解析峰值倍率（约 3~5 倍）」。
			// 默认 MAX_SUB_BYTES=32MB，解析一份大 YAML 峰值可达 150MB+，
			// 200M 会让进程在转换时被 PM2 反复重启（表现为随机 502）。
			max_memory_restart: '400M',
			env: {
				NODE_ENV: 'production',
				PORT: 25500,
				// 监听地址：服务器上与 nginx 同机部署，只绑回环 → 25500 对外不可达，
				// 外部只能走 nginx 的 80/443，不会被绕过 HTTPS / 限流直连端口。
				// ⚠️ 本机（Windows）调试想局域网直连时，改回 '0.0.0.0'。
				// ⚠️ 若 app 跑在 Docker 里，nginx 那一跳不是回环地址，见下方 TRUST_PROXY。
				HOST: '127.0.0.1',
				// 日志级别由 src/logger.js 读取：
				//   LOG_LEVEL         写入 logs/app.log 的最低级别（默认 debug，即全量）
				//   LOG_CONSOLE_LEVEL 输出到控制台的最低级别（默认 info）
				// 排查完想减少日志量，把 LOG_LEVEL 改成 info 即可。
				LOG_LEVEL: 'debug',
				LOG_CONSOLE_LEVEL: 'info',

				// ---- 资源上限（防单个请求拖垮服务）----
				// 单次请求最多接受的订阅份数（| 分隔）
				MAX_SUB_URLS: '10',
				// 一次请求拉取全部订阅的总耗时预算（毫秒）；超出后剩余订阅直接判失败
				SUB_TOTAL_TIMEOUT_MS: '60000',
				// 单份订阅正文体积上限（字节，默认 32 × 1024 × 1024）
				MAX_SUB_BYTES: String(32 * 1024 * 1024),
				// 同时进行的转换请求数，超出返回 503 + Retry-After
				MAX_CONCURRENT_CONVERTS: '4',

				// ---- 访客配置（按访问者 IP 隔离，见 src/user/guests.js）----
				// 所有访问者（含本机）一视同仁，各写自己的 guests/<IP>.json；
				// 全局基准由部署人员直接编辑 config/default.json 维护。
				// 反向代理：部署在 Nginx / Caddy 后面时必须设置，否则 req.ip 恒为
				// 127.0.0.1，所有访客会被判定成同一个人。
				//   未设置/0/false 关闭       1/true 信任最近一跳（都按数字 1 处理）
				//   loopback 只信任回环（推荐）  10.0.0.0/8 信任指定网段   数字 信任前 N 跳
				// 服务器上与 nginx 同机 → 'loopback'（nginx 从 127.0.0.1 连进来）。
				// ⚠️ 不要写布尔 true —— 那在 Express 里是「信任所有跳」，req.ip 会取
				//    X-Forwarded-For 的最左值，等于把客户端可伪造的字段当成真实来源。
				// ⚠️ 若 app 在 Docker 里，'loopback' 不适用（那一跳是 172.x 网桥地址），
				//    改成对应网段如 '172.17.0.0/16' 或直接 '1'。
				TRUST_PROXY: 'loopback',

				// 部署子路径：服务挂在 http://域名/clash/ 下时设为 '/clash'，
				// 此时 nginx 用【保留前缀】写法（proxy_pass 结尾带上同样的路径）：
				//     location /clash { proxy_pass http://127.0.0.1:25500/clash; }
				// 若挂在域名根下，这里留空 ''，nginx 写 proxy_pass http://127.0.0.1:25500;
				// 前端资源引用已统一改为相对路径（./config.css、./api/config …），
				// 所以两种部署方式都只要这一条 location，无需再单独转发静态资源。
				BASE_PATH: '/clash',
			},
			// 注意：应用自带的日志写入 ./logs/app.log 与 ./logs/error.log（见 src/logger.js）。
			// PM2 自己的输出文件必须换成别的名字，否则两个写入方会交错破坏日志行。
			out_file: './logs/pm2-out.log',
			error_file: './logs/pm2-error.log',
			log_date_format: 'YYYY-MM-DD HH:mm:ss',
			merge_logs: true,
			autorestart: true,
			max_restarts: 10,
			restart_delay: 3000,
		},
	],
};

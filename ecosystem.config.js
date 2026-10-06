module.exports = {
  apps: [{
    name: 'clash-sub-converter',
    script: 'index.js',
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    max_memory_restart: '200M',
    env: {
      NODE_ENV: 'production',
      PORT: 25500,
      // 日志级别由 src/logger.js 读取：
      //   LOG_LEVEL         写入 logs/app.log 的最低级别（默认 debug，即全量）
      //   LOG_CONSOLE_LEVEL 输出到控制台的最低级别（默认 info）
      // 排查完想减少日志量，把 LOG_LEVEL 改成 info 即可。
      LOG_LEVEL: 'debug',
      LOG_CONSOLE_LEVEL: 'info',

      // ---- 访客配置（按访问者 IP 隔离，见 src/guests.js）----
      // 管理员 IP：这些 IP 访问时用的仍然是 config.json（站点基准），其余访客
      // 各用 guests/<IP>.json。多个用逗号分隔。
      //   注意：留空且未设 TRUST_PROXY 时，只有 127.0.0.1 算管理员。
      ADMIN_IPS: '127.0.0.1',
      // 反向代理：部署在 Nginx / Caddy 后面时必须设置，否则 req.ip 恒为
      // 127.0.0.1，所有访客会被判定成同一个人。
      //   未设置/0/false 关闭       1/true 信任最近一跳（都按数字 1 处理）
      //   loopback 只信任回环（推荐）  10.0.0.0/8 信任指定网段   数字 信任前 N 跳
      // ⚠️ 不要写布尔 true —— 那在 Express 里是「信任所有跳」，req.ip 会取
      //    X-Forwarded-For 的最左值，等于把客户端可伪造的字段当成真实来源。
      // ⚠️ 设了 TRUST_PROXY 后回环地址不再算管理员，必须把管理员的真实公网 IP
      //    填进 ADMIN_IPS，否则没人能改站点基准。
      TRUST_PROXY: ''
    },
    // 注意：应用自带的日志写入 ./logs/app.log 与 ./logs/error.log（见 src/logger.js）。
    // PM2 自己的输出文件必须换成别的名字，否则两个写入方会交错破坏日志行。
    out_file: './logs/pm2-out.log',
    error_file: './logs/pm2-error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 3000
  }]
};

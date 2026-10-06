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
      LOG_CONSOLE_LEVEL: 'info'
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

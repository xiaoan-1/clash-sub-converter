module.exports = {
  apps: [{
    name: 'clash-sub-converter',
    script: 'index.js',
    args: '--server',
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    max_memory_restart: '200M',
    env: {
      NODE_ENV: 'production',
      PORT: 25500
    },
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 3000
  }]
};

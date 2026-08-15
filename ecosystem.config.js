module.exports = {
  apps: [
    {
      name: 'browser-relay',
      script: 'server.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      env: {
        PORT: 7777,
        // 管理员密码不要明文写在此处。公网部署请通过环境变量注入：
        //   服务器执行 export ADMIN_PASSWORD='你的强密码'，或把密码放进 .env（已被 .gitignore 忽略）
        // 不设置时服务端会自动生成随机密码并在启动日志打印。
      },
    },
  ],
};

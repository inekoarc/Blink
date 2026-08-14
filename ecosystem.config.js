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
        PORT: 3000,
        ADMIN_PASSWORD: 'MIma891.',
      },
    },
  ],
};

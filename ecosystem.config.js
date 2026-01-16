/**
 * PM2 Ecosystem Configuration
 *
 * Alternative to systemd for process management.
 *
 * Usage:
 *   pm2 start ecosystem.config.js
 *   pm2 start ecosystem.config.js --env production
 *   pm2 stop ivy-gateway
 *   pm2 restart ivy-gateway
 *   pm2 logs ivy-gateway
 */

module.exports = {
  apps: [
    {
      name: 'ivy-gateway',
      script: 'src/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      },
      error_file: 'logs/error.log',
      out_file: 'logs/out.log',
      log_file: 'logs/combined.log',
      time: true,
    },
  ],
};

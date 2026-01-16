# Deployment Guide

This guide covers deploying IVY 4G Gateway on a production Ubuntu server.

## Table of Contents

- [Requirements](#requirements)
- [Quick Installation](#quick-installation)
- [Step-by-Step Installation](#step-by-step-installation)
- [Configuration](#configuration)
- [Firewall Setup](#firewall-setup)
- [Service Management](#service-management)
- [PM2 Alternative](#pm2-alternative)
- [Updating](#updating)
- [Monitoring](#monitoring)
- [Security Recommendations](#security-recommendations)
- [Backup](#backup)

## Requirements

### Hardware
- CPU: 1+ cores
- RAM: 512MB minimum, 1GB recommended
- Disk: 1GB free space
- Network: Static IP recommended

### Software
- Ubuntu 20.04 LTS or newer (Ubuntu 22.04 recommended)
- Node.js 18+ (20 LTS recommended)

### Network
- Inbound ports: 8899 (TCP), 1883 (MQTT), 9001 (WS), 3000 (HTTP)
- Outbound: Internet access for npm packages

## Quick Installation

For a fresh Ubuntu server:

```bash
# Clone repository
git clone https://github.com/olivenet-iot/ivy-4g-gateway.git
cd ivy-4g-gateway

# Run deployment script (installs Node.js if needed)
sudo ./deploy.sh
```

The script will:
1. Check/install Node.js 20 LTS
2. Install npm dependencies
3. Create `.env` from template
4. Create logs directory
5. Install and start systemd service

## Step-by-Step Installation

### 1. Install Node.js

```bash
# Install Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify installation
node --version  # Should show v20.x.x
npm --version
```

### 2. Clone Repository

```bash
cd /opt
sudo git clone https://github.com/olivenet-iot/ivy-4g-gateway.git
sudo chown -R $USER:$USER ivy-4g-gateway
cd ivy-4g-gateway
```

### 3. Install Dependencies

```bash
# Production dependencies only
npm ci --production
```

### 4. Configure Environment

```bash
# Create configuration file
cp .env.example .env

# Edit configuration
nano .env
```

### 5. Create Log Directory

```bash
mkdir -p logs
```

### 6. Test Run

```bash
# Test that it starts correctly
npm start

# Press Ctrl+C to stop
```

### 7. Install Service

```bash
sudo ./scripts/install-service.sh
```

## Configuration

Edit `.env` file to customize settings:

### Essential Settings

```bash
# Environment
NODE_ENV=production

# TCP Server (meters connect here)
TCP_PORT=8899
TCP_HOST=0.0.0.0

# MQTT Broker
MQTT_PORT=1883
MQTT_WS_PORT=9001

# HTTP Dashboard
HTTP_PORT=3000
```

### Security Settings

```bash
# MQTT Authentication (recommended for production)
MQTT_AUTH_ENABLED=true
MQTT_USERS=admin:your_secure_password

# Rate Limiting
RATE_LIMITING_ENABLED=true
MAX_CONNECTIONS_PER_IP=10
```

### Polling Configuration

```bash
# Automatic meter polling
POLLING_ENABLED=true
POLLING_INTERVAL=60000        # 60 seconds
POLLING_REGISTER_GROUP=energy # energy, power, voltage, current, all
```

See [.env.example](../.env.example) for all available options.

## Firewall Setup

### Using UFW (Recommended)

```bash
# Run firewall setup script
sudo ./scripts/firewall-setup.sh
```

Or manually:

```bash
# Enable UFW
sudo ufw enable

# Allow required ports
sudo ufw allow ssh
sudo ufw allow 8899/tcp comment 'IVY Gateway - Meter TCP'
sudo ufw allow 1883/tcp comment 'IVY Gateway - MQTT'
sudo ufw allow 9001/tcp comment 'IVY Gateway - MQTT WebSocket'
sudo ufw allow 3000/tcp comment 'IVY Gateway - Dashboard'

# Check status
sudo ufw status verbose
```

### Restricting Access

To allow only specific IPs to access MQTT:

```bash
# Remove general rule
sudo ufw delete allow 1883/tcp

# Allow specific IP only
sudo ufw allow from 192.168.1.100 to any port 1883 proto tcp
```

## Service Management

### Systemd Commands

```bash
# Start service
sudo systemctl start ivy-gateway

# Stop service
sudo systemctl stop ivy-gateway

# Restart service
sudo systemctl restart ivy-gateway

# Check status
sudo systemctl status ivy-gateway

# Enable on boot
sudo systemctl enable ivy-gateway

# Disable on boot
sudo systemctl disable ivy-gateway
```

### View Logs

```bash
# Live logs
sudo journalctl -u ivy-gateway -f

# Last 100 lines
sudo journalctl -u ivy-gateway -n 100

# Logs since today
sudo journalctl -u ivy-gateway --since today

# Error logs only
sudo journalctl -u ivy-gateway -p err
```

### Uninstall Service

```bash
sudo ./scripts/uninstall-service.sh
```

## PM2 Alternative

If you prefer PM2 over systemd:

```bash
# Install PM2 globally
sudo npm install -g pm2

# Start with PM2
pm2 start ecosystem.config.js --env production

# Save PM2 configuration
pm2 save

# Setup PM2 startup script
pm2 startup

# View logs
pm2 logs ivy-gateway

# Restart
pm2 restart ivy-gateway

# Stop
pm2 stop ivy-gateway
```

## Updating

### Standard Update

```bash
# Stop service
sudo systemctl stop ivy-gateway

# Pull latest code
git pull origin main

# Install dependencies
npm ci --production

# Start service
sudo systemctl start ivy-gateway
```

### Update Script

```bash
#!/bin/bash
# update.sh
set -e
sudo systemctl stop ivy-gateway
git pull origin main
npm ci --production
sudo systemctl start ivy-gateway
echo "Update complete!"
```

## Monitoring

### Check Gateway Status

```bash
# Service status
sudo systemctl status ivy-gateway

# Dashboard (if HTTP enabled)
curl http://localhost:3000/health

# API info
curl http://localhost:3000/api/info
```

### Log Monitoring

```bash
# Application logs
tail -f logs/*.log

# System logs
sudo journalctl -u ivy-gateway -f
```

### Resource Usage

```bash
# Memory and CPU
ps aux | grep node

# Detailed stats
htop
```

## Security Recommendations

### 1. Enable MQTT Authentication

```bash
# In .env
MQTT_AUTH_ENABLED=true
MQTT_USERS=admin:strong_random_password_here
```

### 2. Use Strong Passwords

Generate secure passwords:

```bash
openssl rand -base64 32
```

### 3. Restrict Network Access

- Use firewall rules to limit access
- Consider VPN for remote access
- Use reverse proxy (nginx) for HTTPS

### 4. Keep Updated

```bash
# Check for updates
git fetch origin
git log HEAD..origin/main --oneline

# Apply updates
git pull origin main
```

### 5. Monitor Logs

Set up log monitoring for suspicious activity:

```bash
# Check for blocked IPs
grep "blocked" logs/*.log
```

## Backup

### Configuration Backup

```bash
# Backup .env file
cp .env .env.backup.$(date +%Y%m%d)

# Backup to remote
scp .env user@backup-server:/backups/ivy-gateway/
```

### Full Backup Script

```bash
#!/bin/bash
# backup.sh
BACKUP_DIR="/backups/ivy-gateway"
DATE=$(date +%Y%m%d_%H%M%S)

mkdir -p $BACKUP_DIR

# Backup configuration
cp .env $BACKUP_DIR/.env.$DATE

# Backup logs (last 7 days)
tar -czf $BACKUP_DIR/logs.$DATE.tar.gz logs/

echo "Backup complete: $BACKUP_DIR"
```

### Restore

```bash
# Restore .env
cp /backups/ivy-gateway/.env.20240115 .env

# Restart service
sudo systemctl restart ivy-gateway
```

---

For troubleshooting, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md)

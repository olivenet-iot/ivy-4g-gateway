#!/bin/bash
set -e

SERVICE_NAME="ivy-gateway"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
WORKING_DIR=$(pwd)
NODE_PATH=$(which node)

echo "Installing ${SERVICE_NAME} service..."

# Create service file
cat > /tmp/${SERVICE_NAME}.service << EOF
[Unit]
Description=IVY 4G Gateway - DL/T 645 to MQTT Bridge
Documentation=https://github.com/olivenet-iot/ivy-4g-gateway
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=${WORKING_DIR}
ExecStart=${NODE_PATH} src/index.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

# Environment
Environment=NODE_ENV=production
EnvironmentFile=-${WORKING_DIR}/.env

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${WORKING_DIR}/logs

[Install]
WantedBy=multi-user.target
EOF

# Install service
sudo mv /tmp/${SERVICE_NAME}.service ${SERVICE_FILE}
sudo chmod 644 ${SERVICE_FILE}

# Reload and enable
sudo systemctl daemon-reload
sudo systemctl enable ${SERVICE_NAME}

echo "  ✓ Service installed: ${SERVICE_NAME}"
echo "  ✓ Service enabled (will start on boot)"

# Start service
sudo systemctl start ${SERVICE_NAME}
echo "  ✓ Service started"

# Show status
sleep 2
sudo systemctl status ${SERVICE_NAME} --no-pager || true

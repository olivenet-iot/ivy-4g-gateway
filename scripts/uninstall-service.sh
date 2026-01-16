#!/bin/bash
set -e

SERVICE_NAME="ivy-gateway"

echo "Uninstalling ${SERVICE_NAME} service..."

sudo systemctl stop ${SERVICE_NAME} 2>/dev/null || true
sudo systemctl disable ${SERVICE_NAME} 2>/dev/null || true
sudo rm -f /etc/systemd/system/${SERVICE_NAME}.service
sudo systemctl daemon-reload

echo "  ✓ Service uninstalled"

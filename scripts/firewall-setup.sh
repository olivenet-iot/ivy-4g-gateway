#!/bin/bash
set -e

# IVY 4G Gateway Firewall Setup
# Uses UFW (Uncomplicated Firewall)

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}================================${NC}"
echo -e "${GREEN}  IVY 4G Gateway Firewall Setup${NC}"
echo -e "${GREEN}================================${NC}"

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Please run as root (sudo)${NC}"
    exit 1
fi

# Check if UFW is installed
if ! command -v ufw &> /dev/null; then
    echo -e "${YELLOW}UFW not found. Installing...${NC}"
    apt-get update
    apt-get install -y ufw
fi

echo -e "\n${GREEN}[1/5]${NC} Setting default policies..."
ufw default deny incoming
ufw default allow outgoing
echo "  ✓ Default policies set"

echo -e "\n${GREEN}[2/5]${NC} Allowing SSH..."
ufw allow ssh
echo "  ✓ SSH (22) allowed"

echo -e "\n${GREEN}[3/5]${NC} Allowing IVY Gateway ports..."

# TCP Server for meters
ufw allow 8899/tcp comment 'IVY Gateway - Meter TCP'
echo "  ✓ Port 8899/tcp (Meter connections)"

# MQTT Broker
ufw allow 1883/tcp comment 'IVY Gateway - MQTT'
echo "  ✓ Port 1883/tcp (MQTT)"

# MQTT WebSocket
ufw allow 9001/tcp comment 'IVY Gateway - MQTT WebSocket'
echo "  ✓ Port 9001/tcp (MQTT WebSocket)"

# HTTP Dashboard
ufw allow 3000/tcp comment 'IVY Gateway - Dashboard'
echo "  ✓ Port 3000/tcp (Dashboard)"

echo -e "\n${GREEN}[4/5]${NC} Enabling firewall..."
ufw --force enable
echo "  ✓ Firewall enabled"

echo -e "\n${GREEN}[5/5]${NC} Current status:"
ufw status verbose

echo -e "\n${GREEN}================================${NC}"
echo -e "${GREEN}  Firewall Setup Complete!${NC}"
echo -e "${GREEN}================================${NC}"
echo ""
echo "Allowed ports:"
echo "  - 22    SSH"
echo "  - 8899  Meter TCP connections"
echo "  - 1883  MQTT"
echo "  - 9001  MQTT WebSocket"
echo "  - 3000  Dashboard"
echo ""
echo -e "${YELLOW}Note: If you need to restrict access further, edit /etc/ufw/user.rules${NC}"

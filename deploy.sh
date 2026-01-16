#!/bin/bash
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}================================${NC}"
echo -e "${GREEN}  IVY 4G Gateway Deployment${NC}"
echo -e "${GREEN}================================${NC}"

# Check if running as root for service installation
if [ "$EUID" -eq 0 ]; then
    INSTALL_SERVICE=true
else
    INSTALL_SERVICE=false
    echo -e "${YELLOW}Not running as root. Service installation will be skipped.${NC}"
    echo -e "${YELLOW}Run with sudo to install as system service.${NC}"
fi

# Detect OS
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$ID
else
    OS="unknown"
fi

echo -e "\n${GREEN}[1/6]${NC} Checking Node.js..."

# Check Node.js
if command -v node &> /dev/null; then
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -ge 18 ]; then
        echo -e "  ✓ Node.js $(node -v) found"
    else
        echo -e "  ${RED}✗ Node.js 18+ required, found $(node -v)${NC}"
        exit 1
    fi
else
    echo -e "  ${YELLOW}Node.js not found. Installing...${NC}"

    if [ "$OS" = "ubuntu" ] || [ "$OS" = "debian" ]; then
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
        sudo apt-get install -y nodejs
    else
        echo -e "  ${RED}Please install Node.js 20 LTS manually${NC}"
        exit 1
    fi
fi

echo -e "\n${GREEN}[2/6]${NC} Installing dependencies..."
npm ci --production 2>/dev/null || npm install --production
echo -e "  ✓ Dependencies installed"

echo -e "\n${GREEN}[3/6]${NC} Setting up environment..."
if [ ! -f .env ]; then
    if [ -f .env.example ]; then
        cp .env.example .env
        echo -e "  ✓ Created .env from template"
        echo -e "  ${YELLOW}⚠ Review .env and update settings as needed${NC}"
    else
        echo -e "  ${YELLOW}⚠ No .env.example found, using defaults${NC}"
    fi
else
    echo -e "  ✓ .env already exists"
fi

echo -e "\n${GREEN}[4/6]${NC} Creating log directory..."
mkdir -p logs
echo -e "  ✓ logs/ directory ready"

echo -e "\n${GREEN}[5/6]${NC} Validating configuration..."
node -e "import('./src/config/index.js').then(c => console.log('  ✓ Configuration valid'))" 2>/dev/null || {
    echo -e "  ${YELLOW}⚠ Could not validate config (non-critical)${NC}"
}

echo -e "\n${GREEN}[6/6]${NC} Service installation..."
if [ "$INSTALL_SERVICE" = true ]; then
    bash scripts/install-service.sh
else
    echo -e "  ${YELLOW}Skipped (run with sudo for service installation)${NC}"
fi

echo -e "\n${GREEN}================================${NC}"
echo -e "${GREEN}  Deployment Complete!${NC}"
echo -e "${GREEN}================================${NC}"
echo ""
echo "Ports:"
echo "  - TCP Server:      8899 (meters)"
echo "  - MQTT Broker:     1883"
echo "  - MQTT WebSocket:  9001"
echo "  - Dashboard:       3000"
echo ""

if [ "$INSTALL_SERVICE" = true ]; then
    echo "Service commands:"
    echo "  sudo systemctl start ivy-gateway"
    echo "  sudo systemctl stop ivy-gateway"
    echo "  sudo systemctl status ivy-gateway"
    echo "  sudo journalctl -u ivy-gateway -f"
else
    echo "Start manually:"
    echo "  npm start"
    echo ""
    echo "Or install as service:"
    echo "  sudo ./deploy.sh"
fi

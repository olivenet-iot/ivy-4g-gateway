# IVY 4G Energy Meter Gateway

TCP/MQTT Gateway for IVY EM114070-4G Energy Meters using DLT645-2007 protocol.

## Features

- TCP server for 4G meter connections (port 8899)
- MQTT integration for Metpow backend
- AES-128 encryption for relay control commands
- Real-time telemetry (energy, voltage, current, power)
- Bidirectional communication (uplink + downlink)

## Requirements

- Node.js 20 LTS
- PostgreSQL 15+ with TimescaleDB
- Redis 7+
- Mosquitto MQTT Broker

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment config
cp .env.example .env

# Edit .env with your settings
nano .env

# Start development server
npm run dev
```

## Project Structure

```
src/
├── config/      # Configuration loader
├── tcp/         # TCP server & connection manager
├── protocol/    # DLT645-2007 protocol implementation
├── mqtt/        # MQTT client & publishers
├── commands/    # Command queue & handlers
├── db/          # Database models & migrations
└── utils/       # Logger & utilities
```

## MQTT Topics

| Topic | Direction | Description |
|-------|-----------|-------------|
| `metpow/4g/{meter_id}/telemetry` | Out | Energy & power readings |
| `metpow/4g/{meter_id}/status` | Out | Connection status |
| `metpow/4g/{meter_id}/command` | In | Commands from backend |
| `metpow/4g/{meter_id}/response` | Out | Command results |
| `metpow/4g/{meter_id}/alarm` | Out | Alerts & warnings |

## License

MIT © Olivenet Ltd

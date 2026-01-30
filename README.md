# IVY 4G Gateway

IoT gateway that bridges energy meters to MQTT, supporting DL/T 645-2007 and DLMS/COSEM protocols.

[![Tests](https://github.com/olivenet-iot/ivy-4g-gateway/actions/workflows/test.yml/badge.svg)](https://github.com/olivenet-iot/ivy-4g-gateway/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- **Multi-Protocol Support**: Auto-detects DL/T 645-2007 and DLMS/COSEM meters on the same TCP port
- **DL/T 645-2007 Protocol**: Full support for Chinese energy meter standard
- **DLMS/COSEM Protocol**: IVY EM114070 meter support via proprietary IVY wrapper
- **OBIS Registry**: Extensible OBIS code → name/unit/category mapping with scaler conversion
- **MQTT Bridge**: Forwards telemetry and commands over MQTT
- **Web Dashboard**: Real-time monitoring and testing interface
- **Automatic Polling**: Periodic meter reading (DLT645 and DLMS) with configurable intervals
- **Event System**: Voltage, current, power factor alarms
- **Production Ready**: Systemd service, rate limiting, security hardening

## Supported Meters

| Meter | Protocol | Detection | Features |
|-------|----------|-----------|----------|
| Generic DL/T 645-2007 | DLT645 | First byte `0x68` | All standard registers, relay control |
| IVY EM114070 | DLMS/COSEM via IVY | First bytes `00 01 00 01` | 14 OBIS codes, heartbeat identification |

## Requirements

- Node.js 18+ (20 LTS recommended)
- Ubuntu 20.04+ (for production deployment)

## Quick Start

```bash
# Clone
git clone https://github.com/olivenet-iot/ivy-4g-gateway.git
cd ivy-4g-gateway

# Install & Run
npm install
npm run dev

# Dashboard
open http://localhost:3000
```

## Production Deployment

```bash
# On Ubuntu server
git clone https://github.com/olivenet-iot/ivy-4g-gateway.git
cd ivy-4g-gateway
sudo ./deploy.sh
```

For detailed installation: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)

## Ports

| Port | Protocol | Description |
|------|----------|-------------|
| 8899 | TCP | Meter connections (DLT645 and IVY/DLMS) |
| 1883 | MQTT | MQTT Broker |
| 9001 | WebSocket | MQTT over WebSocket |
| 3000 | HTTP | Web Dashboard |

## MQTT Topics

```
ivy/v1/meters/{meterId}/telemetry         # Meter readings
ivy/v1/meters/{meterId}/status            # Online/offline status
ivy/v1/meters/{meterId}/events            # Alarms and events
ivy/v1/meters/{meterId}/command/request   # Send command
ivy/v1/meters/{meterId}/command/response  # Command result
ivy/v1/gateway/status                     # Gateway status
ivy/v1/gateway/stats                      # Gateway statistics
```

For detailed API: [docs/API.md](docs/API.md)

## Architecture

```
┌─────────────┐                         ┌─────────────┐      MQTT       ┌─────────────┐
│  DLT645     │  TCP (0x68 frames)      │             │ ──────────────► │   Backend   │
│  Meters     │ ───────────────────────►│             │ ◄────────────── │   (Metpow)  │
└─────────────┘                         │   IVY 4G    │                 └─────────────┘
                                        │   Gateway   │
┌─────────────┐  TCP (IVY+DLMS)         │             │
│  IVY        │ ───────────────────────►│  Protocol   │
│  EM114070   │                         │  Router     │
└─────────────┘                         │             │
                                        └──────┬──────┘
                                               │
                                          ┌────┴────┐
                                          │Dashboard│
                                          │ :3000   │
                                          └─────────┘
```

## Testing

```bash
# All tests
npm test

# Single run
npm run test:run

# Coverage
npm run test:coverage
```

## Project Structure

```
ivy-4g-gateway/
├── src/
│   ├── index.js           # Main entry point
│   ├── config/            # Configuration
│   ├── tcp/               # TCP Server & Connection Manager
│   ├── mqtt/              # MQTT Broker, Publisher, Commands
│   ├── protocol/          # Protocol parsers
│   │   ├── *.js           # DL/T 645-2007 (frame parser, builder, BCD, checksum)
│   │   ├── protocol-router.js  # Auto-detect protocol
│   │   ├── ivy-wrapper.js      # IVY 8-byte header
│   │   ├── heartbeat-handler.js # IVY heartbeat packets
│   │   └── dlms/          # DLMS/COSEM (APDU parser, client, OBIS registry)
│   ├── services/          # Polling, Status, DLMS Capture
│   ├── http/              # Dashboard Server
│   └── utils/             # Logger, Helpers
├── debug/                 # DLMS probe and scan tools
├── public/                # Dashboard UI
├── scripts/               # Deployment scripts
├── tests/                 # Unit & Integration tests
└── docs/                  # Documentation
```

## Configuration

Environment variables are read from `.env` file:

```bash
cp .env.example .env
# Edit .env file
```

For all options see: [.env.example](.env.example)

## Documentation

- [Deployment Guide](docs/DEPLOYMENT.md)
- [MQTT API Reference](docs/API.md)
- [Protocol Reference](docs/PROTOCOL.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing`)
5. Open a Pull Request

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Acknowledgments

- [Aedes](https://github.com/moscajs/aedes) - Embedded MQTT Broker
- [Vitest](https://vitest.dev/) - Test Framework
- [Express](https://expressjs.com/) - HTTP Server

---

Developed with care by **Olivenet IoT**

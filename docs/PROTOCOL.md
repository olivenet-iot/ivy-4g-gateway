# DLT645-2007 Protocol Reference

## Frame Structure

| Field | Bytes | Description |
|-------|-------|-------------|
| Start | 1 (0x68) | Frame start |
| Address | 6 | Meter address (reversed BCD) |
| Start2 | 1 (0x68) | Second delimiter |
| Control | 1 | Command type |
| Length | 1 | Data length |
| Data | Variable | Payload (+0x33 offset) |
| Checksum | 1 | Sum mod 256 |
| End | 1 (0x16) | Frame end |

## Control Codes

- `0x11` - Read data
- `0x14` - Write data
- `0x1C` - Relay control

*Full documentation to be added*

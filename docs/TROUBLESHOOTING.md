# Troubleshooting Guide

This guide helps resolve common issues with IVY 4G Gateway.

## Table of Contents

- [Gateway Won't Start](#gateway-wont-start)
- [Meter Not Connecting](#meter-not-connecting)
- [Meter Not Connected Error](#meter-not-connected-error)
- [MQTT Connection Failed](#mqtt-connection-failed)
- [Rate Limit Blocked](#rate-limit-blocked)
- [High Memory Usage](#high-memory-usage)
- [No Telemetry Data](#no-telemetry-data)
- [Log Analysis](#log-analysis)
- [Getting Help](#getting-help)

## Gateway Won't Start

### Error: Port already in use

```
Error: listen EADDRINUSE: address already in use :::8899
```

**Cause:** Another process is using the port.

**Solution:**

```bash
# Find process using port 8899
sudo lsof -i :8899

# Kill the process
sudo kill -9 <PID>

# Or change the port in .env
TCP_PORT=8900
```

### Error: Configuration validation failed

```
Configuration validation failed:
AES_ENCRYPTION_KEY is required in production
```

**Cause:** Missing required configuration in production mode.

**Solution:**

```bash
# Set required environment variables in .env
AES_ENCRYPTION_KEY=your_32_character_key_here
MQTT_PASSWORD=your_password
DB_PASSWORD=your_db_password

# Or run in development mode
NODE_ENV=development
```

### Error: Cannot find module

```
Error: Cannot find module 'aedes'
```

**Cause:** Dependencies not installed.

**Solution:**

```bash
# Install dependencies
npm install

# Or for production
npm ci --production
```

### Service fails to start

```bash
# Check service status
sudo systemctl status ivy-gateway

# Check logs for errors
sudo journalctl -u ivy-gateway -n 50 --no-pager
```

**Common causes:**
- Wrong Node.js path in service file
- Permission issues on log directory
- Missing .env file

**Solution:**

```bash
# Verify Node.js path
which node

# Fix permissions
sudo chown -R $USER:$USER /opt/ivy-4g-gateway
mkdir -p logs

# Reinstall service
sudo ./scripts/uninstall-service.sh
sudo ./scripts/install-service.sh
```

## Meter Not Connecting

### Check network connectivity

```bash
# Test if meter can reach gateway
# From meter network, try:
telnet <gateway-ip> 8899

# Check if port is open
sudo netstat -tlnp | grep 8899
```

### Check firewall

```bash
# List firewall rules
sudo ufw status

# Ensure port 8899 is allowed
sudo ufw allow 8899/tcp
```

### Verify gateway is listening

```bash
# Check TCP server is running
sudo ss -tlnp | grep 8899

# Should show:
# LISTEN 0 128 0.0.0.0:8899 0.0.0.0:* users:(("node",pid=...,fd=...))
```

### Check logs for connection attempts

```bash
# Watch for new connections
sudo journalctl -u ivy-gateway -f | grep -i "connection"
```

## Meter Not Connected Error

When sending commands, you receive:

```json
{
  "success": false,
  "error": "Meter not connected"
}
```

**Causes:**
1. Meter is offline
2. Wrong meter ID
3. Meter ID format incorrect

**Solutions:**

### Check meter status

```bash
# Subscribe to status topic
mosquitto_sub -h localhost -t 'ivy/v1/meters/+/status' -v
```

### Verify meter ID format

Meter ID must be 12 digits with leading zeros:

```
✓ 000000000001
✗ 1
✗ 0001
```

### Check connected meters

```bash
# Via MQTT - subscribe to gateway stats
mosquitto_sub -h localhost -t 'ivy/v1/gateway/stats'

# Or check dashboard
open http://localhost:3000
```

## MQTT Connection Failed

### Authentication error

```
Connection refused: Not authorized
```

**Cause:** MQTT authentication is enabled but credentials are wrong.

**Solution:**

```bash
# Check .env for credentials
cat .env | grep MQTT

# Test connection with credentials
mosquitto_sub -h localhost -u admin -P your_password -t 'test'
```

### Connection timeout

```
Connection timed out
```

**Causes:**
1. Firewall blocking port 1883
2. Wrong host/port
3. Gateway not running

**Solution:**

```bash
# Check if MQTT broker is running
sudo ss -tlnp | grep 1883

# Check firewall
sudo ufw status | grep 1883

# Test local connection
mosquitto_sub -h localhost -t '#' -v
```

### WebSocket connection failed

For browser connections:

```
WebSocket connection to 'ws://...' failed
```

**Solutions:**

1. Check WebSocket port (9001)
2. Verify no proxy/firewall blocking
3. Check browser console for details

```bash
# Test WebSocket port
sudo ss -tlnp | grep 9001
```

## Rate Limit Blocked

### IP blocked message

```
IP blocked for 300s
```

**Cause:** Too many connection attempts from the same IP.

**Solution:**

```bash
# Wait for block to expire (5 minutes default)

# Or restart gateway to clear blocks
sudo systemctl restart ivy-gateway

# Or adjust rate limit settings in .env
MAX_CONNECTION_ATTEMPTS=50
RATE_LIMIT_BLOCK_DURATION=60000
```

### HTTP 429 Too Many Requests

**Cause:** HTTP rate limit exceeded.

**Solution:**

```bash
# Adjust HTTP rate limit in .env
HTTP_MAX_REQUESTS_PER_MINUTE=200
```

## High Memory Usage

### Check current usage

```bash
# Process memory
ps aux | grep node | grep -v grep

# Detailed memory
node -e "console.log(process.memoryUsage())"
```

### Common causes

1. **Memory leak** - Restart gateway
2. **Too many connections** - Check connected clients
3. **Large log buffer** - Clear old logs

**Solutions:**

```bash
# Restart to clear memory
sudo systemctl restart ivy-gateway

# Set memory limit with PM2
pm2 start ecosystem.config.js --max-memory-restart 500M

# Check for many connections
sudo ss -tn | grep 8899 | wc -l
```

## No Telemetry Data

### Check polling is enabled

```bash
# Verify in .env
cat .env | grep POLLING

# Should have:
POLLING_ENABLED=true
POLLING_INTERVAL=60000
```

### Check for connected meters

```bash
# Via dashboard
open http://localhost:3000

# Via logs
sudo journalctl -u ivy-gateway | grep "Meter connected"
```

### Subscribe to telemetry topic

```bash
# Listen for any telemetry
mosquitto_sub -h localhost -t 'ivy/v1/meters/+/telemetry' -v

# If nothing appears, try sending a read command
mosquitto_pub -h localhost \
  -t 'ivy/v1/meters/000000000001/command/request' \
  -m '{"requestId":"test-1","command":"read","register":"totalActiveEnergy"}'
```

### Check logs for errors

```bash
# Look for polling errors
sudo journalctl -u ivy-gateway | grep -i "poll\|error"
```

## Log Analysis

### View real-time logs

```bash
# All logs
sudo journalctl -u ivy-gateway -f

# Filter by level
sudo journalctl -u ivy-gateway -f | grep -i error
sudo journalctl -u ivy-gateway -f | grep -i warn
```

### Common log patterns

#### Successful meter connection
```
info: Meter connected {"meterId":"000000000001","remoteAddress":"192.168.1.100"}
```

#### Successful telemetry read
```
debug: Telemetry received {"meterId":"000000000001","register":"totalActiveEnergy","value":12345.67}
```

#### Connection error
```
error: TCP connection error {"error":"ECONNRESET"}
```

#### Rate limit block
```
warn: IP blocked due to excessive connection attempts {"ip":"192.168.1.50","attempts":21}
```

### Export logs

```bash
# Export last 24 hours
sudo journalctl -u ivy-gateway --since "24 hours ago" > gateway-logs.txt

# Export with timestamps
sudo journalctl -u ivy-gateway -o short-iso --since "1 hour ago" > gateway-logs.txt
```

## Getting Help

### Gather diagnostic information

Before asking for help, collect:

```bash
# 1. Node.js version
node --version

# 2. Gateway version
cat package.json | grep version

# 3. Service status
sudo systemctl status ivy-gateway

# 4. Recent logs
sudo journalctl -u ivy-gateway -n 100 --no-pager

# 5. Configuration (remove passwords!)
cat .env | grep -v PASSWORD | grep -v KEY

# 6. Network status
sudo ss -tlnp | grep -E "8899|1883|9001|3000"
```

### Check GitHub Issues

Search existing issues: https://github.com/olivenet-iot/ivy-4g-gateway/issues

### Create Issue

If you can't find a solution:

1. Go to: https://github.com/olivenet-iot/ivy-4g-gateway/issues/new
2. Include:
   - Description of the problem
   - Steps to reproduce
   - Expected vs actual behavior
   - Log output (remove sensitive data)
   - Environment details (OS, Node version)

### Debug Mode

For more detailed logging:

```bash
# Set debug log level
LOG_LEVEL=debug

# Restart gateway
sudo systemctl restart ivy-gateway

# Watch detailed logs
sudo journalctl -u ivy-gateway -f
```

## DLMS/IVY Meter Issues

### No Telemetry from DLMS Meter

**Cause:** DLMS support may be disabled or meter isn't being recognized.

**Solutions:**

```bash
# Check DLMS is enabled
cat .env | grep DLMS

# Should have:
DLMS_ENABLED=true
```

Verify the meter sends a heartbeat packet (26 bytes starting with `00 01 00 01 00 01 00 12 0a 02 0c`):

```bash
# Check logs for heartbeat detection
sudo journalctl -u ivy-gateway | grep -i "heartbeat"
```

### DLMS Association Rejected

**Cause:** Meter doesn't support the requested DLMS application context.

```bash
# Check for AARE responses
sudo journalctl -u ivy-gateway | grep -i "aare\|association"
```

The EM114070 only supports LN_NO_CIPHER context. SN and ciphered contexts are rejected.

### No OBIS Responses

**Cause:** Active polling may be disabled (passive mode is the default).

```bash
# Enable active DLMS polling
DLMS_PASSIVE_ONLY=false

# Restart gateway
sudo systemctl restart ivy-gateway
```

Verify OBIS codes are in the registry:

```bash
# Check which codes are registered
grep "obisCode" src/services/polling-manager.js
```

### DLMS Capture Service

To diagnose what a DLMS meter is sending, enable the capture service:

```bash
# In .env
DLMS_CAPTURE_ENABLED=true
DLMS_CAPTURE_DURATION=3600000

# Restart and watch logs
sudo systemctl restart ivy-gateway
sudo journalctl -u ivy-gateway | grep -i "capture"
```

The capture service logs all DLMS packets with timing and OBIS inventory.

### Meter Not Identified

If the meter connects but isn't identified:

```bash
# Check protocol detection
sudo journalctl -u ivy-gateway | grep "Protocol detected"

# Should show: protocol: ivy_dlms
```

If it shows `unknown`, the meter may not be sending the expected IVY header or heartbeat.

---

Still stuck? Create an issue on GitHub with the diagnostic information above.

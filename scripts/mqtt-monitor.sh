#!/bin/bash
# mqtt-monitor.sh - Monitor IVY 4G Gateway MQTT topics
#
# Usage:
#   ./scripts/mqtt-monitor.sh              # All topics
#   ./scripts/mqtt-monitor.sh telemetry    # Only telemetry
#   ./scripts/mqtt-monitor.sh status       # Only status
#   ./scripts/mqtt-monitor.sh events       # Only events
#   ./scripts/mqtt-monitor.sh commands     # Only command request/response
#   ./scripts/mqtt-monitor.sh gateway      # Only gateway topics
#   ./scripts/mqtt-monitor.sh <meterId>    # Specific meter

set -euo pipefail

HOST="${MQTT_HOST:-localhost}"
PORT="${MQTT_PORT:-1883}"
USERNAME="${MQTT_USERNAME:-}"
PASSWORD="${MQTT_PASSWORD:-}"
FILTER="${1:-all}"

# Build auth flags
AUTH_FLAGS=""
if [ -n "$USERNAME" ]; then
  AUTH_FLAGS="-u $USERNAME"
  if [ -n "$PASSWORD" ]; then
    AUTH_FLAGS="$AUTH_FLAGS -P $PASSWORD"
  fi
fi

# Determine topic filter
case "$FILTER" in
  all)
    TOPIC="ivy/v1/#"
    ;;
  telemetry)
    TOPIC="ivy/v1/meters/+/telemetry"
    ;;
  status)
    TOPIC="ivy/v1/meters/+/status"
    ;;
  events)
    TOPIC="ivy/v1/meters/+/events"
    ;;
  commands|command)
    TOPIC="ivy/v1/meters/+/command/#"
    ;;
  gateway)
    TOPIC="ivy/v1/gateway/#"
    ;;
  *)
    # Assume it's a meter ID
    TOPIC="ivy/v1/meters/${FILTER}/#"
    ;;
esac

echo "=== IVY 4G Gateway MQTT Monitor ==="
echo "Host: ${HOST}:${PORT}"
echo "Topic: ${TOPIC}"
echo "Press Ctrl+C to stop"
echo "---"

# Check if mosquitto_sub is available
if ! command -v mosquitto_sub &> /dev/null; then
  echo "Error: mosquitto_sub not found. Install with:"
  echo "  sudo apt install mosquitto-clients"
  exit 1
fi

# Subscribe with formatted output
# shellcheck disable=SC2086
mosquitto_sub -h "$HOST" -p "$PORT" $AUTH_FLAGS -t "$TOPIC" -v -F '%I %t %p'

#!/bin/bash
# analyze-logs.sh - Analyze IVY 4G Gateway logs
#
# Usage: ./scripts/analyze-logs.sh [hours]
# Default: analyze last 1 hour of logs

set -euo pipefail

HOURS="${1:-1}"
SERVICE="ivy-gateway"

echo "=== IVY 4G Gateway Log Analysis (last ${HOURS}h) ==="
echo ""

# Check if service exists
if ! systemctl list-units --type=service | grep -q "$SERVICE"; then
  echo "Service '$SERVICE' not found. Checking local log files..."
  LOG_SOURCE="file"
else
  LOG_SOURCE="journal"
fi

get_logs() {
  if [ "$LOG_SOURCE" = "journal" ]; then
    journalctl -u "$SERVICE" --since "${HOURS} hours ago" --no-pager 2>/dev/null
  else
    # Fall back to log files in current directory
    if [ -f "logs/combined.log" ]; then
      cat logs/combined.log
    else
      echo "No log source found"
      exit 1
    fi
  fi
}

LOGS=$(get_logs)

echo "--- Connection Summary ---"
echo "Total connections: $(echo "$LOGS" | grep -ci "connection\|connected" || echo 0)"
echo "DLT645 detected:  $(echo "$LOGS" | grep -c "protocol.*dlt645" || echo 0)"
echo "IVY/DLMS detected: $(echo "$LOGS" | grep -c "protocol.*ivy_dlms" || echo 0)"
echo "Disconnections:    $(echo "$LOGS" | grep -ci "disconnect" || echo 0)"
echo ""

echo "--- Protocol Events ---"
echo "Heartbeats:        $(echo "$LOGS" | grep -ci "heartbeat" || echo 0)"
echo "DLMS APDUs:        $(echo "$LOGS" | grep -ci "apdu\|dlms" || echo 0)"
echo "DLT645 frames:     $(echo "$LOGS" | grep -ci "frame.*parsed\|frame.*received" || echo 0)"
echo ""

echo "--- DLMS APDU Types ---"
echo "AARE responses:    $(echo "$LOGS" | grep -ci "aare\|association" || echo 0)"
echo "GET.response:      $(echo "$LOGS" | grep -c "GET.response\|get-response" || echo 0)"
echo "EventNotification: $(echo "$LOGS" | grep -c "EventNotification\|event-notification" || echo 0)"
echo "ExceptionResponse: $(echo "$LOGS" | grep -c "ExceptionResponse\|exception-response" || echo 0)"
echo ""

echo "--- Errors ---"
echo "Error count:       $(echo "$LOGS" | grep -ci "error" || echo 0)"
echo "Warning count:     $(echo "$LOGS" | grep -ci "warn" || echo 0)"
echo ""

echo "--- Recent Errors (last 10) ---"
echo "$LOGS" | grep -i "error" | tail -10 || echo "(none)"
echo ""

echo "--- Polling ---"
echo "Poll cycles:       $(echo "$LOGS" | grep -ci "poll.*cycle\|cycle.*completed" || echo 0)"
echo "Poll failures:     $(echo "$LOGS" | grep -ci "poll.*fail" || echo 0)"
echo ""

echo "=== Analysis Complete ==="

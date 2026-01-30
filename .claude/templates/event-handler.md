# Event Handler Template

Pattern for adding event handlers in `src/index.js`.

## TCP Server Event Handler

```javascript
tcpServer.on(SERVER_EVENTS.EVENT_NAME, async (data) => {
  const { meterId, timestamp } = data;

  try {
    logger.info('Event description', { meterId });

    await publisher.publish(
      `ivy/v1/meters/${meterId}/telemetry`,
      JSON.stringify({
        meterId,
        timestamp: timestamp || Date.now(),
        source: 'protocol_type',
        // ... event-specific data
      })
    );
  } catch (error) {
    logger.error('Event handling failed', {
      meterId,
      error: error.message,
      stack: error.stack,
    });
  }
});
```

## DLMS Telemetry Handler

```javascript
tcpServer.on(SERVER_EVENTS.DLMS_TELEMETRY_RECEIVED, async (data) => {
  const { meterId, telemetry, raw } = data;

  if (telemetry?.readings) {
    for (const [key, reading] of Object.entries(telemetry.readings)) {
      const obisEntry = lookupObis(reading.obis);
      if (obisEntry?.scaler) {
        reading.value = reading.value * obisEntry.scaler;
      }
    }

    await publisher.publish(
      `ivy/v1/meters/${meterId}/telemetry`,
      JSON.stringify({
        meterId,
        timestamp: Date.now(),
        source: 'dlms',
        readings: telemetry.readings,
      })
    );
  }
});
```

## Event Naming Convention

Events use colon-separated names: `category:action`

Examples: `meter:connected`, `meter:disconnected`, `data:received`, `dlms:telemetry`, `heartbeat:received`

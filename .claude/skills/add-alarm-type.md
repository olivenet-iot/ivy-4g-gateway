# Adding a New Alarm Type

Step-by-step guide for adding a new alarm type to the status manager.

## Steps

### 1. Add Threshold

Edit `src/services/status-manager.js`:

a) Add to `DEFAULT_THRESHOLDS`:
```javascript
export const DEFAULT_THRESHOLDS = {
  // ... existing
  newMetric: { high: 100, low: 0, unit: 'units' },
};
```

b) Add to `ALARM_TYPES`:
```javascript
export const ALARM_TYPES = {
  // ... existing
  NEW_METRIC_HIGH: 'new_metric_high',
  NEW_METRIC_LOW: 'new_metric_low',
};
```

### 2. Add Check

In the `checkAlarms()` method:
```javascript
if (readings.newMetric !== undefined) {
  const threshold = this.thresholds.newMetric;
  if (readings.newMetric > threshold.high) {
    alarms.push({
      type: ALARM_TYPES.NEW_METRIC_HIGH,
      message: 'New metric exceeded threshold',
      data: { value: readings.newMetric, threshold: threshold.high },
    });
  }
  if (readings.newMetric < threshold.low) {
    alarms.push({
      type: ALARM_TYPES.NEW_METRIC_LOW,
      message: 'New metric below threshold',
      data: { value: readings.newMetric, threshold: threshold.low },
    });
  }
}
```

### 3. Add Tests

Edit `tests/unit/services/status-manager.test.js`:
```javascript
describe('new metric alarms', () => {
  it('should trigger high alarm', () => {
    const alarms = statusManager.checkAlarms({ newMetric: 150 });
    expect(alarms).toContainEqual(
      expect.objectContaining({ type: 'new_metric_high' })
    );
  });
});
```

### 4. Verify

```bash
npm run test:run -- tests/unit/services/status-manager.test.js
```

## Notes

- Alarms are published to `ivy/v1/meters/{meterId}/events`
- Both DLT645 and DLMS telemetry can trigger alarms
- DLMS telemetry includes `source: 'dlms'` to distinguish origin

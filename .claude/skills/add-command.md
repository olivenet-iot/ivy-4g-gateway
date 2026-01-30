# Adding a New MQTT Command

Step-by-step guide for adding a new command to the MQTT command handler.

## Steps

### 1. Add Command Method

Edit `src/mqtt/command-handler.js`:

a) Add to `COMMAND_METHODS`:
```javascript
export const COMMAND_METHODS = {
  // ... existing
  newCommand: 'handleNewCommand',
};
```

b) Create handler method in the CommandHandler class:
```javascript
async handleNewCommand(meterId, params) {
  // Validate params
  if (!params.requiredField) {
    return { success: false, error: 'requiredField is required' };
  }

  // Check protocol type for dual-protocol support
  const connection = this.tcpServer.connectionManager?.getConnectionByMeter(meterId);

  if (connection?.protocolType === PROTOCOL_TYPES.IVY_DLMS) {
    // DLMS path
    return this.handleNewCommandDlms(meterId, params, connection);
  }

  // DLT645 path
  const frame = buildReadFrame(meterId, params.dataId);
  const response = await this.tcpServer.sendCommand(meterId, frame, params.dataId);

  return { success: true, data: response };
}
```

### 2. Add Tests

Edit `tests/unit/mqtt/command-handler.test.js`:

```javascript
describe('handleNewCommand', () => {
  it('should handle valid request', async () => {
    const result = await handler.handleCommand(meterId, {
      command: 'newCommand',
      requiredField: 'value',
    });
    expect(result.success).toBe(true);
  });

  it('should reject missing params', async () => {
    const result = await handler.handleCommand(meterId, {
      command: 'newCommand',
    });
    expect(result.success).toBe(false);
  });
});
```

### 3. Verify

```bash
npm run test:run -- tests/unit/mqtt/command-handler.test.js
```

## MQTT Command Flow

```
Client publishes to: ivy/v1/meters/{meterId}/command/request
Gateway responds on: ivy/v1/meters/{meterId}/command/response

Request:  { "requestId": "...", "command": "newCommand", ...params }
Response: { "requestId": "...", "success": true/false, "data": {...} }
```

# Adding a New DL/T 645 Register

Step-by-step guide for adding a DL/T 645-2007 register definition.

## Steps

### 1. Add Register Definition

Edit `src/protocol/registers.js` and add to the appropriate category object:

```javascript
export const ENERGY_REGISTERS = {
  // ... existing
  NEW_REGISTER: {
    id: '00XXYY00',       // 4-byte data identifier as hex string
    name: 'New Register',
    key: 'newRegister',    // camelCase key for MQTT payloads
    unit: 'kWh',
    resolution: 0.01,      // Multiply raw BCD value by this
    bytes: 4,              // Number of data bytes
    signed: false,         // Whether MSB indicates sign
    description: 'Description of the register',
  },
};
```

### 2. Add to Polling (if needed)

Edit `src/services/polling-manager.js` and add to `DEFAULT_POLL_REGISTERS`:

```javascript
[REGISTER_GROUPS.ENERGY]: [
  // ... existing
  ENERGY_REGISTERS.NEW_REGISTER,
],
```

### 3. Add Tests

Edit `tests/unit/protocol/registers.test.js`:

```javascript
it('should define NEW_REGISTER', () => {
  expect(ENERGY_REGISTERS.NEW_REGISTER).toBeDefined();
  expect(ENERGY_REGISTERS.NEW_REGISTER.id).toBe('00XXYY00');
  expect(ENERGY_REGISTERS.NEW_REGISTER.unit).toBe('kWh');
});
```

### 4. Verify

```bash
npm run test:run -- tests/unit/protocol/registers.test.js
```

## DL/T 645 Data ID Structure

Data IDs are 4 bytes: `DI3-DI2-DI1-DI0`

| DI3 | Category |
|-----|----------|
| 0x00 | Energy readings |
| 0x01 | Maximum demand |
| 0x02 | Instantaneous values |
| 0x03 | Event records |
| 0x04 | Parameters |
| 0x09 | Prepaid (vendor-specific) |

## Reference

- See `.claude/protocols.md` for full DL/T 645 protocol details
- BCD decoding: raw bytes to decimal with resolution applied
- All data in frames has +0x33 offset (handled automatically by parser)

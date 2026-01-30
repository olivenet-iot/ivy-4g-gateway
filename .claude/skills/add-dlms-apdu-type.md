# Adding a New DLMS APDU Type

Step-by-step guide for supporting a new DLMS APDU tag.

## Steps

### 1. Add Tag to APDU Parser

Edit `src/protocol/dlms/apdu-parser.js`:

a) Add tag constant to `APDU_TAGS`:
```javascript
export const APDU_TAGS = {
  // ... existing tags
  NEW_TYPE: 0xNN,
};
```

b) Add tag name to `APDU_TAG_NAMES`:
```javascript
const APDU_TAG_NAMES = {
  // ... existing names
  [APDU_TAGS.NEW_TYPE]: 'NewType',
};
```

c) Create parser function:
```javascript
export const parseNewType = (buffer) => {
  const result = {
    type: 'new-type',
    tag: APDU_TAGS.NEW_TYPE,
    tagName: 'NewType',
    raw: buffer,
  };
  // Parse buffer contents...
  return result;
};
```

d) Add case to `parseApdu()` switch:
```javascript
case APDU_TAGS.NEW_TYPE:
  return parseNewType(buffer);
```

### 2. Register as Raw DLMS Tag

Edit `src/protocol/ivy-wrapper.js`:

a) Add to `RAW_DLMS_TAGS` set:
```javascript
export const RAW_DLMS_TAGS = new Set([
  // ... existing tags
  0xNN, // NewType
]);
```

b) Add length computation case to `computeRawDlmsLength()`:
```javascript
case 0xNN: // NewType
  // Return total byte length or -1 if incomplete
  return computeNewTypeLength(buffer);
```

### 3. Add Tests

Edit `tests/unit/protocol/dlms/apdu-parser.test.js`:

```javascript
describe('parseNewType', () => {
  it('should parse valid NewType APDU', () => {
    const buffer = Buffer.from([0xNN, /* ... */]);
    const result = parseApdu(buffer);
    expect(result.type).toBe('new-type');
    expect(result.tag).toBe(0xNN);
  });
});
```

### 4. Verify

```bash
npm run test:run -- tests/unit/protocol/dlms
```

## Reference

- DLMS APDU tags are defined in IEC 62056-5-3
- BER-TLV encoded APDUs (0x60, 0x61, 0x62, 0x63) use `computeBerTlvLength()`
- Fixed-length APDUs can return a constant
- Variable-length APDUs need a dedicated length computation function

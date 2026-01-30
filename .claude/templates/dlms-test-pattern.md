# DLMS Test Pattern Template

Vitest test patterns for DLMS protocol testing.

## APDU Parser Test

```javascript
import { describe, it, expect } from 'vitest';
import { parseApdu, APDU_TAGS } from '../../../../src/protocol/dlms/apdu-parser.js';

describe('parseNewApduType', () => {
  it('should parse valid APDU', () => {
    const buffer = Buffer.from([
      0xNN,       // APDU tag
      // ... payload bytes
    ]);

    const result = parseApdu(buffer);

    expect(result.type).toBe('new-type');
    expect(result.tag).toBe(0xNN);
    expect(result.tagName).toBe('NewType');
  });

  it('should handle minimum-length buffer', () => {
    const buffer = Buffer.from([0xNN]);
    const result = parseApdu(buffer);
    expect(result.type).toBe('new-type');
  });
});
```

## IVY Wrapper Test

```javascript
import { describe, it, expect } from 'vitest';
import { createIvyStreamParser, computeRawDlmsLength } from '../../../../src/protocol/ivy-wrapper.js';

describe('IVY stream parser with new APDU', () => {
  it('should emit packet for new APDU type', () => {
    const packets = [];
    const parser = createIvyStreamParser(
      (header, payload) => packets.push({ header, payload }),
      () => {}
    );

    const ivyHeader = Buffer.from([
      0x00, 0x01, 0x00, 0x01, 0x00, 0x01, 0x00, 0x05,
    ]);
    const payload = Buffer.from([0xNN, /* ... */]);

    parser.push(Buffer.concat([ivyHeader, payload]));

    expect(packets).toHaveLength(1);
    expect(packets[0].payload[0]).toBe(0xNN);
  });
});
```

## OBIS Registry Test

```javascript
import { describe, it, expect } from 'vitest';
import { lookupObis, getObisByCategory } from '../../../../src/protocol/dlms/obis-registry.js';

describe('OBIS registry entry', () => {
  it('should look up new OBIS code', () => {
    const entry = lookupObis('A-B:C.D.E.F');
    expect(entry).not.toBeNull();
    expect(entry.name).toBe('Expected Name');
    expect(entry.category).toBe('voltage');
    expect(entry.key).toBe('EXPECTED_KEY');
  });
});
```

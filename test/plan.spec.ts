import { summarizePlan } from '../src/db/executor.js';
import { toJsonValue } from '../src/db/values.js';
import { translateDatabaseError } from '../src/db/errors.js';

describe('summarizePlan', () => {
  it('counts node types and warns about large sequential scans', () => {
    const summary = summarizePlan(
      {
        'Node Type': 'Hash Join',
        'Total Cost': 1234.5,
        'Plan Rows': 10,
        Plans: [
          {
            'Node Type': 'Seq Scan',
            'Relation Name': 'orders',
            Schema: 'sales',
            'Total Cost': 1000,
            'Plan Rows': 2_500,
            Filter: "(status = 'refunded'::text)",
          },
          {
            'Node Type': 'Seq Scan',
            'Relation Name': 'countries',
            Schema: 'public',
            'Total Cost': 1,
            'Plan Rows': 200,
          },
          {
            'Node Type': 'Seq Scan',
            'Relation Name': 'events',
            Schema: 'public',
            'Total Cost': 9,
            'Plan Rows': 90_000,
          },
        ],
      },
      null,
      new Map([
        ['sales.orders', 250_000],
        ['public.events', 90_000],
      ]),
    );
    expect(summary.nodeTypes).toEqual({ 'Hash Join': 1, 'Seq Scan': 3 });
    // only the filtered scan over a large table may need an index; a full read of events is expected
    expect(summary.warnings).toEqual([
      expect.stringContaining('sales.orders reads ~250,000 rows to return ~2,500'),
    ]);
  });
});

describe('toJsonValue', () => {
  it('serialises dates, binary data and big integers', () => {
    expect(toJsonValue(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01T00:00:00.000Z');
    expect(toJsonValue(Buffer.from('ab'))).toBe('\\x6162');
    expect(toJsonValue(Buffer.alloc(40))).toMatch(/… \(40 bytes\)$/);
    expect(toJsonValue(10n)).toBe('10');
    expect(toJsonValue([new Date(0)])).toEqual(['1970-01-01T00:00:00.000Z']);
  });
});

describe('translateDatabaseError', () => {
  it.each([
    ['57014', /exceeded the 500 ms time limit/],
    ['25006', /read-only/],
    ['55P03', /lock/],
  ])('explains %s', (code, message) => {
    expect(translateDatabaseError({ code, message: 'x' }, 500).message).toMatch(message);
  });
});

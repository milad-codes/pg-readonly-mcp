import { loadConfig } from '../src/config.js';

const url = { DATABASE_URL: 'postgresql://reader@localhost/app' };

describe('loadConfig', () => {
  it('applies safe defaults', () => {
    const config = loadConfig(url);
    expect(config).toMatchObject({
      PG_MCP_SCHEMAS: ['public'],
      PG_MCP_MAX_ROWS: 200,
      PG_MCP_ALLOW_EXPLAIN_ANALYZE: false,
    });
    expect(config.PG_MCP_REDACT_COLUMNS.test('password_hash')).toBe(true);
  });

  it('parses schema lists and rejects invalid names', () => {
    expect(loadConfig({ ...url, PG_MCP_SCHEMAS: 'public, sales' }).PG_MCP_SCHEMAS).toEqual([
      'public',
      'sales',
    ]);
    expect(() => loadConfig({ ...url, PG_MCP_SCHEMAS: 'public;drop' })).toThrow(/invalid schema name/);
  });

  it('requires a postgres URL', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });
});

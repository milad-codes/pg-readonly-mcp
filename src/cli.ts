#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import pg from 'pg';
import { loadConfig } from './config.js';
import { Catalog } from './db/catalog.js';
import { ReadOnlyExecutor } from './db/executor.js';
import { createServer, InFlight, SERVER_NAME } from './server.js';

const log = (message: string) => process.stderr.write(`[${SERVER_NAME}] ${message}\n`);

let config;
try {
  config = loadConfig();
} catch (error) {
  log((error as Error).message);
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 4,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: SERVER_NAME,
});
pool.on('error', (error) => log(`idle client error: ${error.message}`));

const inFlight = new InFlight();
const limits = {
  allowedSchemas: config.PG_MCP_SCHEMAS,
  statementTimeoutMs: config.PG_MCP_STATEMENT_TIMEOUT_MS,
};
const server = createServer({
  executor: new ReadOnlyExecutor(pool, {
    ...limits,
    maxRows: config.PG_MCP_MAX_ROWS,
    redactColumns: config.PG_MCP_REDACT_COLUMNS,
    allowExplainAnalyze: config.PG_MCP_ALLOW_EXPLAIN_ANALYZE,
  }),
  catalog: new Catalog(pool, limits),
  maxRows: config.PG_MCP_MAX_ROWS,
  allowedSchemas: config.PG_MCP_SCHEMAS,
  log,
});

const shutdown = async () => {
  await server.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
  process.exit(0);
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
// the client closed stdin: answer what is still running, then exit
process.stdin.once('end', () => void inFlight.idle().then(shutdown));

const transport = new StdioServerTransport();
await server.connect(transport);

// Count requests from arrival to response, so closing stdin right after sending requests still gets answers.
const isRequest = (m: JSONRPCMessage) => 'method' in m && 'id' in m;
const isResponse = (m: JSONRPCMessage) => 'id' in m && ('result' in m || 'error' in m);
const receive = transport.onmessage;
transport.onmessage = (message: JSONRPCMessage) => {
  if (isRequest(message)) inFlight.start();
  receive?.(message);
};
const send = transport.send.bind(transport);
transport.send = async (message: JSONRPCMessage) => {
  try {
    await send(message);
  } finally {
    if (isResponse(message)) inFlight.end();
  }
};

log(`ready (schemas: ${config.PG_MCP_SCHEMAS.join(', ')}, max rows: ${config.PG_MCP_MAX_ROWS})`);

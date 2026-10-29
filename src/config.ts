import { z } from 'zod';

const csv = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().regex(/^[a-z_][a-z0-9_$]*$/i, 'invalid schema name')).min(1));

const EnvSchema = z.object({
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// connection string'),
  /** Schemas the assistant may read. Unqualified table names resolve only within these. */
  PG_MCP_SCHEMAS: csv.default(['public']),
  PG_MCP_MAX_ROWS: z.coerce.number().int().min(1).max(10_000).default(200),
  PG_MCP_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(300_000).default(5_000),
  /** EXPLAIN ANALYZE executes the query; off by default. */
  PG_MCP_ALLOW_EXPLAIN_ANALYZE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Result columns whose names match are masked. Convenience only; use column privileges for real protection. */
  PG_MCP_REDACT_COLUMNS: z
    .string()
    .default('password|passwd|secret|token|api_?key|ssn|iban|credit_?card')
    .transform((pattern, ctx) => {
      try {
        return new RegExp(pattern, 'i');
      } catch {
        ctx.addIssue({ code: 'custom', message: 'invalid regular expression' });
        return z.NEVER;
      }
    }),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(raw: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}

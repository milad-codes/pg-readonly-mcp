/** A database error translated into a message an assistant can act on. */
export class QueryFailedError extends Error {
  override readonly name = 'QueryFailedError';
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message);
  }
}

interface PgError {
  code?: string;
  message: string;
}

export function translateDatabaseError(error: unknown, timeoutMs: number): QueryFailedError {
  const pgError = error as PgError;
  switch (pgError.code) {
    case '57014':
      return new QueryFailedError(
        `The query exceeded the ${timeoutMs} ms time limit and was cancelled. Add filters or a LIMIT, or check the plan with explain_query.`,
        pgError.code,
      );
    case '55P03':
      return new QueryFailedError('The query waited too long for a lock and was cancelled.', pgError.code);
    case '25006':
      return new QueryFailedError(
        'The database rejected a write: this connection is read-only.',
        pgError.code,
      );
    case '42501':
      return new QueryFailedError(`The database role lacks permission: ${pgError.message}`, pgError.code);
    default:
      return new QueryFailedError(pgError.message ?? String(error), pgError.code ?? null);
  }
}

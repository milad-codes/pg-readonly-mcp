# Contributing

1. Open an issue describing the problem first.
2. Branch from `main` using a type prefix: `feat/`, `fix/`, `perf/`, `test/`, `refactor/`, `docs/`, `chore/`.
3. Keep commits focused and use [Conventional Commits](https://www.conventionalcommits.org/) messages.
4. Before opening a pull request run `npm run lint && npm run format:check && npm run typecheck && npm test`.
5. Fill in the pull request template (problem, approach, architecture, testing, trade-offs). Changes to the SQL guard need allow/deny test cases, and integration tests need a scratch database (`DATABASE_URL`).

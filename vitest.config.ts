import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.spec.ts'],
    // integration files reseed the same database
    fileParallelism: false,
    coverage: { provider: 'v8', include: ['src/**/*.ts'], exclude: ['src/cli.ts'] },
  },
});

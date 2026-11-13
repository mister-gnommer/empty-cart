import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// The eval reads SORTING_* (and optional LANGSMITH_*) from the environment;
// a local .env saves exporting them by hand. Already-set variables win.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

// Operator-only eval suite: calls the real model, so it is never part of
// `npm test`. Run with `npm run eval`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['evals/**/*.eval.ts'],
    reporters: ['default', 'langsmith/vitest/reporter'],
    testTimeout: 60_000,
  },
});

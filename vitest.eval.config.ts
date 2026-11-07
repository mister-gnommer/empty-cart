import { defineConfig } from 'vitest/config';

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

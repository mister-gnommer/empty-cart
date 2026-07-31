import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    projects: [{ root: 'tests/unit' }, { root: 'tests/contract' }, { root: 'tests/integration' }],
  },
});

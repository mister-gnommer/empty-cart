// ESLint flat config — import-boundary enforcement for Constitution Principle II.
//
// FALLBACK IN EFFECT (documented in task T004): typescript-eslint@8.65.0
// declares peer `typescript < 6.1.0` and at runtime refuses to load under
// TypeScript 7.0.2 ("typescript-eslint does not support TS 7.0"). Per T004's
// documented escape hatch, we therefore lint the COMPILED `dist/**/*.js`
// output with ESLint's default JS parser. After `tsc`, ES module `import x
// from "discord.js"` is lowered to `require("discord.js")`, which the core
// `no-restricted-modules` rule matches against its `paths` entries.
//
// CORE-RULE AVAILABILITY CORRECTION (T004): the task brief expects a core
// `no-restricted-paths` rule. ESLint 10 has no such rule (it shipped only via
// the un-published `eslint-plugin-no-restricted-paths`). The closest core
// rules are `no-restricted-imports` (handles only ES-module `import`, NOT
// `require()`) and `no-restricted-modules` (handles `require()`). Since we
// lint compiled CJS, `no-restricted-modules` is the rule that fires. Zone
// semantics (only src/discord may import discord.js; etc.) are preserved by
// applying the full restricted list globally on `dist/**` and then narrowing
// the list per-allowed-zone via later flat-config blocks (last-match wins).
//
// Workflow: run `npm run build` before `npm run lint` so `dist/` is current.
// CI (T031) runs `build` then `lint` in that order.

const ALL_RESTRICTED_PATHS = [
  {
    name: 'discord.js',
    message:
      'Only src/discord may import discord.js (Constitution Principle II).',
  },
  {
    name: 'pino',
    message: 'Only src/config and src/logger may import pino.',
  },
  {
    name: 'zod',
    message: 'Only src/config may import zod (keep schema ownership local).',
  },
];

export default [
  {
    // Default for compiled dist: NO file in dist/** may import any of the
    // three restricted libraries. Later blocks narrow the list for allowed
    // zones (src/discord, src/config, src/logger) using last-match wins.
    files: ['dist/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'readonly',
        exports: 'writable',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      'no-restricted-modules': ['error', { paths: ALL_RESTRICTED_PATHS }],
    },
  },
  {
    // src/discord/** may import discord.js — keep pino + zod restricted.
    files: ['dist/discord/**/*.js'],
    rules: {
      'no-restricted-modules': [
        'error',
        {
          paths: [
            {
              name: 'pino',
              message: 'Only src/config and src/logger may import pino.',
            },
            {
              name: 'zod',
              message:
                'Only src/config may import zod (keep schema ownership local).',
            },
          ],
        },
      ],
    },
  },
  {
    // src/config/** may import pino and zod — keep discord.js restricted.
    files: ['dist/config/**/*.js'],
    rules: {
      'no-restricted-modules': [
        'error',
        {
          paths: [
            {
              name: 'discord.js',
              message:
                'Only src/discord may import discord.js (Constitution Principle II).',
            },
          ],
        },
      ],
    },
  },
  {
    // src/logger/** may import pino — keep discord.js + zod restricted.
    files: ['dist/logger/**/*.js'],
    rules: {
      'no-restricted-modules': [
        'error',
        {
          paths: [
            {
              name: 'discord.js',
              message:
                'Only src/discord may import discord.js (Constitution Principle II).',
            },
            {
              name: 'zod',
              message:
                'Only src/config may import zod (keep schema ownership local).',
            },
          ],
        },
      ],
    },
  },
  {
    // Lint only compiled dist output. Everything else is excluded.
    ignores: ['**/*', '!dist/**'],
  },
];
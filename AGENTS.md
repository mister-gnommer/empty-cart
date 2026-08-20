# AGENTS.md — Empty Cart

- Constitution: `.specify/memory/constitution.md` — supersedes all other practices.
- Commit messages: use the `commit` skill.
- Feature specs live under `specs/[###-feature]/`.
- Code comments and test names MUST NOT reference spec document identifiers (FR-XXX, SC-XXX, contracts/*.md, data-model.md, research.md, quickstart.md, T### task IDs). Describe the behavior or constraint directly. If a reference truly saves space, use the feature name (e.g. `001-vps-discord-bot`).
- After code changes: run `npm run typecheck` (src + tests via `tsconfig.test.json`), `npm test`, and lint before committing. The main `tsc` excludes `tests/`, so `npm run typecheck` is the only command that catches test-file type errors.
- Lint: Biome (`npm run lint`, config in `biome.json`) with import-boundary zones via `noRestrictedImports`. This substitutes the ESLint `no-restricted-paths` approach planned in `001-vps-discord-bot` (typescript-eslint's declared peer range does not cover TS 7, and the plan's fallback would have linted compiled `dist/` output); the zone semantics are identical — only `src/discord/` may import `discord.js`, only `src/config/`/`src/logger/` may import `pino`, only `src/config/` may import `zod`. Adding a module that needs a new library appends one `noRestrictedImports` override entry.
- File names: the descriptive part is kebab-case (`foo-bar-does-something.helper.ts`, `foo-bar-does-something.helper.spec.ts`). Dots only separate organizational-layer suffixes (`.module.ts`, `.service.ts`, `.helper.ts`, `.spec.ts`) — never use dots to join descriptive words, so `foo.bar.does.something.helper.ts` is wrong.

# AGENTS.md — Empty Cart

- Constitution: `.specify/memory/constitution.md` — supersedes all other practices.
- Commit messages: use the `commit` skill.
- Feature specs live under `specs/[###-feature]/`.
- Code comments and test names MUST NOT reference spec document identifiers (FR-XXX, SC-XXX, contracts/*.md, data-model.md, research.md, quickstart.md, T### task IDs). Describe the behavior or constraint directly. If a reference truly saves space, use the feature name (e.g. `001-vps-discord-bot`).
- After code changes: run `npm run typecheck` (src + tests via `tsconfig.test.json`), `npm test`, and lint before committing. The main `tsc` excludes `tests/`, so `npm run typecheck` is the only command that catches test-file type errors.

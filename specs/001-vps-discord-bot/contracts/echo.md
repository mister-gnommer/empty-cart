# Contract — `echo`

**Module path**: `src/echo/`
**Depends on**: nothing outside `src/shared/types` (pure)
**Depended on by**: `discord` adapter
**Spec refs**: FR-001, FR-008, FR-013, User Story 1 acceptance #1–#4, Edge Cases mention-neutralization

## Public surface

```typescript
export type EchoResult = { /* see data-model.md Entity 4 */ };

export function handleEchoCommand(
  cmd: { args: string },
  config: Pick<Config, 'echoMaxLength' | 'commandPrefix' | 'echoCommandName'>,
): EchoResult;
```

`handleEchoCommand` is a **pure** function: no I/O, no logger, no side effects. The discord adapter owns logging (with `correlationId`) and the send call (with `allowedMentions`).

## Behavioral contract

| Input (`cmd.args` after prefix+command split) | `EchoResult.status` | `reply` content |
|---|---|---|
| `""` (empty / whitespace-only) | `usage-hint` | a short, fixed, user-facing hint, e.g. `Usage: ${commandPrefix}${echoCommandName} <text>` |
| `length > echoMaxLength` | `too-long` | a clear user-facing error naming the limit, e.g. `Input too long (max ${echoMaxLength} chars).` |
| otherwise | `echoed` | `cmd.args` **verbatim** (zero-byte-trim allowed; no other normalization) |

1. `reply` MUST be ≤ 2000 chars (Discord limit); the `echoMaxLength` default 1900 plus any framing guarantees this (research R5).
2. **Mention neutralization (FR-013)** is NOT done here by string manipulation. The contract asserts `neutralizedMentions: true` on every `echoed` result, signalling the transport that it MUST send with `allowedMentions: { parse: [], users: [], roles: [] }`. Markdown formatting tokens are echoed as-is (spec Edge Cases).
3. The function MUST NOT retain `cmd.args` after returning (FR-008: no retention beyond the log record, which is the adapter's concern).
4. The function MUST NOT access any process-global state, env, or other user's data (Constitution Principle IV cross-user isolation, "multi-user from day one" constraint).

## Test obligations (TDD — these are written first, red, then green)

- empty / whitespace → `usage-hint` with the correct prefix/command interpolation.
- exactly `echoMaxLength` chars → `echoed` (boundary).
- `echoMaxLength + 1` chars → `too-long` with the limit stated.
- payload containing `<@123>`, `@everyone`, `<@&9>`, `@here`, raw `@user` → `echoed` with `reply` **unchanged** and `neutralizedMentions: true` (the neutralization guarantee is asserted here even though the actual `allowedMentions` enforcement is tested in the discord adapter contract test).
- markdown payload (`**bold**`, `||spoiler||`, `>quote`) → `echoed` with `reply` unchanged.
- two consecutive calls with different `cmd.args` → outputs are independent (isolation sanity check proving no module state leaks between calls; the function takes only `args`, so multi-user isolation is honored structurally at the type level). A separate contract test in `tests/contract/echo.*` asserts `handleEchoCommand` references no module-scoped mutable variable (static import-scan for `let`/`var` at module scope).
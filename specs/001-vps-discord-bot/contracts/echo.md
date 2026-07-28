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

| Input (`cmd.args` after prefix+command split) | `EchoResult.status` | `reply` content (CANONICAL — tests MUST assert byte-equality) |
|---|---|---|
| `""` (empty / whitespace-only) | `usage-hint` | `Usage: ${commandPrefix}${echoCommandName} <text>` (interpolated with the active config's prefix and command name) |
| `length > echoMaxLength` | `too-long` | `Input too long (max ${echoMaxLength} chars).` (interpolated with the active config's `echoMaxLength`) |
| otherwise | `echoed` | `cmd.args` **verbatim** (zero-byte-trim allowed; no other normalization) |

1. `reply` MUST be ≤ 2000 chars (Discord hard limit). The `echoMaxLength` cap of 1900 leaves a 100-char buffer below the platform limit so a future reply-framing change (e.g. prefix line, code-block fence) does not require a config default change and does not break the contract. The constant error-text strings for `too-long` (`"Input too long (max N chars)."`) and `usage-hint` (`"Usage: <prefix><commandName> <text>"`) are well under 50 chars and never approach the 2000 limit. `echoMaxLength` is therefore a safety/forward-compat cap, not a "framing currently in use" cap.
2. **Mention neutralization (FR-013)** is NOT done here by string manipulation. The contract asserts `transportShouldNeutralizeMentions: true` on every `echoed` result, signalling the transport that it MUST send with `allowedMentions: { parse: [], users: [], roles: [] }`. The field name is intentionally a *contract signal* (`transportShould...`), NOT a guarantee that mention tokens have been neutralized inside the echo core — the echo core is pure and never inspects token strings; the actual neutralization is the transport adapter's responsibility. A future non-Discord transport reading this field MUST treat it as a directive, not as an audit that neutralization already occurred. Markdown formatting tokens are echoed as-is (spec Edge Cases).
3. The function MUST NOT retain `cmd.args` after returning (FR-008: no retention beyond the log record, which is the adapter's concern).
4. The function MUST NOT access any process-global state, env, or other user's data (Constitution Principle IV cross-user isolation, "multi-user from day one" constraint).

## Test obligations (TDD — these are written first, red, then green)

- empty / whitespace → `usage-hint` with `reply` byte-equal to `Usage: ${commandPrefix}${echoCommandName} <text>` (canonical — the interpolate is wired through the active config, not an example).
- exactly `echoMaxLength` chars → `echoed` (boundary).
- `echoMaxLength + 1` chars → `too-long` with `reply` byte-equal to `Input too long (max ${echoMaxLength} chars.` (canonical — the interpolate is the active config's `echoMaxLength`).
- payload containing `<@123>`, `@everyone`, `<@&9>`, `@here`, raw `@user` → `echoed` with `reply` **unchanged** and `transportShouldNeutralizeMentions: true` (the contract signal is asserted here even though the actual `allowedMentions` enforcement is tested in the discord adapter contract test).
- markdown payload (`**bold**`, `||spoiler||`, `>quote`) → `echoed` with `reply` unchanged.
- two consecutive calls with different `cmd.args` → outputs are independent (isolation sanity check proving no module state leaks between calls; the function takes only `args`, so multi-user isolation is honored structurally at the type level). A separate contract test in `tests/contract/echo.*` asserts `handleEchoCommand` references no module-scoped mutable variable (static import-scan for `let`/`var` at module scope).
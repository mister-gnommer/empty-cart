# Contract — `discord` (transport adapter)

**Module path**: `src/discord/`
**Depends on**: `discord.js`, `src/echo`, `src/logger`, `src/shared/types`
**Depended on by**: `lifecycle` (only module that constructs it)
**Spec refs**: FR-001, FR-004, FR-011, FR-012, FR-013, User Story 1 #4, Edge Case gateway-down

This is the **only** module permitted to import `discord.js` (Constitution Principle II: "no module may know about the user-facing transport except the transport adapter itself"). The restriction is machine-enforced in CI via the `no-restricted-paths` ESLint rule (research R10 / `plan.md` "Growth & boundary enforcement"): a linting zone forbids `from: "discord.js"` outside `src/discord/`. Implementation-phase task: write the zone entry in `eslint.config.*` during the `tasks.md` Phase 2 step that scaffolds linting. Tests/lib can import `discord.js` only via the contract's exported `DiscordAdapter` surface.

## Public surface

```typescript
export type ConnectionState = 'disconnected' | 'connected' | 'reconnecting' | 'destroyed';

export interface DiscordAdapter {
  start(): Promise<void>;                  // client.login(config.discordToken); sets BotState.discord on events
  stop(): Promise<void>;                    // client.destroy(); sets BotState.discord = 'destroyed'
  readonly state: ConnectionState;          // mirrors BotState.discord for test inspection
}

export function createDiscordAdapter(deps: {
  config: Config;
  logger: Logger;
  botState: BotState;                      // writes .discord only
  echo: typeof handleEchoCommand;
}): DiscordAdapter;
```

## Behavioral contract

1. **Intents**: `{ GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent }`. MessageContent is privileged (research R2); a missing portal toggle surfaces as a startup `warn` log, not a crash (graceful degradation Constraint).
2. **Event → state mapping**:
   - `Events.ClientReady` → `botState.discord = 'connected'`; `log info: msg="discord connected"`.
   - `Events.ShardDisconnect` → `botState.discord = 'reconnecting'` (or `'disconnected'` if fatal); `log warn: msg="discord shard disconnected"; fields: closeCode`. 
   - `Events.ShardResumed`/`Events.ShardReady` after disconnect → `botState.discord = 'connected'`; `log info: msg="discord reconnected"` (FR-012 / Edge Case gateway-down).
3. **Message routing** (`Events.MessageCreate`):
   - Ignore when `message.author.bot` (never echo bots).
   - Ignore when `message.content` lacks the prefix or the command name is not `config.echoCommandName`.
    - Otherwise build a `UserCommand` (data-model Entity 3), generate `correlationId` via `crypto.randomUUID()`, create a `childFor(logger, correlationId)` logger, emit `log info: msg="command received"; fields: userId, channelId, argsLength` (LENGTH, never content), call `echo.handleEchoCommand`, and `message.channel.send({ content: reply, allowedMentions: { parse: [], users: [], roles: [] } })`.
   - Map `EchoResult.status` → reply send + `log info: msg="command handled"; fields: status, replyLength`.
   - **Latency bound (SC-001)**: the adapter MUST produce the reply (or a user-facing error per §5/§6) within 2 seconds of receiving `Events.MessageCreate` under normal VPS load, measured from event dispatch to the `channel.send` resolution. This pins SC-001 into this contract so the success criterion is enforceable at the module boundary. **Exclusion**: the 2 s bound applies to the first-attempt send; it does NOT apply while §6 transient-transport retry is in progress (a retrying reply may exceed 2 s by design, bounded by §6's `retryTotalMs` ceiling). The retry loop's existence and SC-001 crossing are justified in `plan.md` Complexity Tracking.
4. **No ghost-ping (FR-013)**: every `channel.send` from this module MUST pass `allowedMentions: { parse: [], users: [], roles: [] }`. A contract test asserts this across all branches.
5. **Command-fulfillment failure (FR-011)**: if `echo.handleEchoCommand` throws (internal error — e.g. an unexpected runtime exception), the channel is presumably reachable, so the bot MUST send a user-facing error reply (short, fixed, **non-revealing** text — must not echo the exception message or any internal detail) and emit `log error: msg="command handler threw"; fields: userId, channelId, errorMessage`. The echo round trip stops here; the reply uses the same `allowedMentions` as a normal echo (§4). This satisfies FR-011's "report a clear user-facing error when the bot cannot fulfill a command due to an internal problem".
6. **Transient-transport failure** (`channel.send` rejects): distinct from §5 — the channel itself is temporarily unreachable (network blip, Discord REST 5xx, permissions revoked), so a user-facing error reply is not reliably deliverable. The adapter applies a short bounded retry with backoff — **at most 3 attempts within at most 3 s total**, implementation-tunable in `tasks.md` but the ceiling is pinned here: `retryAttempts ≤ 3` AND `retryTotalMs ≤ max(0, min(3000, config.shutdownTimeoutMs − 2000))` (the 2 s headroom guarantees an in-flight retry loop does not collide with the shutdown budget and SC-003/SC-001; the `max(0, …)` clamp keeps the ceiling non-negative when `shutdownTimeoutMs` is below 2000, in which case retries are effectively disabled). Cancellable by the shutdown budget (an in-flight retry MUST not block `SIGTERM`). On final failure, emit `log error: msg="reply failed after retries"; fields: errorCode, attempts` and **stop** (do not crash; do not fallback to §5 — nothing is wrong with the handler). `BotState.discord` is set to `reconnecting`/`disconnected` per §2 events if the failure indicates a connection-level problem; the health endpoint already reflects that state.
7. **Clean shutdown**: `stop()` runs in this order, all bounded by the lifecycle's shutdown budget:
   1. Set an internal `stopping` gate so any newly-arriving `Events.MessageCreate` is ignored (not dispatched to `echo`, not sent).
   2. Remove the `Events.MessageCreate` listener from the client (committing to lifecycle.md §3's "stop accepting new Discord events").
   3. Cancel any in-flight §6 retry loop immediately (AbortController or equivalent).
   4. `client.destroy()`; awaits its Promise.
   5. Set `botState.discord = 'destroyed'`; `log info: msg="discord disconnected"`.
   In-flight handler calls already past the gate when `stop()` is invoked are allowed to complete their `channel.send` if it returns within the remaining shutdown budget; if it exceeds the budget the lifecycle's outer race abandons it (process exits 1 per lifecycle.md §3). The adapter does not await individual in-flight handlers beyond the gate.
8. **Logs never contain content**: only `argsLength` and `replyLength` (and never raw text) MAY be logged. The wire-format shape of every line above is owned by `contracts/logger.md`; this contract specifies only the events' content (severity, `msg`, named fields).

## Test obligations

- **Contract** tests assert every state transition in (2) by emitting discord.js events on a constructed `Client` (use discord.js's real `Client` with a stubbed `login`/`destroy`, no real WebSocket).
- A contract test asserts `allowedMentions` is the empty-parse shape on **every** send branch of (3)/(5)/(6) — the enforcement point for FR-013.
- A contract test asserts `(5)`: echo handler throw → user-facing error reply sent (with no exception text leaked in the reply) + `error` log line with `msg="command handler threw"`. (FR-011.)
- A contract test asserts `(6)`: `channel.send` rejecting → bounded retry honoring the §6 ceiling (`attempts ≤ 3`, `totalMs ≤ max(0, min(3000, shutdownTimeoutMs − 2000))`, cancellable by shutdown) and, on final failure, no crash and no new state transition beyond §2's normal `reconnecting`/`disconnected`; on shutdown cancelled retry, `stop()` still resolves within the lifecycle budget.
- A contract test asserts `(7)`: `stop()` sets the `stopping` gate, removes the `MessageCreate` listener (no new MessageCreate is dispatched to `echo` after `stop()` begins), cancels in-flight §6 retries, calls `client.destroy()`, sets `botState.discord === 'destroyed'`, and logs `msg="discord disconnected"`.
- An integration test asserts a hand-driven `Events.MessageCreate` produces the expected `reply` on a stubbed `channel.send`, with a `correlationId` present on every log line for that handler call.
- A contract test asserts no log line emitted by this module contains raw `args` or `reply` text — only `argsLength`/`replyLength` numeric fields are present (§8, FR-004/FR-008).
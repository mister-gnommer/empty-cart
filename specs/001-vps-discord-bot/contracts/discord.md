# Contract — `discord` (transport adapter)

**Module path**: `src/discord/`
**Depends on**: `discord.js`, `src/echo`, `src/logger`, `src/shared/types`
**Depended on by**: `lifecycle` (only module that constructs it)
**Spec refs**: FR-001, FR-004, FR-011, FR-012, FR-013, User Story 1 #4, Edge Case gateway-down

This is the **only** module permitted to import `discord.js` (Constitution Principle II: "no module may know about the user-facing transport except the transport adapter itself").

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
   - Otherwise build a `UserCommand` (data-model Entity 3), generate `correlationId` via `crypto.randomUUID()`, create a `childFor(logger, correlationId)` logger, emit `log info: msg="command received"; fields: userId, channelId, argsLength` (LENGTH, never content), call `echo.handleEchoCommand`, and `message.channel.send(reply, { allowedMentions: { parse: [], users: [], roles: [] } })`.
   - Map `EchoResult.status` → reply send + `log info: msg="command handled"; fields: status, replyLength`.
4. **No ghost-ping (FR-013)**: every `channel.send` from this module MUST pass `allowedMentions: { parse: [], users: [], roles: [] }`. A contract test asserts this across all branches.
5. **User-facing failure (FR-011)**: if `channel.send` rejects (network, permissions), catch, emit `log error: msg="reply failed"; fields: errorCode`, and attempt ONE retry. If the retry also fails, emit `log error: msg="reply failed after retry"; fields: errorCode` and **stop** (do not crash the process); the health endpoint already reflects Discord connection state.
6. **Clean shutdown**: `stop()` calls `client.destroy()` and awaits it trapped by the lifecycle's budget; sets `botState.discord = 'destroyed'`; `log info: msg="discord disconnected"`.
7. **Logs never contain content**: only `argsLength` and `replyLength` (and never raw text) MAY be logged. The wire-format shape of every line above is owned by `contracts/logger.md`; this contract specifies only the events' content (severity, `msg`, named fields).

## Test obligations

- **Contract** tests assert every state transition in (2) by emitting discord.js events on a constructed `Client` (use discord.js's real `Client` with a stubbed `login`/`destroy`, no real WebSocket).
- A contract test asserts `allowedMentions` is the empty-parse shape on **every** send branch of (3)/(5) — the enforcement point for FR-013.
- An integration test asserts a hand-driven `Events.MessageCreate` produces the expected `reply` on a stubbed `channel.send`, with a `correlationId` present on every log line for that handler call.
- A `stop()` contract test asserts `client.destroy()` was called and `botState.discord === 'destroyed'`.
import { Client, type CloseEvent, Events, GatewayIntentBits } from 'discord.js';
import { vi } from 'vitest';

/**
 * Builds a `Client` whose `login` and `destroy` are stubbed (no real WebSocket
 * connection) and which is typed as `Client<true>` so test code can drive
 * `Events.ClientReady` (and any other ready-typed event) through `emit`
 * without per-callsite casts.
 *
 * Safe: the stubbed client never performs a real WebSocket login, so it never
 * transitions to the runtime "ready" state that would normally make
 * `Client<Ready>` narrow to `Client<true>`. Tests drive `ClientReady` (and
 * other events) via `emit` against the same instance the adapter listened on,
 * and `Client<true>` is assignable to the `Client` (= `Client<boolean>`)
 * param of `createDiscordAdapter`. The cast is the single place where we
 * bridge the stub's "behaves as ready" assumption into the type system; every
 * `emit` overload in the test suite then resolves naturally.
 */
export function makeStubbedClient(): Client<true> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
  client.login = vi.fn(async () => 'fake-token');
  client.destroy = vi.fn(async () => undefined);
  return client as unknown as Client<true>;
}

/**
 * Typed emit wrappers for the events tests fire against a stubbed client.
 *
 * discord.js types each event payload as a fixed tuple (see `ClientEvents` in
 * the discord.js typings). Most adapter handlers read only a subset of each
 * tuple (e.g. `ShardDisconnect` reads `closeEvent.code`; `ShardReady` ignores
 * both args), but `client.emit` enforces the full tuple shape, so partial test
 * stubs need bridging. Routing every emit through these helpers keeps the
 * bridging in one place — callers pass permissive stub data and the helper
 * shapes it to the discord.js signature.
 */

// Safe: tests pass a partial stand-in for `Message` (only the fields the
// adapter reads: `author.bot`, `author.id`, `content`, `guild?.id`,
// `channelId`, `channel.id`, `channel.send`). The cast bridges that partial
// shape to the `OmitPartialGroupDMChannel<Message>` tuple element.
export function emitMessage(client: Client<true>, message: unknown): void {
  client.emit(Events.MessageCreate, message as never);
}

// Safe: the adapter's ShardDisconnect handler reads only `closeEvent.code`;
// `reason` and `wasClean` are tuples-only padding that the handler ignores.
export function emitShardDisconnect(client: Client<true>, code: number, shardId: number): void {
  const closeEvent: CloseEvent = { code, reason: '', wasClean: false };
  client.emit(Events.ShardDisconnect, closeEvent, shardId);
}

export function emitShardResume(client: Client<true>, shardId: number, replayedEvents = 0): void {
  client.emit(Events.ShardResume, shardId, replayedEvents);
}

// Safe: `unavailableGuilds` is padded as `undefined` — the adapter's
// ShardReady handler ignores both args.
export function emitShardReady(client: Client<true>, shardId: number): void {
  client.emit(Events.ShardReady, shardId, undefined);
}

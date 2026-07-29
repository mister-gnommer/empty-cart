// Per-command / per-event correlation id. Used by lifecycle's §2 idempotent
// second-signal warn (contracts/lifecycle.md) and the discord adapter's §2
// disconnect-reconnect trace (contracts/discord.md FR-012). Not used for the
// UserCommand-level correlation ID generation in the discord adapter message
// handler — that path also wraps crypto.randomUUID() to produce its own
// command-scoped id (data-model.md Entity 3); the helper is provided here so
// every caller goes through the single well-known primitive, keeping the type
// of the value (`crypto.randomUUID()`) owned in one place.
import { randomUUID } from 'node:crypto';

export function newCorrelationId(): string {
  return randomUUID();
}
// createDiscordAdapter — the ONLY module permitted to import discord.js
// (Constitution Principle II; enforced by biome.json's `noRestrictedImports`
// zones). Implements the discord contract: intents, event→state mapping with
// reconnect correlationId, message routing with childFor(correlationId),
// allowedMentions empty-parse on every send, handler-throw canonical
// error reply, bounded retry ceiling, clean shutdown.
import { Client, Events, GatewayIntentBits, type Message } from 'discord.js';
import type { Logger } from 'pino';
import type { handleEchoCommand } from '../echo/handle-echo';
import { childFor } from '../logger/create-logger';
import { newCorrelationId } from '../shared/correlation-id';
import type { BotState, Config, ConnectionState, EchoResult, UserCommand } from '../shared/types';

const EMPTY_ALLOWED_MENTIONS = {
  parse: [] as string[],
  users: [] as string[],
  roles: [] as string[],
};

export type { ConnectionState } from '../shared/types';

export interface DiscordAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly state: ConnectionState;
}

export function createDiscordAdapter(deps: {
  config: Config;
  logger: Logger;
  botState: BotState;
  echo: typeof handleEchoCommand;
  /**
   * Optional test seam: a factory that returns the underlying `Client`.
   * Production callers MUST omit it — the adapter then constructs its own
   * `new Client({ intents: [...] })` (Constitution Principle II: the adapter
   * owns its own transport). Tests inject a factory returning a stubbed
   * Client (login/destroy stubbed) so contract tests can drive events
   * through the same Client reference the adapter registered listeners on.
   * This is NOT part of the adapter's public surface; production
   * callers never see it.
   */
  clientFactory?: () => Client;
}): DiscordAdapter {
  const { config, logger, botState, echo } = deps;

  const client = deps.clientFactory
    ? deps.clientFactory()
    : new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
        ],
      });

  let currentConnection: ConnectionState = 'disconnected';
  let stopping = false;
  // Reconnect correlation id that survives from ShardDisconnect → subsequent
  // ShardResumed/ShardReady so the disconnect→reconnect pair is traceable
  // as one unit.
  let pendingReconnectCorrelationId: string | null = null;

  // In-flight retry loops; stop() aborts them all.
  const activeAbortControllers = new Set<AbortController>();

  function setState(s: ConnectionState): void {
    currentConnection = s;
    botState.discord = s;
  }

  // ---- §2 ----
  client.on(Events.ClientReady, () => {
    pendingReconnectCorrelationId = null;
    setState('connected');
    logger.info({ msg: 'discord connected' });
  });

  client.on(Events.ShardDisconnect, (event: { code?: number } | undefined) => {
    const corrId = newCorrelationId();
    pendingReconnectCorrelationId = corrId;
    setState('reconnecting');
    logger.warn({
      msg: 'discord shard disconnected',
      closeCode: event?.code,
      correlationId: corrId,
    });
  });

  const resumedOrReconnect = (): void => {
    const corrId = pendingReconnectCorrelationId ?? newCorrelationId();
    pendingReconnectCorrelationId = null;
    setState('connected');
    logger.info({ msg: 'discord reconnected', correlationId: corrId });
  };
  client.on(Events.ShardResume, resumedOrReconnect);
  client.on(Events.ShardReady, () => {
    // Only treat as a reconnect if a disconnect preceded it. Otherwise the
    // initial ClientReady handler owns the first connection.
    if (pendingReconnectCorrelationId) {
      resumedOrReconnect();
    }
  });

  // ---- §3 message routing ----
  const onMessageCreate = async (message: Message): Promise<void> => {
    if (stopping) return;
    if (message.author?.bot) return;
    const content = message.content ?? '';
    if (!content.startsWith(config.commandPrefix)) return;
    const afterPrefix = content.slice(config.commandPrefix.length);
    const spaceIdx = afterPrefix.search(/\s/);
    const commandName = (
      spaceIdx === -1 ? afterPrefix : afterPrefix.slice(0, spaceIdx)
    ).toLowerCase();
    if (commandName !== config.echoCommandName) return;
    const args = spaceIdx === -1 ? '' : afterPrefix.slice(spaceIdx + 1).trimStart();

    const corrId = newCorrelationId();
    const channelId = message.channelId || message.channel?.id || '';
    const cmd: UserCommand = {
      correlationId: corrId,
      userId: message.author.id,
      guildId: message.guild?.id ?? null,
      channelId,
      rawContent: content,
      commandName,
      args,
      receivedAt: Date.now(),
    };
    const log = childFor(logger, corrId);
    log.info({
      msg: 'command received',
      userId: cmd.userId,
      channelId: cmd.channelId,
      argsLength: args.length,
    });

    let result: EchoResult;
    try {
      result = echo(cmd, config);
    } catch (err) {
      // §5: handler-throw — send the canonical non-revealing error reply and
      // log an error with the user-typed event content. NEVER leak exception
      // text into the reply.
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error({
        msg: 'command handler threw',
        userId: cmd.userId,
        channelId: cmd.channelId,
        errorMessage,
      });
      // Safe: message.channel for guild text-message events is always a
      // sendable TextBasedChannel (the PartialGroupDMChannel arm of the
      // discord.js union cannot receive Events.MessageCreate; the cast dodges
      // the union's narrowing without weakening the runtime contract).
      await sendWithRetry(message.channel as unknown as SendableChannel, {
        content: 'An internal error occurred while processing your command.',
        allowedMentions: EMPTY_ALLOWED_MENTIONS,
      });
      return;
    }

    await sendWithRetry(message.channel as unknown as SendableChannel, {
      content: result.reply,
      allowedMentions: EMPTY_ALLOWED_MENTIONS,
    });
    log.info({
      msg: 'command handled',
      status: result.status,
      replyLength: result.reply.length,
    });
  };
  client.on(Events.MessageCreate, onMessageCreate);

  // ---- §6 bounded retry ----
  // The runtime channel exposes `.send(payload)`. discord.js's typing of
  // `Message.channel` is a discriminated union that narrows to
  // `PartialGroupDMChannel` (which has no `send`) on one branch, so we
  // deliberately type the channel loosely here — the adapter's contract owns
  // the allowed payloads (content + allowedMentions only).
  type SendableChannel = { send(payload: unknown): Promise<unknown> } | undefined;
  async function sendWithRetry(
    channel: SendableChannel,
    opts: { content: string; allowedMentions: typeof EMPTY_ALLOWED_MENTIONS },
  ): Promise<void> {
    const maxAttempts = 3;
    const totalMs = Math.max(0, Math.min(3000, config.shutdownTimeoutMs - 2000));
    const abortController = new AbortController();
    activeAbortControllers.add(abortController);

    try {
      const start = Date.now();
      let attempt = 0;
      let lastErr: unknown = null;
      while (attempt < maxAttempts) {
        if (abortController.signal.aborted) return;
        if (attempt > 0 && Date.now() - start >= totalMs) break;
        attempt += 1;
        try {
          await channel?.send(opts);
          return;
        } catch (err) {
          lastErr = err;
          if (abortController.signal.aborted) return;
          if (totalMs === 0 || attempt >= maxAttempts) break;
          const remaining = totalMs - (Date.now() - start);
          if (remaining <= 0) break;
          const backoff = Math.min(remaining, 30 * attempt);
          await waitFor(backoff, abortController.signal).catch(() => {
            // never crash the loop on abort
          });
        }
      }
      const errorCode = lastErr instanceof Error ? lastErr.message : String(lastErr);
      logger.error({
        msg: 'reply failed after retries',
        errorCode,
        attempts: attempt,
      });
    } finally {
      activeAbortControllers.delete(abortController);
    }
  }

  function waitFor(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(
        () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        },
        Math.max(0, ms),
      );
      function onAbort(): void {
        clearTimeout(timer);
        resolve();
      }
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  // ---- §7 clean shutdown ----
  async function stop(): Promise<void> {
    stopping = true;
    client.removeListener(Events.MessageCreate, onMessageCreate);
    for (const ac of activeAbortControllers) {
      ac.abort();
    }
    activeAbortControllers.clear();
    await client.destroy();
    setState('destroyed');
    logger.info({ msg: 'discord disconnected' });
  }

  async function start(): Promise<void> {
    await client.login(config.discordToken);
  }

  return {
    start,
    stop,
    get state(): ConnectionState {
      return currentConnection;
    },
  };
}

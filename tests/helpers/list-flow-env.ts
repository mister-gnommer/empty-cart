// Message-in → reply-out harness for the list flow: the REAL adapter, REAL
// submission handler and REAL image validator, wired over a stubbed Discord
// client and a scripted fetch seam. The caller supplies the OCR provider, so
// nothing here reaches an external service.
import type { Client } from 'discord.js';
import { vi } from 'vitest';
import { createDiscordAdapter, type DiscordAdapterDeps } from '../../src/discord/adapter';
import { handleEchoCommand } from '../../src/echo/handle-echo';
import { fetchAndValidateImage } from '../../src/image/fetch-image';
import type { OcrProvider } from '../../src/ocr/types';
import type { Config } from '../../src/shared/types';
import { createListSubmissionHandler } from '../../src/shopping-list/handle-list-submission';
import { usageHintMessage } from '../../src/shopping-list/messages';
import { makeConfig } from './config-fixture';
import { makeCapturingLogger } from './logger';
import { createScriptedFetch, type ScriptedFetchEntry } from './scripted-fetch';
import { makeStubbedClient } from './stubbed-client';

export const EMPTY_MENTIONS = { parse: [], users: [], roles: [] };

export type FakeAttachment = {
  url: string;
  proxyURL: string;
  size: number;
  contentType: string | null;
};

/**
 * A Discord attachment stand-in whose proxyURL differs from url, so a test can
 * tell which of the two was fetched.
 * @param size the size Discord reports, which may differ from the real body
 */
export function attachment(url: string, contentType: string | null, size = 12): FakeAttachment {
  return { url, proxyURL: `https://media.proxy.test/proxy-of/${url}`, size, contentType };
}

/**
 * Builds a raw message the adapter accepts, plus the spy behind its channel.send.
 * @param opts threadParentId turns the channel into a thread under that parent
 */
export function buildMessage(opts: {
  content?: string;
  authorBot?: boolean;
  authorId?: string;
  channelId?: string;
  attachments?: FakeAttachment[];
  system?: boolean;
  threadParentId?: string;
}) {
  const channelId = opts.channelId ?? 'chan-1';
  const send = vi.fn(async (..._args: unknown[]) => undefined);
  const threadParentId = opts.threadParentId;
  const channel =
    threadParentId === undefined
      ? { id: channelId, send, isThread: () => false, parentId: 'category-1' }
      : { id: channelId, send, isThread: () => true, parentId: threadParentId };
  const raw = {
    author: { bot: opts.authorBot ?? false, id: opts.authorId ?? 'user-1' },
    content: opts.content ?? '',
    system: opts.system ?? false,
    guild: { id: 'guild-1' },
    channelId,
    channel,
    attachments: new Map((opts.attachments ?? []).map((a, i) => [String(i), a])),
  };
  return { raw, send };
}

/** The payload of every channel.send call, in call order. */
export function sentPayloads(
  send: ReturnType<typeof vi.fn>,
): Array<{ content: string; allowedMentions: unknown }> {
  return send.mock.calls.map((call) => {
    // Safe: send is the stubbed channel.send; its first argument is the
    // documented { content, allowedMentions } payload.
    return call[0] as { content: string; allowedMentions: unknown };
  });
}

export type ListFlowEnv = {
  adapter: ReturnType<typeof createDiscordAdapter>;
  client: Client<true>;
  cap: ReturnType<typeof makeCapturingLogger>;
  scriptedFetch: ReturnType<typeof createScriptedFetch>;
};

/**
 * Wires the real list flow around the given provider. The caller owns
 * stopping the adapter.
 * @param opts logger replaces the capturing logger (cap then stays empty)
 */
export function buildListFlowEnv(opts: {
  provider: OcrProvider;
  fetchEntries: ScriptedFetchEntry[];
  config?: Config;
  logger?: DiscordAdapterDeps['logger'];
}): ListFlowEnv {
  const cap = makeCapturingLogger();
  // Safe: the capturing logger satisfies pino's Logger call surface
  // structurally; `as never` only bridges the nominal pino import.
  const logger = opts.logger ?? (cap.logger as never);
  const config = opts.config ?? makeConfig();
  const client = makeStubbedClient();
  const scriptedFetch = createScriptedFetch(opts.fetchEntries);
  const listSubmission = createListSubmissionHandler({
    provider: opts.provider,
    fetchImage: (fetchInput) => fetchAndValidateImage(fetchInput, scriptedFetch.fetchImpl),
    languageHints: config.ocrLanguageHints,
    logger,
    now: Date.now,
  });
  const adapter = createDiscordAdapter({
    config,
    logger,
    botState: {
      phase: 'running',
      discord: 'connected',
      startedAt: Date.now(),
      lastStateChangeAt: Date.now(),
    },
    echo: handleEchoCommand,
    clientFactory: () => client,
    listSubmission,
    usageHint: usageHintMessage(config.commandPrefix),
  });
  return { adapter, client, cap, scriptedFetch };
}

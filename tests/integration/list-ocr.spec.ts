import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { OcrProviderResult } from '../../src/ocr/types';
import { usageHintMessage } from '../../src/shopping-list/messages';
import { JPEG_BYTES, PNG_BYTES } from '../helpers/image-fixtures';
import {
  attachment,
  buildListFlowEnv,
  buildMessage,
  EMPTY_MENTIONS,
  sentPayloads,
} from '../helpers/list-flow-env';
import type { ScriptedFetchEntry } from '../helpers/scripted-fetch';
import {
  createStubOcrProvider,
  deferred,
  okResult,
  type StubScriptEntry,
} from '../helpers/stub-ocr-provider';
import { emitMessage } from '../helpers/stubbed-client';

// End-to-end message-in → reply-out through the REAL adapter and REAL
// submission handler, against the stubbed Discord client, a scripted fetch
// seam, and the stub OCR provider — zero external calls.

/** Builds the list flow over a stub provider and stops its adapter when the test ends. */
function buildEnv(opts: { fetchEntries: ScriptedFetchEntry[]; script: StubScriptEntry[] }) {
  const provider = createStubOcrProvider(opts.script);
  const env = buildListFlowEnv({ provider, fetchEntries: opts.fetchEntries });
  onTestFinished(() => env.adapter.stop());
  return { ...env, provider };
}

describe('integration: list OCR round trip', () => {
  it('one image attachment → reply posted to the originating channel, byte-identical to the recognized text', async () => {
    const env = buildEnv({
      fetchEntries: [{ body: { bytes: PNG_BYTES } }],
      script: [okResult('Milk\nEggs\nBread')],
    });
    const msg = buildMessage({
      attachments: [attachment('https://cdn.test/list.png', 'image/png')],
    });
    emitMessage(env.client, msg.raw);

    await vi.waitFor(() => expect(msg.send).toHaveBeenCalledTimes(1));
    expect(sentPayloads(msg.send)[0]).toEqual({
      content: 'Milk\nEggs\nBread',
      allowedMentions: EMPTY_MENTIONS,
    });
    // The original CDN url was fetched — never the media proxy.
    expect(env.scriptedFetch.requestedUrls).toEqual(['https://cdn.test/list.png']);
  });

  it('recognized text containing mention tokens is posted byte-for-byte with mentions neutralized at the transport', async () => {
    const mentionText = '@everyone <@123456789012345678> <@&987654321098765432> Milk';
    const env = buildEnv({
      fetchEntries: [{ body: { bytes: PNG_BYTES } }],
      script: [okResult(mentionText)],
    });
    const msg = buildMessage({
      attachments: [attachment('https://cdn.test/list.png', 'image/png')],
    });
    emitMessage(env.client, msg.raw);

    await vi.waitFor(() => expect(msg.send).toHaveBeenCalledTimes(1));
    expect(sentPayloads(msg.send)[0]).toEqual({
      content: mentionText,
      allowedMentions: EMPTY_MENTIONS,
    });
  });

  it('a two-image message → combined text in attachment order', async () => {
    const env = buildEnv({
      fetchEntries: [{ body: { bytes: JPEG_BYTES } }, { body: { bytes: PNG_BYTES } }],
      script: [okResult('First page'), okResult('Second page')],
    });
    const msg = buildMessage({
      attachments: [
        attachment('https://cdn.test/one.jpg', 'image/jpeg'),
        attachment('https://cdn.test/two.png', 'image/png'),
      ],
    });
    emitMessage(env.client, msg.raw);

    await vi.waitFor(() => expect(msg.send).toHaveBeenCalledTimes(1));
    expect(sentPayloads(msg.send)[0].content).toBe('First page\nSecond page');
    expect(env.scriptedFetch.requestedUrls).toEqual([
      'https://cdn.test/one.jpg',
      'https://cdn.test/two.png',
    ]);
    expect(env.provider.calls.map((c) => c.format)).toEqual(['jpeg', 'png']);
  });

  it('a text-only message in a processed channel → the usage hint naming !help', async () => {
    const env = buildEnv({ fetchEntries: [], script: [] });
    const msg = buildMessage({ content: 'what should I cook?' });
    emitMessage(env.client, msg.raw);

    await vi.waitFor(() => expect(msg.send).toHaveBeenCalledTimes(1));
    const reply = sentPayloads(msg.send)[0];
    expect(reply.content).toBe(usageHintMessage('!'));
    expect(reply.allowedMentions).toEqual(EMPTY_MENTIONS);
    expect(env.provider.calls).toHaveLength(0);
  });

  it('two concurrent submissions from different users in different channels each receive their own text in their own channel', async () => {
    const gate = deferred<OcrProviderResult>();
    const env = buildEnv({
      fetchEntries: [{ body: { bytes: PNG_BYTES } }, { body: { bytes: PNG_BYTES } }],
      script: [() => gate.promise, okResult('B-page-text')],
    });
    const msg1 = buildMessage({
      authorId: 'user-1',
      channelId: 'chan-1',
      attachments: [attachment('https://cdn.test/u1.png', 'image/png')],
    });
    const msg2 = buildMessage({
      authorId: 'user-2',
      channelId: 'chan-2',
      attachments: [attachment('https://cdn.test/u2.png', 'image/png')],
    });

    emitMessage(env.client, msg1.raw);
    await vi.waitFor(() => expect(env.provider.calls).toHaveLength(1));

    emitMessage(env.client, msg2.raw);
    await vi.waitFor(() => expect(msg2.send).toHaveBeenCalledTimes(1));
    // The second user is served while the first submission is still in flight.
    expect(sentPayloads(msg2.send)[0].content).toBe('B-page-text');
    expect(msg1.send).not.toHaveBeenCalled();

    gate.resolve(okResult('A-page-text'));
    await vi.waitFor(() => expect(msg1.send).toHaveBeenCalledTimes(1));
    expect(sentPayloads(msg1.send)[0].content).toBe('A-page-text');
  });
});

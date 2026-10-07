import { describe, expect, it, vi } from 'vitest';
import { MAX_IMAGE_BYTES } from '../../src/image/fetch-image';
import { LIST_MESSAGES } from '../../src/shopping-list/messages';
import { PNG_BYTES } from '../helpers/image-fixtures';
import {
  attachment,
  buildListFlowEnv,
  buildMessage,
  type FakeAttachment,
  sentPayloads,
} from '../helpers/list-flow-env';
import type { ScriptedFetchEntry } from '../helpers/scripted-fetch';
import {
  createStubOcrProvider,
  okResult,
  type StubScriptEntry,
  unavailableResult,
} from '../helpers/stub-ocr-provider';
import { emitMessage } from '../helpers/stubbed-client';

// Message-in → reply-out for every non-happy outcome, through the REAL
// adapter, REAL handler, and REAL image validator over a scripted fetch
// seam, against the stub OCR provider — zero external calls.

const GIF_BYTES = new TextEncoder().encode('GIF89a-not-accepted');

/**
 * Sends one message through the real list flow and waits for its single reply.
 * @returns the stub provider (for call assertions), the fetch seam, and the reply texts
 */
async function roundTrip(opts: {
  fetchEntries: ScriptedFetchEntry[];
  script: StubScriptEntry[];
  attachments: FakeAttachment[];
}) {
  const stub = createStubOcrProvider(opts.script);
  const env = buildListFlowEnv({ provider: stub, fetchEntries: opts.fetchEntries });
  try {
    const msg = buildMessage({ attachments: opts.attachments });
    emitMessage(env.client, msg.raw);
    await vi.waitFor(() => expect(msg.send).toHaveBeenCalledTimes(1));
    const replies = sentPayloads(msg.send).map((p) => p.content);
    return { stub, scriptedFetch: env.scriptedFetch, replies };
  } finally {
    await env.adapter.stop();
  }
}

const PNG_ATTACHMENT = attachment('https://cdn.test/list.png', 'image/png');

describe('integration: every service-side cause yields the same single generic message', () => {
  it('provider unavailable', async () => {
    const { replies } = await roundTrip({
      fetchEntries: [{ body: { bytes: PNG_BYTES } }],
      script: [unavailableResult('unreachable')],
      attachments: [PNG_ATTACHMENT],
    });
    expect(replies).toEqual([LIST_MESSAGES.serviceUnavailable]);
  });

  it('attachment cannot be retrieved (HTTP 500)', async () => {
    const { replies, stub } = await roundTrip({
      fetchEntries: [{ status: 500 }],
      script: [okResult('never')],
      attachments: [PNG_ATTACHMENT],
    });
    expect(replies).toEqual([LIST_MESSAGES.serviceUnavailable]);
    expect(stub.calls).toHaveLength(0);
  });

  it('provider throws unexpectedly — no crash, no technical detail', async () => {
    const { replies } = await roundTrip({
      fetchEntries: [{ body: { bytes: PNG_BYTES } }],
      script: [
        () => {
          throw new Error('grpc stack trace with internals');
        },
      ],
      attachments: [PNG_ATTACHMENT],
    });
    expect(replies).toEqual([LIST_MESSAGES.serviceUnavailable]);
  });
});

describe('integration: each input problem yields its own distinct actionable message', () => {
  it('no readable text', async () => {
    const { replies } = await roundTrip({
      fetchEntries: [{ body: { bytes: PNG_BYTES } }],
      script: [okResult('   ')],
      attachments: [PNG_ATTACHMENT],
    });
    expect(replies).toEqual([LIST_MESSAGES.noReadableText]);
  });

  it('locally unsupported format → rejected with zero downloads and zero provider calls', async () => {
    const { replies, stub, scriptedFetch } = await roundTrip({
      fetchEntries: [],
      script: [okResult('never')],
      attachments: [attachment('https://cdn.test/anim.gif', 'image/gif')],
    });
    expect(replies).toEqual([LIST_MESSAGES.unsupportedFormat]);
    expect(scriptedFetch.requestedUrls).toHaveLength(0);
    expect(stub.calls).toHaveLength(0);
  });

  it('corrupt content behind an accepted content type → unsupported format, zero provider calls', async () => {
    const { replies, stub } = await roundTrip({
      fetchEntries: [{ body: { bytes: GIF_BYTES } }],
      script: [okResult('never')],
      attachments: [PNG_ATTACHMENT],
    });
    expect(replies).toEqual([LIST_MESSAGES.unsupportedFormat]);
    expect(stub.calls).toHaveLength(0);
  });

  it('oversize image → too-large message with zero downloads and zero provider calls', async () => {
    const { replies, stub, scriptedFetch } = await roundTrip({
      fetchEntries: [],
      script: [okResult('never')],
      attachments: [attachment('https://cdn.test/huge.png', 'image/png', MAX_IMAGE_BYTES + 1)],
    });
    expect(replies).toEqual([LIST_MESSAGES.imageTooLarge]);
    expect(scriptedFetch.requestedUrls).toHaveLength(0);
    expect(stub.calls).toHaveLength(0);
  });
});

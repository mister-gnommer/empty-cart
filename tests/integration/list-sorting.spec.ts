import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { CategoryId } from '../../src/list-sorting/category-catalog';
import { SORTING_BUDGET_MS } from '../../src/shopping-list/list-graph';
import { LIST_MESSAGES } from '../../src/shopping-list/messages';
import { PNG_BYTES } from '../helpers/image-fixtures';
import {
  attachment,
  buildListFlowEnv,
  buildMessage,
  EMPTY_MENTIONS,
  sentPayloads,
} from '../helpers/list-flow-env';
import { buildHandler, okFetch, submission } from '../helpers/list-submission-env';
import {
  createStubCategorizer,
  failedAnswer,
  okAnswer,
  type StubCategorizerEntry,
} from '../helpers/stub-categorizer';
import { createStubOcrProvider, okResult } from '../helpers/stub-ocr-provider';
import { emitMessage } from '../helpers/stubbed-client';

// End-to-end message-in → reply-out with sorting on: the REAL adapter, handler
// and list graph over a stub OCR provider and a stub categorizer.

/**
 * Sends one list photo whose recognized text is `text`, sorted with `categories`.
 * @param text what the stub OCR recognizes
 * @param categories what the stub categorizer assigns, one per non-blank line
 */
async function sendSortedPhoto(text: string, categories: CategoryId[]) {
  return sendPhoto(text, okAnswer(categories));
}

/**
 * Sends one list photo whose recognized text is `text`; the categorizer answers with `entry`.
 * @param text what the stub OCR recognizes
 * @param entry the stub categorizer's scripted behaviour
 */
async function sendPhoto(text: string, entry: StubCategorizerEntry) {
  const env = buildListFlowEnv({
    provider: createStubOcrProvider([okResult(text)]),
    fetchEntries: [{ body: { bytes: PNG_BYTES } }],
    categorizer: createStubCategorizer([entry]),
  });
  onTestFinished(() => env.adapter.stop());
  const msg = buildMessage({
    attachments: [attachment('https://cdn.test/list.png', 'image/png')],
  });
  emitMessage(env.client, msg.raw);
  await vi.waitFor(() => expect(msg.send).toHaveBeenCalled());
  return sentPayloads(msg.send);
}

describe('integration: sorted list reply', () => {
  it('a list photo → every line, verbatim, grouped under headings in shop-walk order', async () => {
    const payloads = await sendSortedPhoto('milk\napples\nbread\nchicken\ntomatoes', [
      'dairy-eggs',
      'produce',
      'bakery',
      'meat-fish',
      'produce',
    ]);
    expect(payloads).toEqual([
      {
        content:
          '**Fruit & vegetables**\napples\ntomatoes\n\n**Bread & bakery**\nbread\n\n**Meat & fish**\nchicken\n\n**Dairy & eggs**\nmilk',
        allowedMentions: EMPTY_MENTIONS,
      },
    ]);
  });

  it('a sorted reply over the message limit splits at line boundaries without losing a line', async () => {
    const lines = Array.from({ length: 150 }, (_, i) => `item number ${i} @everyone`);
    const categories = lines.map((_, i): CategoryId => (i % 2 === 0 ? 'pantry' : 'other'));
    const payloads = await sendSortedPhoto(lines.join('\n'), categories);

    expect(payloads.length).toBeGreaterThan(1);
    for (const payload of payloads) {
      expect(payload.content.length).toBeLessThanOrEqual(2000);
      expect(payload.allowedMentions).toEqual(EMPTY_MENTIONS);
    }
    const rendered = payloads.map((p) => p.content).join('');
    const renderedLines = rendered.split('\n');
    for (const line of lines) {
      expect(renderedLines.filter((l) => l === line)).toHaveLength(1);
    }
  });
});

describe('integration: AI-step failures', () => {
  it.each(['timeout', 'invalid-answer', 'error'] as const)(
    'categorizer failed:%s → the note, then the list exactly as recognized; never the generic error',
    async (cause) => {
      const payloads = await sendPhoto('milk\n\napples', failedAnswer(cause));
      expect(payloads).toEqual([
        {
          content: `${LIST_MESSAGES.sortingFailedNote}\nmilk\n\napples`,
          allowedMentions: EMPTY_MENTIONS,
        },
      ]);
    },
  );

  describe('a hung AI call', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('is abandoned at the budget, and the busy guard is released for the next list', async () => {
      const env = buildHandler({
        script: [okResult('milk'), okResult('bread')],
        fetch: [okFetch(), okFetch()],
        categorizer: createStubCategorizer(['never-settles', okAnswer(['bakery'])]),
      });
      const first = env.handler(submission());
      await vi.advanceTimersByTimeAsync(SORTING_BUDGET_MS);
      expect((await first).text).toBe(`${LIST_MESSAGES.sortingFailedNote}\nmilk`);
      expect((await env.handler(submission())).text).toBe('**Bread & bakery**\nbread');
    });
  });
});

describe('integration: the submission outcome line', () => {
  /**
   * The `list submission succeeded` lines of one handler run.
   * @param ocrText what the stub OCR recognizes
   * @param categorizer the stub categorizer's script, or null for sorting off
   */
  async function outcomeLines(ocrText: string, categorizer: StubCategorizerEntry[] | null) {
    const env = buildHandler({
      script: [okResult(ocrText)],
      fetch: [okFetch()],
      categorizer: categorizer === null ? null : createStubCategorizer(categorizer),
    });
    await env.handler(submission());
    return env.cap.lines.filter((l) => l.msg === 'list submission succeeded');
  }

  it.each([
    ['sorted', [okAnswer(['dairy-eggs'])]],
    ['fallback', [failedAnswer('error')]],
    ['off', null],
  ] as const)('records sorting: %s, exactly once', async (sorting, script) => {
    const lines = await outcomeLines('milk', script === null ? null : [...script]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ sorting, imageCount: 1 });
  });

  it('a photo with no readable text logs exactly one outcome line, without a sorting field', async () => {
    const lines = await outcomeLines('  \n ', [okAnswer([])]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ outcome: 'no-readable-text' });
    expect(lines[0]).not.toHaveProperty('sorting');
  });
});

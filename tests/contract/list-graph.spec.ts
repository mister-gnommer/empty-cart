// Contract tests for the list graph: stub recognition and a stub categorizer,
// so every route is exercised without OCR, Discord or a model.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CategoryId, DEFAULT_SHOP_ORDER } from '../../src/list-sorting/category-catalog';
import { buildListGraph, SORTING_BUDGET_MS } from '../../src/shopping-list/list-graph';
import { LIST_MESSAGES } from '../../src/shopping-list/messages';
import type { RecognitionOutcome } from '../../src/shopping-list/recognize-list';
import { type LoggedLine, makeCapturingLogger } from '../helpers/logger';
import {
  createStubCategorizer,
  failedAnswer,
  okAnswer,
  type StubCategorizerEntry,
} from '../helpers/stub-categorizer';

const PAGES = ['milk\napples\n\nbread', 'chicken\ntomatoes'];
const ITEMS = ['milk', 'apples', 'bread', 'chicken', 'tomatoes'];
const CATEGORIES: CategoryId[] = ['dairy-eggs', 'produce', 'bakery', 'meat-fish', 'produce'];
const SORTED_REPLY =
  '**Fruit & vegetables**\napples\ntomatoes\n\n**Bread & bakery**\nbread\n\n**Meat & fish**\nchicken\n\n**Dairy & eggs**\nmilk';
const VERBATIM = PAGES.join('\n');

/**
 * Runs the graph once over a stubbed recognition outcome.
 * @param opts outcome recognition returns; categorizer script, or null for sorting off
 */
async function run(opts: {
  outcome?: RecognitionOutcome;
  script?: StubCategorizerEntry[] | null;
  shopOrder?: readonly CategoryId[];
}) {
  const { invocation, categorizer, cap } = start(opts);
  const state = await invocation;
  return { reply: state.reply, categorizer, lines: cap.lines };
}

/**
 * Starts one graph run without awaiting it, so fake timers can be advanced meanwhile.
 * @param opts as for run()
 */
function start(opts: {
  outcome?: RecognitionOutcome;
  script?: StubCategorizerEntry[] | null;
  shopOrder?: readonly CategoryId[];
}) {
  const cap = makeCapturingLogger();
  const categorizer =
    opts.script === null ? null : createStubCategorizer(opts.script ?? [okAnswer(CATEGORIES)]);
  const graph = buildListGraph({
    recognize: async () => opts.outcome ?? { status: 'recognized', readablePages: PAGES },
    categorizer,
    now: () => 1_000,
  });
  const invocation = graph.invoke(
    { shopOrder: [...(opts.shopOrder ?? DEFAULT_SHOP_ORDER)] },
    // Safe: the capturing logger satisfies pino's Logger call surface
    // structurally; `as never` only bridges the nominal pino import.
    { context: { log: cap.logger as never, attachments: [] } },
  );
  return { invocation, categorizer, cap };
}

/**
 * The step/outcome pairs of every `list step` line, in order.
 * @param lines captured log lines
 */
function steps(lines: LoggedLine[]): string[] {
  return lines.filter((l) => l.msg === 'list step').map((l) => `${l.step}:${l.outcome}`);
}

describe('list graph', () => {
  it('a recognition that ended → that reply, and the categorizer is never called', async () => {
    const { reply, categorizer, lines } = await run({
      outcome: { status: 'ended', reply: { text: LIST_MESSAGES.noReadableText } },
    });
    expect(reply).toBe(LIST_MESSAGES.noReadableText);
    expect(categorizer?.calls).toEqual([]);
    expect(steps(lines)).toEqual(['recognize:ended']);
  });

  it('sorting off → exactly the verbatim pages, with no note', async () => {
    const { reply, lines } = await run({ script: null });
    expect(reply).toBe(VERBATIM);
    expect(steps(lines)).toEqual(['recognize:ok', 'unsorted:off']);
  });

  it('a valid answer → the grouped reply; items from all pages are sorted together', async () => {
    const { reply, categorizer, lines } = await run({});
    expect(reply).toBe(SORTED_REPLY);
    expect(categorizer?.calls.map((c) => c.items)).toEqual([ITEMS]);
    expect(steps(lines)).toEqual(['recognize:ok', 'categorize:ok', 'sort:ok']);
  });

  it('a failed categorizer → the note plus the verbatim pages, never a partial sort', async () => {
    const { reply, lines } = await run({ script: [failedAnswer('error')] });
    expect(reply).toBe(`${LIST_MESSAGES.sortingFailedNote}\n${VERBATIM}`);
    expect(steps(lines)).toEqual(['recognize:ok', 'categorize:failed:error', 'unsorted:fallback']);
  });

  it('an answer that fails the check → invalid-answer fallback', async () => {
    const { reply, lines } = await run({ script: [okAnswer(CATEGORIES.slice(1))] });
    expect(reply).toBe(`${LIST_MESSAGES.sortingFailedNote}\n${VERBATIM}`);
    expect(steps(lines)).toContain('categorize:failed:invalid-answer');
  });

  it('sorts by the shop order passed in, not the default one', async () => {
    const reversed = [...DEFAULT_SHOP_ORDER].reverse();
    const { reply } = await run({ shopOrder: reversed });
    expect(reply?.startsWith('**Dairy & eggs**\nmilk\n\n**Meat & fish**')).toBe(true);
  });

  it('logs one content-free list step line per visited node, with a duration', async () => {
    const { lines } = await run({});
    const stepLines = lines.filter((l) => l.msg === 'list step');
    expect(stepLines).toHaveLength(3);
    for (const line of stepLines) {
      expect(line.durationMs).toBe(0);
    }
    const logged = JSON.stringify(lines);
    for (const item of ITEMS) {
      expect(logged).not.toContain(item);
    }
  });
});

describe('list graph: AI-step failures always fall back to the noted verbatim list', () => {
  const FALLBACK = `${LIST_MESSAGES.sortingFailedNote}\n${VERBATIM}`;

  it.each(['timeout', 'invalid-answer', 'error'] as const)(
    'categorizer failed:%s → note + verbatim, cause and categorizer id logged',
    async (cause) => {
      const { reply, lines } = await run({ script: [failedAnswer(cause)] });
      expect(reply).toBe(FALLBACK);
      expect(lines.find((l) => l.step === 'categorize')).toMatchObject({
        outcome: `failed:${cause}`,
        cause,
        categorizerId: 'stub-categorizer',
      });
    },
  );

  it('a model error logs its class name, so a bad key and a rate limit can be told apart', async () => {
    const { lines } = await run({ script: [failedAnswer('error')] });
    expect(lines.find((l) => l.step === 'categorize')).toMatchObject({ errorName: 'StubError' });
  });

  it('an answer assigning one line twice → invalid-answer fallback', async () => {
    const twice = okAnswer(CATEGORIES);
    if (twice.status === 'ok') {
      twice.assignments[1] = { line: 1, category: 'produce' };
    }
    const { reply, lines } = await run({ script: [twice] });
    expect(reply).toBe(FALLBACK);
    expect(steps(lines)).toContain('categorize:failed:invalid-answer');
  });

  /**
   * A recognition outcome with `count` one-line items.
   * @param count number of items
   */
  function itemsOf(count: number): RecognitionOutcome {
    const lines = Array.from({ length: count }, (_, i) => `item ${i}`);
    return { status: 'recognized', readablePages: [lines.join('\n')] };
  }

  it('more than 200 items → skipped-too-long without calling the model', async () => {
    const { reply, categorizer, lines } = await run({ outcome: itemsOf(201), script: [] });
    expect(reply?.startsWith(LIST_MESSAGES.sortingFailedNote)).toBe(true);
    expect(categorizer?.calls).toEqual([]);
    expect(steps(lines)).toContain('categorize:failed:skipped-too-long');
  });

  it('exactly 200 items → the model is asked', async () => {
    const { categorizer } = await run({
      outcome: itemsOf(200),
      script: [okAnswer(Array.from({ length: 200 }, (): CategoryId => 'other'))],
    });
    expect(categorizer?.calls).toHaveLength(1);
  });

  describe('the AI budget', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it.each([
      ['never settles', 'never-settles' as const],
      [
        'ignores the abort and answers after 20 s',
        { ignoresAbort: true as const, afterMs: 20_000, result: okAnswer(CATEGORIES) },
      ],
    ])(
      'a categorizer that %s is abandoned at the budget → timeout fallback',
      async (_case, entry) => {
        const { invocation, categorizer, cap } = start({ script: [entry] });
        await vi.advanceTimersByTimeAsync(SORTING_BUDGET_MS);
        const state = await invocation;
        expect(state.reply).toBe(FALLBACK);
        expect(steps(cap.lines)).toContain('categorize:failed:timeout');
        expect(categorizer?.calls[0].signalAborted()).toBe(true);
      },
    );
  });
});

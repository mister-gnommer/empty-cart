// The list flow as a LangGraph graph: recognize → categorize → sort, with an
// `unsorted` exit for "sorting off" and every AI-step failure. Nodes only
// compose other modules; the graph knows nothing about Discord, OCR vendors or
// the model library.
import { END, type GraphNode, START, StateGraph, StateSchema } from '@langchain/langgraph';
import { z } from 'zod';
import {
  type ItemCategorizer,
  MAX_CATEGORIZED_ITEMS,
  type SortingFailureCause,
} from '../categorizer/types';
import { CATEGORY_IDS } from '../list-sorting/category-catalog';
import { checkAssignments } from '../list-sorting/check-assignments';
import { renderSortedList } from '../list-sorting/render-sorted-list';
import { sortByShopOrder, splitItems } from '../list-sorting/sort-list';
import type { Logger } from '../logger/create-logger';
import type { SubmissionAttachment } from './handle-list-submission';
import { LIST_MESSAGES } from './messages';
import type { RecognitionOutcome } from './recognize-list';
import { BUDGET_EXPIRED, unlessExpired } from './unless-expired';

/** Time budget for the AI step, separate from the recognition budget. */
export const SORTING_BUDGET_MS = 15_000;

const CategoryIdSchema = z.enum(CATEGORY_IDS);

// learn: StateSchema declares the graph's shared state; every node reads the whole state and returns only the fields it changes
const ListState = new StateSchema({
  // learn: shopOrder is graph input, not a constant inside a node, so a later "choose store" node can fill it instead
  shopOrder: z.array(CategoryIdSchema),
  // learn: .default() gives a field its value before any node writes it; a node's write replaces it (no reducer)
  readablePages: z.array(z.string()).default([]),
  items: z.array(z.string()).default([]),
  categories: z.array(CategoryIdSchema).nullable().default(null),
  sortingFailure: z
    .enum(['timeout', 'invalid-answer', 'error', 'skipped-too-long'])
    .nullable()
    .default(null),
  reply: z.string().nullable().default(null),
});

// learn: the context schema types per-run dependencies passed at invoke time; they are not state, so they are never traced or persisted as data
const ListContext = z.object({
  log: z.custom<Logger>(),
  // Context, not state: an attachment URL opens the photo until it expires, and traces record state.
  attachments: z.custom<readonly SubmissionAttachment[]>(),
});
type ListContextType = z.infer<typeof ListContext>;

type ListNode = GraphNode<typeof ListState, ListContextType>;

export type ListGraphDeps = {
  recognize: (
    attachments: readonly SubmissionAttachment[],
    log: Logger,
  ) => Promise<RecognitionOutcome>;
  /** null = sorting off: the reply stays the verbatim recognized text. */
  categorizer: ItemCategorizer | null;
  now: () => number;
};

/**
 * Returns the runtime context, which every invoke must pass.
 * @param context the runtime context handed to a node
 */
function contextOf(context: ListContextType | undefined): ListContextType {
  if (context === undefined) {
    throw new Error('list graph invoked without its { log, attachments } context');
  }
  return context;
}

/**
 * Builds and compiles the list graph once; invoke it once per submission.
 * @param deps recognition, the categorizer (null = sorting off) and the clock
 */
export function buildListGraph(deps: ListGraphDeps) {
  const { categorizer, now } = deps;

  /**
   * Logs the one content-free line each node writes.
   * @param log the run's logger
   * @param step node name
   * @param outcome what the node decided
   * @param startedAt clock reading when the node started
   * @param extra additional content-free fields
   */
  function logStep(
    log: Logger,
    step: string,
    outcome: string,
    startedAt: number,
    extra: Record<string, unknown> = {},
  ): void {
    log.info({ msg: 'list step', step, outcome, durationMs: now() - startedAt, ...extra });
  }

  /**
   * Logs an AI-step failure and records its cause, which routes the run to `unsorted`.
   * @param log the run's logger
   * @param cause why sorting was not possible
   * @param startedAt clock reading when the categorize node started
   * @param errorName the error's class name, for `error` failures
   */
  function failedWith(
    log: Logger,
    cause: SortingFailureCause,
    startedAt: number,
    errorName?: string,
  ) {
    logStep(log, 'categorize', `failed:${cause}`, startedAt, {
      cause,
      categorizerId: categorizer?.id,
      errorName,
    });
    return { sortingFailure: cause };
  }

  // learn: a node is a plain async function (state, config) → partial state update; config.context carries the invoke-time context
  const recognize: ListNode = async (_state, config) => {
    const { log, attachments } = contextOf(config.context);
    const startedAt = now();
    const outcome = await deps.recognize(attachments, log);
    if (outcome.status === 'ended') {
      logStep(log, 'recognize', 'ended', startedAt);
      return { reply: outcome.reply.text };
    }
    logStep(log, 'recognize', 'ok', startedAt);
    return {
      readablePages: outcome.readablePages,
      items: splitItems(outcome.readablePages),
    };
  };

  const categorize: ListNode = async (state, config) => {
    const { log } = contextOf(config.context);
    const startedAt = now();
    if (categorizer === null) {
      // Unreachable: the router only sends runs here when sorting is on.
      throw new Error('categorize node reached with sorting off');
    }
    if (state.items.length > MAX_CATEGORIZED_ITEMS) {
      return failedWith(log, 'skipped-too-long', startedAt);
    }
    // Built like the recognition budget (not AbortSignal.timeout) so test fake
    // timers control it.
    const budget = new AbortController();
    const budgetTimer = setTimeout(() => budget.abort(), SORTING_BUDGET_MS);
    try {
      // A categorizer that ignores the abort is abandoned, not awaited, so the
      // AI step can never hold the submission past its budget.
      const result = await unlessExpired(
        categorizer.categorize({ items: state.items, signal: budget.signal }),
        budget.signal,
      );
      if (result === BUDGET_EXPIRED) {
        return failedWith(log, 'timeout', startedAt);
      }
      if (result.status === 'failed') {
        return failedWith(log, result.cause, startedAt, result.errorName);
      }
      // The trust boundary: the model's answer is used only if it covers every line exactly once.
      const categories = checkAssignments(result.assignments, state.items.length);
      if (categories === null) {
        return failedWith(log, 'invalid-answer', startedAt);
      }
      logStep(log, 'categorize', 'ok', startedAt);
      return { categories };
    } finally {
      clearTimeout(budgetTimer);
    }
  };

  const sort: ListNode = (state, config) => {
    const { log } = contextOf(config.context);
    const startedAt = now();
    if (state.categories === null) {
      // Unreachable: the router only sends runs here with checked categories.
      throw new Error('sort node reached without categories');
    }
    const reply = renderSortedList(sortByShopOrder(state.items, state.categories, state.shopOrder));
    logStep(log, 'sort', 'ok', startedAt);
    return { reply };
  };

  const unsorted: ListNode = (state, config) => {
    const { log } = contextOf(config.context);
    const startedAt = now();
    const verbatim = state.readablePages.join('\n');
    if (state.sortingFailure === null) {
      logStep(log, 'unsorted', 'off', startedAt);
      return { reply: verbatim };
    }
    logStep(log, 'unsorted', 'fallback', startedAt);
    return { reply: `${LIST_MESSAGES.sortingFailedNote}\n${verbatim}` };
  };

  // learn: the second StateGraph argument is the context schema, which types config.context in every node
  return (
    new StateGraph(ListState, ListContext)
      // learn: addNode registers a step under a name; the name is what traces and edges refer to
      .addNode('recognize', recognize)
      .addNode('categorize', categorize)
      .addNode('sort', sort)
      .addNode('unsorted', unsorted)
      // learn: START is the virtual entry point; this edge makes recognize the first step
      .addEdge(START, 'recognize')
      // learn: a conditional edge runs a router on the state and follows the node name it returns; the list names every possible target
      .addConditionalEdges(
        'recognize',
        (state) => {
          if (state.reply !== null) {
            return END;
          }
          return categorizer === null ? 'unsorted' : 'categorize';
        },
        ['categorize', 'unsorted', END],
      )
      .addConditionalEdges(
        'categorize',
        (state) => (state.categories === null ? 'unsorted' : 'sort'),
        ['sort', 'unsorted'],
      )
      // learn: END is the virtual exit; reaching it ends invoke() and returns the final state
      .addEdge('sort', END)
      .addEdge('unsorted', END)
      // learn: compile() freezes the wiring into a runnable; no checkpointer, so the state is gone once invoke returns
      .compile()
  );
}

export type ListGraph = ReturnType<typeof buildListGraph>;

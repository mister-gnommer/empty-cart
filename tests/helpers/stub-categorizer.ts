// Stub categorizer for tests: per-call scripted results with call recording.
// Implements the local categorizer interface without any AI library, so the
// list graph and the Discord flow can run with zero model calls.
import type {
  CategorizeResult,
  ItemCategorizer,
  SortingFailureCause,
} from '../../src/categorizer/types';
import type { CategoryId } from '../../src/list-sorting/category-catalog';

export type StubCategorizerCall = {
  items: readonly string[];
  /** Whether the budget signal had fired by the time the call settled or was abandoned. */
  readonly signalAborted: () => boolean;
};

/**
 * A scripted per-call behaviour: a fixed result, `never-settles` (holds the
 * call open forever), or `ignores-abort` (resolves with `result` after
 * `afterMs`, regardless of the signal).
 */
export type StubCategorizerEntry =
  | CategorizeResult
  | 'never-settles'
  | { ignoresAbort: true; afterMs: number; result: CategorizeResult };

export type StubCategorizer = ItemCategorizer & { readonly calls: StubCategorizerCall[] };

/**
 * A valid answer assigning `categories[i]` to line `i + 1`.
 * @param categories one category per item, in item order
 */
export function okAnswer(categories: readonly CategoryId[]): CategorizeResult {
  return {
    status: 'ok',
    assignments: categories.map((category, index) => ({ line: index + 1, category })),
  };
}

/** A categorizer-side failure with this cause; only `error` carries a class name, as in the agent. */
export function failedAnswer(
  cause: Exclude<SortingFailureCause, 'skipped-too-long'>,
): CategorizeResult {
  return cause === 'error'
    ? { status: 'failed', cause, errorName: 'StubError' }
    : { status: 'failed', cause };
}

/**
 * Creates a stub categorizer that answers call N with script entry N. Running
 * past the end of the script rejects loudly so mis-scripted tests fail.
 * @param script per-call behaviours
 * @param id loggable categorizer id
 */
export function createStubCategorizer(
  script: readonly StubCategorizerEntry[],
  id = 'stub-categorizer',
): StubCategorizer {
  const calls: StubCategorizerCall[] = [];
  let nextEntry = 0;
  return {
    id,
    calls,
    categorize({ items, signal }) {
      calls.push({ items: [...items], signalAborted: () => signal.aborted });
      const entry = script[nextEntry];
      nextEntry += 1;
      if (entry === undefined) {
        return Promise.reject(
          new Error(`stub categorizer: script exhausted after ${calls.length} call(s)`),
        );
      }
      if (entry === 'never-settles') {
        return new Promise<never>(() => undefined);
      }
      if ('ignoresAbort' in entry) {
        return new Promise((resolve) => {
          setTimeout(() => resolve(entry.result), entry.afterMs);
        });
      }
      return Promise.resolve(entry);
    },
  };
}

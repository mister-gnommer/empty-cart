// The local interface the list flow talks to. No vendor imports: the agent
// implementation, a stub in tests, or a future provider all fit behind it.
import type { UncheckedAssignment } from '../list-sorting/check-assignments';

/** Longest list sent to a categorizer; longer lists skip the AI step. */
export const MAX_CATEGORIZED_ITEMS = 200;

export type SortingFailureCause = 'timeout' | 'invalid-answer' | 'error' | 'skipped-too-long';

/**
 * Raw categorizer answer. `assignments` is NOT trusted: the caller always runs
 * it through `checkAssignments`, so no categorizer can bypass that check.
 */
export type CategorizeResult =
  | { status: 'ok'; assignments: UncheckedAssignment[] }
  | {
      status: 'failed';
      cause: Exclude<SortingFailureCause, 'skipped-too-long'>;
      /** Error class name only; never the message, which may echo list text. */
      errorName?: string;
    };

export type CategorizeRequest = { items: readonly string[]; signal: AbortSignal };

export interface ItemCategorizer {
  /** Loggable identifier, e.g. the configured `provider:model` string. */
  readonly id: string;
  /** Assigns a category to each line. Never throws; failures come back as `failed`. */
  categorize(req: CategorizeRequest): Promise<CategorizeResult>;
}

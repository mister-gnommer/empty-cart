// List-submission orchestrator — guards each submission, then runs the list
// graph (recognize → categorize → sort). No vendor imports, no transport
// knowledge, no persistence; logs content-free transitions only.

import {
  ACCEPTED_CONTENT_TYPES,
  type fetchAndValidateImage,
  MAX_IMAGE_BYTES,
} from '../image/fetch-image';
import type { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { ItemCategorizer } from '../categorizer/types';
import { DEFAULT_SHOP_ORDER } from '../list-sorting/category-catalog';
import { childFor, type Logger } from '../logger/create-logger';
import type { OcrProvider } from '../ocr/types';
import { buildListGraph, type ListGraph } from './list-graph';
import { LIST_MESSAGES } from './messages';
import { recognizeList, replyFor } from './recognize-list';

export { SUBMISSION_BUDGET_MS } from './recognize-list';

export type SubmissionAttachment = {
  url: string;
  reportedSize: number | null;
  reportedContentType: string | null;
};

export type ListSubmissionInput = {
  correlationId: string;
  userId: string;
  channelId: string;
  /** Message order = processing order. */
  attachments: SubmissionAttachment[];
};

export type ListReply = { text: string };

export type ListSubmissionHandler = (input: ListSubmissionInput) => Promise<ListReply>;

type ListSubmissionDeps = {
  provider: OcrProvider;
  fetchImage: typeof fetchAndValidateImage;
  languageHints: readonly string[];
  /** null = sorting off: the reply is the verbatim recognized text. */
  categorizer: ItemCategorizer | null;
  /** Tracing callbacks for every run; empty = untraced. */
  callbacks: BaseCallbackHandler[];
  logger: Logger;
  /** Test seam; production = Date.now. */
  now?: () => number;
};

type ResolvedDeps = ListSubmissionDeps & { now: () => number; graph: ListGraph };

/**
 * Metadata-only pre-check over ALL attachments, in message order — no
 * download, no provider call.
 * @param attachments the submission's attachments in message order
 * @returns the first rejection, or null when every attachment passes
 */
function findMetadataRejection(
  attachments: readonly SubmissionAttachment[],
): { reason: 'too-large' | 'unsupported'; position: number } | null {
  for (let position = 0; position < attachments.length; position += 1) {
    const { reportedSize, reportedContentType } = attachments[position];
    if (reportedSize !== null && reportedSize > MAX_IMAGE_BYTES) {
      return { reason: 'too-large', position };
    }
    if (reportedContentType !== null && !ACCEPTED_CONTENT_TYPES.has(reportedContentType)) {
      return { reason: 'unsupported', position };
    }
  }
  return null;
}

/**
 * Builds the per-user list-submission handler. The returned handler holds
 * the busy guard; all per-submission work lives in the functions below.
 * @param deps OCR provider, image fetcher, language hints, categorizer, logger and clock
 * @returns the handler to call once per user message carrying list photos
 */
export function createListSubmissionHandler(deps: ListSubmissionDeps): ListSubmissionHandler {
  const now = deps.now ?? Date.now;
  const graph = buildListGraph({
    recognize: (attachments, log) => recognizeList({ ...deps, now }, log, attachments),
    categorizer: deps.categorizer,
    now,
  });
  const resolvedDeps: ResolvedDeps = { ...deps, now, graph };
  // Busy guard: userId → correlationId of the submission in flight. The ONLY
  // shared mutable state; entries are always released in `finally`.
  const inFlight = new Map<string, string>();
  return (input) => handleSubmission(resolvedDeps, inFlight, input);
}

/**
 * Runs one submission end to end: metadata checks, busy guard, recognition.
 * Any throw becomes the generic reply, and the guard entry is always released.
 * @param deps the handler's dependencies with the clock resolved
 * @param inFlight the busy guard shared by all submissions of this handler
 * @param input the user's message: ids and attachments
 * @returns the reply to send back to the user
 */
async function handleSubmission(
  deps: ResolvedDeps,
  inFlight: Map<string, string>,
  input: ListSubmissionInput,
): Promise<ListReply> {
  const log = childFor(deps.logger, input.correlationId);
  log.info({
    msg: 'list submission received',
    userId: input.userId,
    channelId: input.channelId,
    attachmentCount: input.attachments.length,
    reportedSizes: input.attachments.map((a) => a.reportedSize),
  });

  // 1. Local metadata checks precede the busy guard, so a persistently-bad
  //    sender always gets the actionable message — even while busy.
  const rejection = findMetadataRejection(input.attachments);
  if (rejection !== null) {
    log.warn({
      msg: 'list submission failed',
      reason: rejection.reason,
      position: rejection.position,
      stage: 'metadata',
    });
    return replyFor(rejection.reason);
  }

  // 2. Busy guard — reject, never queue. No `await` may sit between the check
  //    and the set, or two submissions could both pass the check.
  const busyWith = inFlight.get(input.userId);
  if (busyWith !== undefined) {
    log.info({
      msg: 'list submission rejected busy',
      userId: input.userId,
      inFlightCorrelationId: busyWith,
    });
    return { text: LIST_MESSAGES.busy };
  }
  inFlight.set(input.userId, input.correlationId);
  try {
    return await processList(deps, log, input);
  } catch (err) {
    // Unstructured outcomes never leak: any throw becomes the generic reply.
    log.error({
      msg: 'list submission failed',
      reason: 'exception',
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return { text: LIST_MESSAGES.serviceUnavailable };
  } finally {
    inFlight.delete(input.userId);
  }
}

/**
 * Runs the list graph and returns its reply. Runs that ended during
 * recognition were already logged there; the rest are logged here, once.
 * @param deps the handler's dependencies with the clock and graph resolved
 * @param log logger bound to the submission's correlation id
 * @param input the submission, whose attachments passed the metadata checks
 */
async function processList(
  deps: ResolvedDeps,
  log: Logger,
  input: ListSubmissionInput,
): Promise<ListReply> {
  const { attachments } = input;
  const startedAt = deps.now();
  const state = await deps.graph.invoke(
    { shopOrder: [...DEFAULT_SHOP_ORDER] },
    {
      context: { log, attachments },
      callbacks: deps.callbacks,
      runName: 'list-submission',
      metadata: { correlationId: input.correlationId },
    },
  );
  if (state.reply === null) {
    // Unreachable: every path to END sets the reply. Caught by the catch-all.
    throw new Error('list graph finished without a reply');
  }
  if (state.readablePages.length > 0) {
    log.info({
      msg: 'list submission succeeded',
      imageCount: attachments.length,
      elapsedMs: deps.now() - startedAt,
      sorting: sortingOutcome(state),
    });
  }
  return { text: state.reply };
}

/**
 * Summarizes what the AI step did for the outcome log line.
 * @param state the final graph state of a run that got past recognition
 */
function sortingOutcome(state: {
  categories: readonly unknown[] | null;
  sortingFailure: string | null;
}): 'sorted' | 'fallback' | 'off' {
  if (state.categories !== null) {
    return 'sorted';
  }
  return state.sortingFailure === null ? 'off' : 'fallback';
}

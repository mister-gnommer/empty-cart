// List-submission orchestrator — pure composition of the image and OCR
// contracts. No vendor imports, no transport knowledge, no persistence:
// this module only sequences downloads and recognitions, assembles the
// reply, and logs content-free transitions.

import {
  ACCEPTED_CONTENT_TYPES,
  type fetchAndValidateImage,
  MAX_IMAGE_BYTES,
} from '../image/fetch-image';
import { childFor, type Logger } from '../logger/create-logger';
import type { OcrProvider } from '../ocr/types';
import { LIST_MESSAGES } from './messages';

/** Hard ceiling for one submission across ALL its images — a module constant, NOT config. */
export const SUBMISSION_BUDGET_MS = 25_000;

/** Operator-facing failure classes; the user only ever sees the mapped LIST_MESSAGES text. */
type FailureReason = 'too-large' | 'unsupported' | 'unretrievable' | 'provider-unavailable';

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
  logger: Logger;
  /** Test seam; production = Date.now. */
  now?: () => number;
};

type ResolvedDeps = ListSubmissionDeps & { now: () => number };

/** Per-submission state shared by the processing phases once the busy guard is held. */
type SubmissionRun = {
  deps: ResolvedDeps;
  log: Logger;
  startedAt: number;
  deadline: number;
  budgetExpiry: AbortSignal;
};

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

function replyFor(reason: FailureReason): ListReply {
  switch (reason) {
    case 'too-large':
      return { text: LIST_MESSAGES.imageTooLarge };
    case 'unsupported':
      return { text: LIST_MESSAGES.unsupportedFormat };
    case 'unretrievable':
    case 'provider-unavailable':
      return { text: LIST_MESSAGES.serviceUnavailable };
  }
}

const BUDGET_EXPIRED = Symbol('budget-expired');

/**
 * Settles with the work's outcome, or with BUDGET_EXPIRED as soon as the
 * budget signal fires. A callee that ignores the signal is abandoned rather
 * than awaited, so it can never wedge the submission or its busy-guard entry.
 * @param work the download or recognition to wait for
 * @param budgetExpiry fires when the submission's time budget runs out
 */
function unlessExpired<T>(
  work: Promise<T>,
  budgetExpiry: AbortSignal,
): Promise<T | typeof BUDGET_EXPIRED> {
  if (budgetExpiry.aborted) {
    // The abandoned work may still reject later; observe it so that can never
    // surface as an unhandled rejection.
    work.catch(() => undefined);
    return Promise.resolve(BUDGET_EXPIRED);
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => resolve(BUDGET_EXPIRED);
    budgetExpiry.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        budgetExpiry.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        budgetExpiry.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

const FETCH_FAILURE_REASON = {
  'too-large': 'too-large',
  'unsupported-format': 'unsupported',
  unretrievable: 'unretrievable',
} as const satisfies Record<string, FailureReason>;

/**
 * Logs a submission that ran out of budget and returns the generic reply.
 * @param run the submission in progress
 * @param position index of the image being processed when the budget ran out
 * @param extra additional log fields
 */
function cancelled(
  run: SubmissionRun,
  position: number,
  extra: Record<string, unknown> = {},
): ListReply {
  run.log.warn({
    msg: 'list submission cancelled',
    elapsedMs: run.deps.now() - run.startedAt,
    position,
    ...extra,
  });
  return { text: LIST_MESSAGES.serviceUnavailable };
}

/**
 * Logs a classified failure and returns the user-facing reply for it.
 * @param run the submission in progress
 * @param reason the failure class, mapped to the user-facing message
 * @param extra additional log fields
 */
function failed(
  run: SubmissionRun,
  reason: FailureReason,
  extra: Record<string, unknown>,
): ListReply {
  run.log.warn({ msg: 'list submission failed', reason, ...extra });
  return replyFor(reason);
}

/**
 * Builds the per-user list-submission handler. The returned handler holds
 * the busy guard; all per-submission work lives in the functions below.
 * @param deps OCR provider, image fetcher, language hints, logger and clock
 * @returns the handler to call once per user message carrying list photos
 */
export function createListSubmissionHandler(deps: ListSubmissionDeps): ListSubmissionHandler {
  const resolvedDeps: ResolvedDeps = { ...deps, now: deps.now ?? Date.now };
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
    return await recognizeAll(deps, log, input.attachments);
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
 * Downloads and recognizes every attachment in message order under one shared
 * time budget, stopping at the first failure or when the budget runs out.
 * @param deps the handler's dependencies with the clock resolved
 * @param log logger bound to the submission's correlation id
 * @param attachments the attachments that passed the metadata checks
 * @returns the assembled list text, or the reply for whatever stopped the run
 */
async function recognizeAll(
  deps: ResolvedDeps,
  log: Logger,
  attachments: readonly SubmissionAttachment[],
): Promise<ListReply> {
  // 3. One shared budget for every image of the submission, anchored at
  //    guard acquisition. Abandonment is client-side only — there is no
  //    remote cancellation.
  const startedAt = deps.now();
  // The `now()` deadline sizes each provider timeout; this timer is the hard
  // stop that aborts the download and abandons any callee still outstanding.
  const budgetExpiry = new AbortController();
  const budgetTimer = setTimeout(() => budgetExpiry.abort(), SUBMISSION_BUDGET_MS);
  const run: SubmissionRun = {
    deps,
    log,
    startedAt,
    deadline: startedAt + SUBMISSION_BUDGET_MS,
    budgetExpiry: budgetExpiry.signal,
  };

  // Only per-image page texts are accumulated — bytes and recognition
  // metadata stay scoped to recognizeOne and are dropped when it returns
  // (no retention after the reply is computed).
  const pageTexts: string[] = [];
  try {
    for (let position = 0; position < attachments.length; position += 1) {
      const outcome = await recognizeOne(run, attachments[position], position);
      if (typeof outcome !== 'string') {
        return outcome;
      }
      pageTexts.push(outcome);
    }
    return assembleReply(run, pageTexts);
  } finally {
    clearTimeout(budgetTimer);
  }
}

/**
 * Downloads one attachment and runs OCR on it within the remaining budget.
 * @param run the submission in progress
 * @param attachment the image to download and recognize
 * @param position the attachment's index in the message, used in logs
 * @returns the recognized page text, or the reply that ends the submission
 */
async function recognizeOne(
  run: SubmissionRun,
  attachment: SubmissionAttachment,
  position: number,
): Promise<string | ListReply> {
  const { deps, log, deadline, budgetExpiry } = run;
  if (deadline - deps.now() <= 0) {
    return cancelled(run, position);
  }
  const fetched = await unlessExpired(
    deps.fetchImage({
      url: attachment.url,
      reportedSize: attachment.reportedSize,
      reportedContentType: attachment.reportedContentType,
      signal: budgetExpiry,
    }),
    budgetExpiry,
  );
  if (fetched === BUDGET_EXPIRED) {
    return cancelled(run, position);
  }
  if (fetched.status !== 'ok') {
    return failed(run, FETCH_FAILURE_REASON[fetched.status], { position, stage: 'download' });
  }
  log.info({
    msg: 'image submitted',
    position,
    sizeBytes: fetched.sizeBytes,
    format: fetched.format,
  });

  const timeoutMs = deadline - deps.now();
  if (timeoutMs <= 0) {
    return cancelled(run, position);
  }
  const result = await unlessExpired(
    deps.provider.recognize({
      image: { bytes: fetched.bytes, format: fetched.format },
      languageHints: deps.languageHints,
      timeoutMs,
    }),
    budgetExpiry,
  );
  if (result === BUDGET_EXPIRED) {
    return cancelled(run, position, { providerId: deps.provider.id });
  }
  if (result.status !== 'ok') {
    // Nested, not spread: vendor keys must never shadow our own log fields.
    const providerFields = {
      providerId: deps.provider.id,
      ...(result.logContext === undefined ? {} : { providerLogContext: result.logContext }),
    };
    if (result.status === 'undecodable-image') {
      return failed(run, 'unsupported', { position, ...providerFields });
    }
    if (result.cause === 'deadline-exceeded') {
      return cancelled(run, position, providerFields);
    }
    return failed(run, 'provider-unavailable', {
      position,
      cause: result.cause,
      ...providerFields,
    });
  }
  log.info({ msg: 'image recognized', position, textLength: result.text.length });
  return result.text;
}

/**
 * Joins the recognized pages into the reply and logs the successful outcome.
 * @param run the submission in progress
 * @param pageTexts per-image texts in attachment order
 */
function assembleReply(run: SubmissionRun, pageTexts: readonly string[]): ListReply {
  // Blank pages are dropped; the rest go out verbatim, in order, one newline apart.
  // Recognized text is untrusted: a future AI step must treat it as data, never instructions.
  const readablePages = pageTexts.filter((page) => page.trim().length > 0);
  const elapsedMs = run.deps.now() - run.startedAt;
  if (readablePages.length === 0) {
    run.log.info({
      msg: 'list submission succeeded',
      imageCount: pageTexts.length,
      elapsedMs,
      outcome: 'no-readable-text',
    });
    return { text: LIST_MESSAGES.noReadableText };
  }
  run.log.info({
    msg: 'list submission succeeded',
    imageCount: pageTexts.length,
    elapsedMs,
  });
  return { text: readablePages.join('\n') };
}

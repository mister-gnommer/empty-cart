// Recognition phase of a list submission: downloads and OCRs every attachment
// under one shared time budget. No vendor imports, no transport knowledge;
// logs content-free transitions only.

import type { fetchAndValidateImage } from '../image/fetch-image';
import type { Logger } from '../logger/create-logger';
import type { OcrProvider } from '../ocr/types';
import type { ListReply, SubmissionAttachment } from './handle-list-submission';
import { LIST_MESSAGES } from './messages';
import { BUDGET_EXPIRED, unlessExpired } from './unless-expired';

/** Hard ceiling for one submission's recognition across ALL its images — a module constant, NOT config. */
export const SUBMISSION_BUDGET_MS = 25_000;

/** Operator-facing failure classes; the user only ever sees the mapped LIST_MESSAGES text. */
export type FailureReason = 'too-large' | 'unsupported' | 'unretrievable' | 'provider-unavailable';

export type RecognitionDeps = {
  provider: OcrProvider;
  fetchImage: typeof fetchAndValidateImage;
  languageHints: readonly string[];
  now: () => number;
};

/**
 * How recognition ended: either with a reply that ends the submission (every
 * input problem, OCR failure or no readable text, already logged), or with the
 * readable page texts, verbatim and in attachment order.
 */
export type RecognitionOutcome =
  | { status: 'ended'; reply: ListReply }
  | { status: 'recognized'; readablePages: string[] };

/** Per-submission state shared by the recognition phases. */
type RecognitionRun = {
  deps: RecognitionDeps;
  log: Logger;
  startedAt: number;
  deadline: number;
  budgetExpiry: AbortSignal;
};

/**
 * Maps a failure class to the user-facing reply.
 * @param reason the operator-facing failure class
 */
export function replyFor(reason: FailureReason): ListReply {
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
  run: RecognitionRun,
  position: number,
  extra: Record<string, unknown> = {},
): RecognitionOutcome {
  run.log.warn({
    msg: 'list submission cancelled',
    elapsedMs: run.deps.now() - run.startedAt,
    position,
    ...extra,
  });
  return { status: 'ended', reply: { text: LIST_MESSAGES.serviceUnavailable } };
}

/**
 * Logs a classified failure and returns the user-facing reply for it.
 * @param run the submission in progress
 * @param reason the failure class, mapped to the user-facing message
 * @param extra additional log fields
 */
function failed(
  run: RecognitionRun,
  reason: FailureReason,
  extra: Record<string, unknown>,
): RecognitionOutcome {
  run.log.warn({ msg: 'list submission failed', reason, ...extra });
  return { status: 'ended', reply: replyFor(reason) };
}

/**
 * Downloads and recognizes every attachment in message order under one shared
 * time budget, stopping at the first failure or when the budget runs out.
 * @param deps OCR provider, image fetcher, language hints and clock
 * @param log logger bound to the submission's correlation id
 * @param attachments the attachments that passed the metadata checks
 * @returns the readable pages, or the reply for whatever stopped the run
 */
export async function recognizeList(
  deps: RecognitionDeps,
  log: Logger,
  attachments: readonly SubmissionAttachment[],
): Promise<RecognitionOutcome> {
  // One shared budget for every image of the submission, anchored at guard
  // acquisition. Abandonment is client-side only — there is no remote
  // cancellation.
  const startedAt = deps.now();
  // The `now()` deadline sizes each provider timeout; this timer is the hard
  // stop that aborts the download and abandons any callee still outstanding.
  const budgetExpiry = new AbortController();
  const budgetTimer = setTimeout(() => budgetExpiry.abort(), SUBMISSION_BUDGET_MS);
  const run: RecognitionRun = {
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
    return readablePagesOf(run, pageTexts);
  } finally {
    clearTimeout(budgetTimer);
  }
}

/**
 * Downloads one attachment and runs OCR on it within the remaining budget.
 * @param run the submission in progress
 * @param attachment the image to download and recognize
 * @param position the attachment's index in the message, used in logs
 * @returns the recognized page text, or the outcome that ends the submission
 */
async function recognizeOne(
  run: RecognitionRun,
  attachment: SubmissionAttachment,
  position: number,
): Promise<string | RecognitionOutcome> {
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
 * Drops blank pages; ends the submission with the no-readable-text reply when
 * nothing is left, logging that outcome here.
 * @param run the submission in progress
 * @param pageTexts per-image texts in attachment order
 */
function readablePagesOf(run: RecognitionRun, pageTexts: readonly string[]): RecognitionOutcome {
  // Recognized text is untrusted. The categorizer prompt marks it as data, and
  // checkAssignments keeps the model from changing anything but the order.
  const readablePages = pageTexts.filter((page) => page.trim().length > 0);
  if (readablePages.length > 0) {
    return { status: 'recognized', readablePages };
  }
  run.log.info({
    msg: 'list submission succeeded',
    imageCount: pageTexts.length,
    elapsedMs: run.deps.now() - run.startedAt,
    outcome: 'no-readable-text',
  });
  return { status: 'ended', reply: { text: LIST_MESSAGES.noReadableText } };
}

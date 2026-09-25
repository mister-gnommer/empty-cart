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

/**
 * Metadata-only pre-check over ALL attachments, in message order — no
 * download, no provider call. Returns the first rejection, or null.
 */
function localRejection(
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

// 🤖 AI-start
const BUDGET_EXPIRED = Symbol('budget-expired');

/**
 * Settles with the work's outcome, or with BUDGET_EXPIRED as soon as the
 * budget signal fires. A callee that ignores the signal is abandoned rather
 * than awaited, so it can never wedge the submission or its busy-guard entry.
 */
function unlessExpired<T>(
  work: Promise<T>,
  budget: AbortSignal,
): Promise<T | typeof BUDGET_EXPIRED> {
  if (budget.aborted) {
    // The abandoned work may still reject later; observe it so that can never
    // surface as an unhandled rejection.
    work.catch(() => undefined);
    return Promise.resolve(BUDGET_EXPIRED);
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => resolve(BUDGET_EXPIRED);
    budget.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        budget.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        budget.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}
// 🤖 AI-end

const FETCH_FAILURE_REASON = {
  'too-large': 'too-large',
  'unsupported-format': 'unsupported',
  unretrievable: 'unretrievable',
} as const satisfies Record<string, FailureReason>;

export function createListSubmissionHandler(deps: {
  provider: OcrProvider;
  fetchImage: typeof fetchAndValidateImage;
  languageHints: readonly string[];
  logger: Logger;
  /** Test seam; production = Date.now. */
  now?: () => number;
}): ListSubmissionHandler {
  const now = deps.now ?? Date.now;
  // Busy guard: userId → correlationId of the submission in flight. The ONLY
  // shared mutable state; entries are always released in `finally`.
  const inFlight = new Map<string, string>();

  return async (input): Promise<ListReply> => {
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
    const rejection = localRejection(input.attachments);
    if (rejection !== null) {
      log.warn({
        msg: 'list submission failed',
        reason: rejection.reason,
        position: rejection.position,
        stage: 'metadata',
      });
      return replyFor(rejection.reason);
    }

    // 2. Busy guard — reject, never queue.
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

    // 3. One shared budget for every image of the submission, anchored at
    //    guard acquisition. Abandonment is client-side only — there is no
    //    remote cancellation.
    const startedAt = now();
    const deadline = startedAt + SUBMISSION_BUDGET_MS;
    // 🤖 AI-start
    // The `now()` deadline sizes each provider timeout; this timer is the hard
    // stop that aborts the download and abandons any callee still outstanding.
    const budget = new AbortController();
    const budgetTimer = setTimeout(() => budget.abort(), SUBMISSION_BUDGET_MS);
    // 🤖 AI-end
    const cancelled = (position: number, providerId?: string): ListReply => {
      log.warn({
        msg: 'list submission cancelled',
        elapsedMs: now() - startedAt,
        position,
        ...(providerId === undefined ? {} : { providerId }),
      });
      return { text: LIST_MESSAGES.serviceUnavailable };
    };
    const failed = (reason: FailureReason, extra: Record<string, unknown>): ListReply => {
      log.warn({ msg: 'list submission failed', reason, ...extra });
      return replyFor(reason);
    };

    // Only per-image page texts are accumulated — bytes and recognition
    // metadata stay scoped to their loop iteration and are dropped when it
    // ends (no retention after the reply is computed).
    const pageTexts: string[] = [];
    try {
      for (let position = 0; position < input.attachments.length; position += 1) {
        if (deadline - now() <= 0) {
          return cancelled(position);
        }
        const attachment = input.attachments[position];
        // 🤖 AI-start
        const fetched = await unlessExpired(
          deps.fetchImage({
            url: attachment.url,
            reportedSize: attachment.reportedSize,
            reportedContentType: attachment.reportedContentType,
            signal: budget.signal,
          }),
          budget.signal,
        );
        if (fetched === BUDGET_EXPIRED) {
          return cancelled(position);
        }
        // 🤖 AI-end
        if (fetched.status !== 'ok') {
          return failed(FETCH_FAILURE_REASON[fetched.status], { position, stage: 'download' });
        }
        log.info({
          msg: 'image submitted',
          position,
          sizeBytes: fetched.sizeBytes,
          format: fetched.format,
        });

        const timeoutMs = deadline - now();
        if (timeoutMs <= 0) {
          return cancelled(position);
        }
        // 🤖 AI-start
        const result = await unlessExpired(
          deps.provider.recognize({
            image: { bytes: fetched.bytes, format: fetched.format },
            languageHints: deps.languageHints,
            timeoutMs,
          }),
          budget.signal,
        );
        if (result === BUDGET_EXPIRED) {
          return cancelled(position, deps.provider.id);
        }
        // 🤖 AI-end
        if (result.status === 'undecodable-image') {
          return failed('unsupported', { position, providerId: deps.provider.id });
        }
        if (result.status === 'unavailable') {
          if (result.cause === 'deadline-exceeded') {
            return cancelled(position, deps.provider.id);
          }
          return failed('provider-unavailable', {
            position,
            cause: result.cause,
            providerId: deps.provider.id,
          });
        }
        // 🤖 AI-start
        const recognizedLog = {
          msg: 'image recognized',
          position,
          lineCount: result.recognition.lines.length,
          fidelityCheck: result.fidelityCheck,
        };
        if (result.fidelityCheck === 'mismatch') {
          log.warn(recognizedLog);
        } else {
          log.info(recognizedLog);
        }
        // 🤖 AI-end
        pageTexts.push(result.recognition.text);
      }

      // Reply assembly: the provider's page texts verbatim, in attachment
      // order, joined by a single newline — no trimming, reordering, merging,
      // or normalization. When AI interpretation is added here, the AI call
      // MUST include a system prompt that prevents prompt-injection attacks:
      // recognized text is untrusted user input.
      // 🤖 AI-start
      // A blank page is skipped entirely (it would otherwise leave a stray
      // empty line between pages); only an all-blank submission is "no text".
      const readablePages = pageTexts.filter((page) => page.trim().length > 0);
      const combined = readablePages.join('\n');
      if (readablePages.length === 0) {
        // 🤖 AI-end
        log.info({
          msg: 'list submission succeeded',
          imageCount: pageTexts.length,
          elapsedMs: now() - startedAt,
          outcome: 'no-readable-text',
        });
        return { text: LIST_MESSAGES.noReadableText };
      }
      log.info({
        msg: 'list submission succeeded',
        imageCount: pageTexts.length,
        elapsedMs: now() - startedAt,
      });
      return { text: combined };
    } catch (err) {
      // Unstructured outcomes never leak: any throw becomes the generic reply.
      log.error({
        msg: 'list submission failed',
        reason: 'exception',
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      return { text: LIST_MESSAGES.serviceUnavailable };
    } finally {
      clearTimeout(budgetTimer);
      inFlight.delete(input.userId);
    }
  };
}

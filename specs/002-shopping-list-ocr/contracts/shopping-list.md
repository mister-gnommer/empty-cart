# Contract — `shopping-list`

**Module path**: `src/shopping-list/`
**Depends on**: `src/ocr/` (contract), `src/image/` (fetch), `src/shared/types` —
NO vendor imports, NO discord knowledge (pure orchestration, Constitution II)
**Depended on by**: `discord` adapter (calls the handler), `lifecycle` (constructs it)
**Spec refs**: FR-001..FR-005, FR-010..FR-014, FR-016..FR-018, FR-020..FR-025,
User Stories 1–2, Edge Cases (multi-image, busy, concurrent users, budget, disabled)

## Public surface

```typescript
export const SUBMISSION_BUDGET_MS = 25_000; // hardcoded (FR-020)

export type SubmissionAttachment = {
  url: string;
  reportedSize: number | null;
  reportedContentType: string | null;
};

export type ListSubmissionInput = {
  correlationId: string;
  userId: string;
  channelId: string;
  attachments: SubmissionAttachment[]; // message order = processing order
};

export type ListReply = { text: string };

export type ListSubmissionHandler = (
  input: ListSubmissionInput,
) => Promise<ListReply>;

export function createListSubmissionHandler(deps: {
  provider: OcrProvider;
  fetchImage: typeof fetchAndValidateImage;
  languageHints: readonly string[];
  logger: Logger; // from src/logger — never pino directly
  now?: () => number; // test seam; production = Date.now
}): ListSubmissionHandler;

// User-facing strings (CANONICAL — tests assert byte-equality):
export const LIST_MESSAGES: {
  readonly serviceUnavailable: 'Service is not available, please try again later or contact the admin.';
  readonly noReadableText: "I couldn't read any text — can you try a different photo?";
  readonly unsupportedFormat: 'Sorry, that file format is not supported — please send a JPEG, PNG, or WEBP photo.';
  readonly imageTooLarge: 'That image is too large — please send a photo under 7 MB.';
  readonly busy: 'I am still working on your previous list — please wait for it to finish before sending another.';
};
export function usageHintMessage(commandPrefix: string): string;
// → `Send a photo of your shopping list and I will reply with the recognized text. Type ${commandPrefix}help for information on how to use the bot.`
```

The handler is async (I/O-bound orchestration) but holds **no cross-call state except the
busy-guard map** described below. Logging happens through a pino child logger bound to
`input.correlationId` (injected via deps at construction — the module never imports pino
directly; the logger type comes from `src/logger`).

## Behavioral contract

1. **Fixed evaluation order** (US2 scenario 6, Edge Cases):
   1. *Local metadata checks, all attachments in order*: `reportedSize` over the 7 MB
      ceiling → reply `imageTooLarge` and stop; `reportedContentType` present and outside
      the accepted set → reply `unsupportedFormat` and stop. (No download, no provider
      call, no guard acquisition — a persistently-bad sender always gets the actionable
      message, even while busy.)
   2. *Busy guard*: if `input.userId` already has an in-flight submission → reply `busy`
      and stop. Otherwise record `Map[userId] = correlationId`.
   3. *Sequential processing under one shared budget*: `deadline = now() +
      SUBMISSION_BUDGET_MS` at guard acquisition, together with a hard budget timer
      (an `AbortController` aborted after `SUBMISSION_BUDGET_MS`, cleared in `finally`).
      The timer's signal is passed to `fetchImage`, and both the download and the
      provider call are raced against it: when it fires, the outstanding callee is
      abandoned (not awaited), the `cancelled` transition is logged, and the reply is
      `serviceUnavailable` — so a callee that never settles can't hold the busy
      guard. For each attachment in order:
      `fetchImage` → map `too-large`/`unsupported-format`/`unretrievable` to their
      replies and abort the whole submission (all-or-nothing, FR-004); then
      `provider.recognize` with `timeoutMs = deadline - now()` (≤ 0 → treat as
      deadline-exceeded). Any non-`ok` provider result aborts the whole submission:
      `undecodable-image` → `unsupportedFormat`; any `unavailable` → `serviceUnavailable`
      with the cause + provider id logged.
   4. *Success assembly*: the reply text is the per-image `recognition.text` values in
      attachment order, **skipping blank (empty or whitespace-only) pages**, joined with a
      single `'\n'` between images. Nothing else is trimmed, reordered, merged, or
      normalized (FR-003/FR-004/FR-009/FR-013).
   5. *Empty check*: if every page was blank → reply `noReadableText` (FR-013). A blank
      page among recognized pages never triggers it.
   6. `finally`: the busy-guard entry is ALWAYS released, including on throw.
2. **Unstructured outcomes never leak.** The only user-facing strings are the
   `LIST_MESSAGES` constants and `usageHintMessage`; exceptions thrown by `fetchImage` or
   `provider` are caught, logged with the correlation id, and answered with
   `serviceUnavailable` (FR-014 — one generic message for every service-side cause,
   never technical detail).
3. **Concurrency.** Different users are processed fully concurrently and independently
   (FR-016); the busy map is keyed per user and is the ONLY shared mutable state.
4. **Logging (FR-017, SC-005).** One structured line per transition:
   `received` (userId, channelId, attachmentCount, reportedSizes), `submitted` (per
   image: position, sizeBytes, format), `image recognized` (per image: position,
   lineCount, the provider's content-free `fidelityCheck`; `warn` level on `mismatch`),
   `succeeded` (imageCount, elapsedMs),
   `failed` (reason class: too-large / unsupported / unretrievable / provider-cause),
   `cancelled` (elapsedMs), `rejected-busy`. Logs NEVER contain image bytes, recognized
   text, attachment urls beyond host, or credential material.
5. **No retention.** After the reply is computed, the handler drops every reference to
   bytes and recognition output (FR-018).
6. **Injection marker comment.** The code that assembles the reply text from recognition
   output MUST carry a comment: *when AI interpretation is added, the AI call MUST include
   a system prompt that prevents prompt-injection attacks* (FR-012's deferred-work hook).

## Test obligations (TDD — written first, red, then green)

All tests use the stub `OcrProvider` and a scripted `fetchImage` — zero network, zero
vendor SDKs.

- Happy path: single image → `recognize` called once with the fetched bytes/format, the
  configured language hints, and a positive `timeoutMs`; reply text equals the stub's
  page text byte-for-byte.
- Multi-image: three images → provider called sequentially in attachment order (assert
  call order); reply = the three page texts joined by `'\n'` in order; a blank page
  between recognized pages is skipped (no stray empty line); a failure on image
  2 aborts: image 3 is never downloaded nor recognized and exactly one failure message is
  produced (all-or-nothing).
- Local checks before guard: oversize `reportedSize` on attachment 2 of 2 → `imageTooLarge`
  and provider never called AND busy map untouched; bad contentType → `unsupportedFormat`.
- Post-download failures: `too-large`/`unsupported-format`/`unretrievable` from
  `fetchImage` → matching replies; `unretrievable` maps to `serviceUnavailable`.
- Provider arms: `undecodable-image` → `unsupportedFormat`; each `UnavailableCause` →
  `serviceUnavailable`; `ok` with whitespace-only text → `noReadableText`.
- Busy guard: two overlapping submissions for the same user → first completes
  uninterrupted, second gets `busy` and its provider/fetch are never called; a third
  submission after the first finished is accepted (guard released); same-user busy
  submission with an oversized attachment gets `imageTooLarge`, NOT `busy` (order 1 < 2).
- Concurrent users: two users' overlapping submissions both complete with their own texts
  (no cross-talk; asserted via per-user stub scripting).
- Budget: `now()` seam advanced so the deadline passes mid-submission → provider receives
  `timeoutMs <= 0` path → `serviceUnavailable`, guard released, handler resolves (no
  stuck promise); elapsed-log assertion for `cancelled`. A download or provider call that
  never settles → `serviceUnavailable` once the budget timer fires (fake timers), the
  download's abort signal fires, guard released; no budget timer outlives a submission.
- Disabled provider: every image submission that passes the input checks →
  `serviceUnavailable` (FR-025), still replied (never silent); an input problem (oversize,
  unsupported metadata, bytes failing the format sniff) keeps its distinct message.
- Fidelity self-check: `image recognized` carries `fidelityCheck` and is `warn` on
  `mismatch`, never carrying the text.
- Logging: spy logger receives the transition events with correlation id and NO text/byte
  fields (scan log values for fixture text — SC-005 pattern, mirrored from 001's
  redaction test).

## Supersession notes

- **2026-09-25** (post-implementation analysis): (a) the budget is now enforced by a hard
  abort timer, not only by the `now()` checks between steps. The download previously had
  no bound, and a stalled one held the busy guard forever. (b) Blank pages are skipped
  in multi-image assembly, as spec FR-013 requires; this contract previously joined them
  in. (c) The disabled provider answers only submissions that pass the input checks, per
  the spec FR-025 amendment. (d) Added the per-image `image recognized` log line.
- **2026-09-25** (PR review): when the budget is already spent as a callee starts, the
  abandoned promise still gets a rejection handler, so a late failure can never surface
  as an unhandled rejection.


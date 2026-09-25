# Contract — `discord` (002 extensions)

**Module path**: `src/discord/`
**Depends on**: `shopping-list` (handler + messages), `echo`, `config`, `logger`,
`shared/types`; remains the ONLY module permitted to import `discord.js`
**Depended on by**: `lifecycle`
**Spec refs**: FR-001, FR-009, FR-010, FR-011, FR-012, FR-019, FR-022, User Story 1
scenarios 1–3, Edge Cases (mention tokens, text-only message, long text, concurrent users)
**Base**: extends the 001 `discord` adapter contract (connection lifecycle, bounded
`sendWithRetry`, empty `allowedMentions`, clean shutdown) — those clauses are unchanged
and not restated here.

## Public surface (additions)

```typescript
// adapter deps gain:
createDiscordAdapter(deps: {
  /* ...existing 001 deps... */
  listSubmission: ListSubmissionHandler;
  usageHint: string; // pre-interpolated by lifecycle from config.commandPrefix
}): DiscordAdapter;

// Pure splitter, exported for unit tests:
export function splitReply(text: string, limit?: number /* default 2000 */): string[];
```

## Behavioral contract

0. **Ignored input.** Bot-authored messages and Discord system messages (`message.system`: joins, pins, boosts, thread notices) are dropped before any routing — no command, no hint, no OCR.
   A thread counts as allowlisted when its own id or its parent channel's id is in `ocrChannelAllowlist`. A regular channel's `parentId` (its category) never counts.
1. **Routing order** inside `onMessageCreate` (after the existing bot-author and
   `stopping` guards):
   1. Recognized command (`content` starts with `commandPrefix` and the command name
      matches `echoCommandName`) → the existing echo flow, unchanged. Commands are NOT
      subject to the channel allowlist and NEVER trigger the usage hint, even when the
      message also carries attachments (FR-019, FR-022, Edge Case "Text-only message").
   2. Channel allowlist: when `config.ocrChannelAllowlist` is non-null and
      `message.channelId` is not in it → ignore the message entirely (no hint, no OCR).
      When the allowlist is null, every channel the bot can see is processed (FR-019).
   3. Message with ≥ 1 attachment (any kind) → list submission: mint a correlation id,
      call `listSubmission` with `{ correlationId, userId, channelId, attachments }`
      mapped from the message's attachments in message order (`url`,
      `size → reportedSize`, `contentType → reportedContentType`), then send the
      resulting reply. Non-image attachments (PDF, video, …) are NOT filtered here —
      they flow into the submission and are rejected by the image/format gates with the
      unsupported-format message (Edge Case "Non-image attachment").
   4. Any other message → reply with the usage hint (FR-022).
2. **Reply sending.** Every reply goes through the 001 `sendWithRetry` with
   `allowedMentions: { parse: [], users: [], roles: [] }` — mention neutralization is
   enforced at the transport, never by altering text bytes (FR-012, FR-009). Replies are
   sent to the originating channel ("same conversation", FR-011); the adapter never
   DMs, never cross-posts, and concurrent submissions in different channels are fully
   independent (Edge Case "Concurrent users"). After the last chunk the adapter logs
   `list reply sent` (chunkCount, deliveredChunks, replyLength, no text) under the
   submission's correlation id — `warn` when a chunk was not delivered — closing the
   request-in → response-out audit trail (Constitution III). If the list handler throws,
   the reply is `LIST_MESSAGES.serviceUnavailable`: a throw is a service-side failure,
   and FR-014 requires one generic message for all of them.
   Chunks that are whitespace-only are dropped before sending: Discord rejects them, and
   they carry no list content.
   The usage-hint reply is logged as `usage hint sent` (userId, channelId, delivered; never
   the message content) under its own correlation id. `reply failed after retries` is
   always logged through the request's correlation-bound logger (Constitution III).
3. **Splitting (`splitReply`, FR-010).** `text.length ≤ limit` → `[text]`. Otherwise
   fill each chunk up to `limit` chars, preferring the LAST `'\n'` inside the window
   (split after it; a newline at window position 0 does not count as a line boundary);
   when the window contains no usable line boundary, split mid-line at `limit - 1`
   (`limit - 2` when that would separate a surrogate pair; `limit` must be ≥ 4), end
   the chunk with `…` and start the next chunk with `…` (explicit continuation marker;
   transport-added content exempt from byte fidelity, FR-009/FR-010). Chunks are sent
   sequentially with `await`, in order (research R10: discord.js's REST queue honors
   rate-limit headers; realistic list splits of 2–5 chunks are far under any bucket).
   The fixed `LIST_MESSAGES` strings are all far under 2000 chars and never split.
4. **Nothing else changes.** Connection lifecycle, reconnect correlation logging,
   the echo path's handler-throw canonical error reply, bounded retry, and shutdown semantics are exactly
   the 001 contract. The OCR path adds no new `discord.js` surface area beyond reading
   `message.attachments`.

## Test obligations (TDD — written first, red, then green)

- `splitReply` unit table:
  - short text → single chunk, byte-identical;
  - text with line boundaries → every chunk ≤ limit, no line split across chunks, and
    concatenation of chunks equals the original (line-boundary splits add nothing);
  - one 5000-char single line → chunks ≤ limit, every cut chunk except the last ends with
    `…`, every continuation chunk except the first starts with `…`, and stripping the
    markers reconstructs the original byte-for-byte;
  - window whose only newline is at position 0 → treated as mid-line (marker path);
  - a mid-line cut never separates a surrogate pair; `limit < 4` → `RangeError`.
- Routing contract tests (stubbed `Client` via the existing `clientFactory` seam,
  scripted `listSubmission`):
  - echo command in a non-allowlisted channel → echo reply, `listSubmission` never
    called, no usage hint;
  - image message in a non-allowlisted channel → nothing sent, `listSubmission` never
    called; allowlist null → processed;
  - message with a PDF attachment → `listSubmission` IS called with the attachment
    descriptor (filtering is not the adapter's job);
  - attachment descriptors preserve message order and map url/size/contentType;
  - text-only message in a processed channel → usage-hint reply, `listSubmission` never
    called;
  - handler result longer than 2000 chars → multiple sends in order, each ≤ 2000, each
    with empty `allowedMentions` (asserted on the stubbed send);
  - list handler throws → `LIST_MESSAGES.serviceUnavailable` (never the exception text);
  - `list reply sent` logged with chunk counts and correlation id; `warn` when a chunk
    was not delivered;
  - every send in every scenario carries empty `allowedMentions` (FR-012).

## Supersession notes

- **2026-09-25** (post-implementation analysis): (a) a thrown list handler now gets the
  generic service message instead of feature 001's internal-error reply, because spec
  FR-014 takes precedence over this contract's earlier clause. (b) Added the
  `list reply sent` delivery log. (c) `splitReply` no longer cuts inside a surrogate
  pair, and its minimum limit is now 4.
- **2026-09-25** (convergence): the usage-hint reply is now logged under its own
  correlation id, and send failures are logged through the request's correlation-bound
  logger instead of the root logger.
- **2026-09-25** (PR review): system messages are ignored; threads inherit their parent
  channel's allowlisting; whitespace-only chunks are never sent.


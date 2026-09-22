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
   independent (Edge Case "Concurrent users").
3. **Splitting (`splitReply`, FR-010).** `text.length ≤ limit` → `[text]`. Otherwise
   fill each chunk up to `limit` chars, preferring the LAST `'\n'` inside the window
   (split after it; a newline at window position 0 does not count as a line boundary);
   when the window contains no usable line boundary, split mid-line at `limit - 1`, end
   the chunk with `…` and start the next chunk with `…` (explicit continuation marker;
   transport-added content exempt from byte fidelity, FR-009/FR-010). Chunks are sent
   sequentially with `await`, in order (research R10: discord.js's REST queue honors
   rate-limit headers; realistic list splits of 2–5 chunks are far under any bucket).
   The fixed `LIST_MESSAGES` strings are all far under 2000 chars and never split.
4. **Nothing else changes.** Connection lifecycle, reconnect correlation logging,
   handler-throw canonical error reply, bounded retry, and shutdown semantics are exactly
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
  - window whose only newline is at position 0 → treated as mid-line (marker path).
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
  - handler throws → the 001 canonical internal-error reply (existing behavior, now
    covering the new path);
  - every send in every scenario carries empty `allowedMentions` (FR-012).

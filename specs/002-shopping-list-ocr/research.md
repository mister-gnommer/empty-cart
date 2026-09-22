# Phase 0 Research: Shopping List Photo OCR

**Feature**: `002-shopping-list-ocr` | **Date**: 2026-09-22

Every `NEEDS CLARIFICATION` candidate from the technical context is resolved below.
Format per item: **Decision** / **Rationale** / **Alternatives considered**. Sources are
listed inline. Findings were gathered against the live npm registry, the Vision API
reference, the google-gax documentation, and the discord.js v14 / Discord API docs on
2026-09-22.

---

## R1 — OCR provider client library

**Decision**: `@google-cloud/vision@6.1.0` (exact pin, per AGENTS.md), specifically
`ImageAnnotatorClient.documentTextDetection()` (feature `DOCUMENT_TEXT_DETECTION` of the
synchronous `images:annotate` API).

**Rationale**: The spec fixes Google Cloud Vision document text detection as the initial
provider (handwriting-optimized; the dedicated handwriting guide uses this feature).
`@google-cloud/vision@6.1.0` is the current `latest` dist-tag on the npm registry;
`engines: { node: ">=22" }` covers the project's Node 24 runtime. It depends on
`google-gax ^6.0.0`. The sync annotate API accepts inline image bytes — no Cloud Storage
staging needed. Per the Vision docs, DOCUMENT_TEXT_DETECTION is "optimized for dense areas
of text … and images that contain handwriting"; TEXT_DETECTION targets sparse text and
requires an opt-in flag for confidence scores, so it is the wrong default. Billing is
per-image at the document-text rate (first 1,000/month free, then $1.50 per 1,000).

**Alternatives considered**:
- *Raw REST `images:annotate` via fetch* — rejected: the operator would hand-roll OAuth2
  service-account JWT exchange and retries; the official client ships both, typed.
- *Tesseract.js (local OCR)* — rejected by the spec itself (external OCR; handwriting
  quality on Tesseract is poor and it violates the "no heavy processing on the VPS"
  spirit).
- *Transkribus* — evaluated first by the operator; its API proved unavailable (recorded in
  spec §Assumptions).

**Sources**: registry.npmjs.org/@google-cloud/vision/latest;
cloud.google.com/vision/docs/handwriting; cloud.google.com/vision/docs/features-list;
cloud.google.com/vision/pricing.

---

## R2 — Authentication & credential configuration

**Decision**: The operator points the bot at a service-account JSON key file via an
environment variable; the google-vision module passes it to the client as
`new ImageAnnotatorClient({ keyFilename })`. Config variable name:
`OCR_GOOGLE_VISION_KEY_FILE` (required iff `OCR_PROVIDER=google-vision`). The key file's
existence/readability is validated once at provider construction (startup), failing fast
with a startup error — never at first request.

**Rationale**: `keyFilename` is the officially documented constructor option for
service-account JSON keys (google-cloud-node authentication guide); the project id is
auto-detected from the key file. Reading config from env is FR-008. Failing at startup
matches the project's existing config philosophy (reject missing/malformed on boot, not
mid-flight). The path — never the file contents — may appear in logs; the client library
never logs key material itself.

**Alternatives considered**:
- *Rely on ambient `GOOGLE_APPLICATION_CREDENTIALS`* — works (ADC default), but an
  explicit, validated config field matches the existing `load-config.ts` discipline and
  produces a clear startup error naming the env field.
- *`credentials: { client_email, private_key }` via env* — rejected: forces a multi-line
  private key through env vars; a key file path is operationally simpler on a systemd VPS.

**Sources**: github.com/googleapis/google-cloud-node/blob/main/docs/authentication.md.

---

## R3 — Reconstructing ordered lines from the Vision response

**Decision**: Lines are reconstructed by walking
`fullTextAnnotation.pages → blocks → paragraphs → words → symbols`, appending each
symbol's text and translating its trailing `property.detectedBreak.type`:
`SPACE`/`SURE_SPACE` → `" "`, `EOL_SURE_SPACE`/`LINE_BREAK` → `"\n"`,
`HYPHEN`/`UNKNOWN`/absent → `""`. The reconstructed string is split on `"\n"` to yield
ordered lines. Contract invariant: `lines.join("\n")` equals the provider's whole-page
text (`fullTextAnnotation.text`) exactly, except a single trailing empty line is dropped
when the final symbol carries a break. `isPrefix: true` breaks (rare) are emitted before
the symbol instead.

**Rationale**: The Vision API exposes no first-class "line" entity; the symbol-level
`detectedBreak` is the documented mechanism the plain `text` field itself is built from,
so this reconstruction is byte-faithful by construction (FR-003, spec §Assumptions "joined
lines must equal whole-page text"). Both `EOL_SURE_SPACE` (wrapped line within a
paragraph) and `LINE_BREAK` (paragraph end) map to `"\n"`, so the mapping is insensitive
to how the provider groups shopping-list items into paragraphs. `HYPHEN` adds no
character — current models emit a literal `"-"` symbol plus `EOL_SURE_SPACE` for soft
hyphens, and synthesizing one would corrupt the text.

**Alternatives considered**:
- *Group words into lines by Y-coordinate clustering* — rejected: heuristic, re-orders the
  provider's reading order, and can diverge from `fullTextAnnotation.text`, breaking the
  fidelity requirement.
- *Post provider `text` directly and skip line metadata* — rejected: FR-005 requires
  ordered lines with confidence and position at the handoff boundary for the future AI
  flow. The orchestrator replies with the provider's whole-page text per image (equal to
  the joined lines by the invariant), so user-facing fidelity and metadata richness are
  both satisfied.

**Sources**: cloud.google.com/vision/docs/reference/rest/v1/AnnotateImageResponse
(TextAnnotation/Page/Block/Paragraph/Word/Symbol, DetectedBreak.BreakType);
cloud.google.com/vision/docs/release-notes (2023-12-05 HYPHEN behavior change).

---

## R4 — Per-line confidence

**Decision**: Line confidence = character-weighted mean of the constituent word
confidences (equivalently, the mean of symbol confidences) in the provider's [0,1] range.
Lines with no confidence-bearing words report `0`.

**Rationale**: Google documents no line-level confidence and no aggregation convention —
this is a project decision. Every level from page to symbol carries `confidence`; words
are the natural unit. Char-weighting prevents a long item line from being dominated by a
short token, and costs nothing because symbols all carry confidence. The value is metadata
for the future AI consumer only (FR-005); v1 user output never shows it.

**Alternatives considered**:
- *Mean of word confidences (unweighted)* — simpler but skewed by short tokens.
- *Min of word confidences* — a conservative rejection signal; nothing in v1 rejects on
  confidence, so the more representative weighted mean is recorded instead.

**Sources**: cloud.google.com/vision/docs/reference/rest/v1/AnnotateImageResponse
(confidence on Page/Block/Paragraph/Word/Symbol); cloud.google.com/vision/docs/handwriting.

---

## R5 — Per-line position metadata

**Decision**: Line position = axis-aligned envelope (min x/y, max x/y) of the constituent
words' `boundingBox.vertices` in the page's pixel coordinate space, stored as
`{ x, y, width, height }` alongside the page's `width`/`height` implicitly supplied by
the provider response. Vertices are absolute pixels for image OCR (`normalizedVertices`
appear only in async PDF/TIFF outputs, which this feature never uses).

**Rationale**: Block/Paragraph/Word/Symbol all expose `boundingBox` (absolute pixels for
`images:annotate`); the union of word boxes is the standard way to bound a reconstructed
line. This is metadata at the FR-005 handoff boundary only — v1 user output never
references it.

**Alternatives considered**:
- *Store the raw 4-corner polygons* — rejected as needless fidelity for a consumer that
  does not exist yet (YAGNI); the envelope is trivially recomputable if a future feature
  needs more.

**Sources**: cloud.google.com/vision/docs/reference/rest/v1/AnnotateImageResponse
(BoundingPoly, vertex order); cloud.google.com/vision/docs/fulltext-annotations.

---

## R6 — Provider error taxonomy mapping

**Decision**: The google-vision module maps every rejection to the provider contract's
outcome union — it never leaks `GoogleError` across the module boundary. Mapping (the
client throws `google-gax` `GoogleError` with a numeric gRPC `code`, a preformatted
`message`, and promoted `ErrorInfo` fields `reason`/`domain`):

| Condition | Detection | Contract outcome |
|---|---|---|
| Corrupt/undecodable image | `code === 3` (`INVALID_ARGUMENT`, message contains "Bad image data") | `undecodable-image` → user-facing *unsupported-format* |
| Other request-shape errors | `code === 3` without the known message | `unavailable` cause `provider-error` (conservative) |
| Client-side deadline (budget) | `code === 4` (`DEADLINE_EXCEEDED`) | `unavailable` cause `deadline-exceeded` |
| API disabled / billing off | `code === 7` (`reason` `SERVICE_DISABLED` / `BILLING_DISABLED`) | `unavailable` cause `unauthorized` |
| Quota / rate exhausted | `code === 8` (`RESOURCE_EXHAUSTED`) | `unavailable` cause `quota-exhausted` |
| Network unreachable (DNS/TCP are wrapped by grpc-js into status 14) | `code === 14` (`UNAVAILABLE`) | `unavailable` cause `unreachable` |
| Bad/expired credentials | `code === 16` (`UNAUTHENTICATED`) | `unavailable` cause `unauthorized` |
| Anything else / unknown | any other rejection | `unavailable` cause `provider-error` |

All `unavailable` causes map to the single generic user message (FR-014); the cause string
and gRPC code are logged with the correlation id.

**Rationale**: The codes above are the documented/observed behaviors of the Vision
backend: `INVALID_ARGUMENT: Bad image data.` for undecodable bytes (confirmed in REST and
client reports), `PERMISSION_DENIED` with `ErrorInfo.reason` distinguishing
`SERVICE_DISABLED`/`BILLING_DISABLED`, `RESOURCE_EXHAUSTED` for quota, grpc-js wrapping
DNS/TCP failures into `UNAVAILABLE`, `UNAUTHENTICATED` for credential problems. One
documented gap: Vision's exact message for oversize payloads is not pinned in the docs —
irrelevant in practice because images are size-gated locally before any provider call
(R8), and any stray `code 3` falls into the conservative `provider-error` bucket.

**Alternatives considered**:
- *String-matching HTTP statuses* — the gRPC path has no HTTP status; numeric codes are
  the stable surface.
- *Letting exceptions propagate to the orchestrator* — rejected (Constitution: external
  dependency hidden behind a local interface; the taxonomy is part of that interface).

**Sources**: googleapis.dev/nodejs/google-gax/latest/classes/GoogleError.html;
cloud.google.com/vision/docs/reference/rest/v1/Code; github.com/grpc/grpc-node/issues/2090;
observed `SERVICE_DISABLED`/`BILLING_DISABLED`/`RESOURCE_EXHAUSTED` reports.

---

## R7 — Bounding the processing budget (timeout & retry control)

**Decision**: The 25-second per-submission budget is enforced by the orchestrator, which
computes a deadline at submission start and passes the remaining milliseconds to each
provider call. The google-vision module forwards it as the per-call google-gax option
`{ timeout: remainingMs, retry: null }`. Automatic retries are disabled outright.

**Rationale**: The shipped client config marks `BatchAnnotateImages` idempotent with
retries on `DEADLINE_EXCEEDED`/`UNAVAILABLE`, backoff up to 60 s, per-RPC timeout 60 s and
a **total timeout of 600 s** — left at defaults, one flaky call could hang ten minutes,
destroying the 25 s budget (FR-020) and the 30 s success criterion. `retry: null` and an
explicit per-call `timeout` are the documented `gax.CallOptions` knobs (the client's
retrying is only useful across much longer horizons than this feature's). A gax timeout
fires as `DEADLINE_EXCEEDED` — R6 maps it to `deadline-exceeded`. There is no remote
cancellation and the spec accepts that provider-side cost is committed; the client-side
deadline is what keeps the bot responsive. (`CallOptions` has no `AbortSignal`; the
returned `CancellablePromise.cancel()` exists but the per-call timeout already covers the
budget, so no additional machinery is introduced.)

**Alternatives considered**:
- *Keep default retries* — rejected: 600 s total timeout violates the budget.
- *Orchestrator races `Promise.race` against its own timer and abandons the promise* —
  rejected as the primary mechanism (leaves an unobserved promise floating; the gax
  timeout already abandons the RPC deterministically). The deadline arithmetic stays in
  the orchestrator regardless, because the budget is shared across multiple images.
- *Client-wide `clientConfig` retry override* — equivalent; per-call options are the
  documented, more local mechanism.

**Sources**: raw.githubusercontent.com/googleapis/google-cloud-node/main/packages/
google-cloud-vision/src/v1/image_annotator_client_config.json;
googleapis.dev/nodejs/google-gax/3.3.0/interfaces/CallOptions.html;
github.com/googleapis/gax-nodejs/blob/main/client-libraries.md.

---

## R8 — Attachment retrieval & size enforcement

**Decision**: The discord adapter hands the orchestrator each attachment's `{ url,
reportedSize, reportedContentType }`; a dedicated image module downloads bytes with global
`fetch(attachment.url)` and enforces the 7 MB ceiling in three layers: (1) reject
pre-download when Discord-reported `size` exceeds the cap, (2) check the response
`Content-Length` and abort early, (3) read the body via `res.body.getReader()`,
accumulate, and cancel the stream the moment the running total exceeds the cap.
Download uses `url`, not `proxyURL` (the media proxy may serve re-encoded variants; the
CDN url serves original bytes, is pre-signed, and needs no auth header). Fetch failure or
non-OK status maps to the contract's `unretrievable` outcome (service-side generic
message).

**Rationale**: Discord's attachment `size` is the server-stored object size and is
reliable for the free pre-download rejection (FR-021's "before submitting for OCR"), but
`Content-Length` can lie or be absent (chunked), so the streaming cap is the authoritative
backstop — defense in depth without buffering oversize files. The 7 MB figure is the
spec's hardcoded threshold; the documented limits back it: 10 MB JSON request cap with
~37% base64 inflation ⇒ ~7.3 MB inline-image ceiling, and Google explicitly warns base64
images can exceed the JSON limit below the 20 MB image cap.

**Alternatives considered**:
- *`await res.arrayBuffer()` then check length* — rejected: buffers the whole file before
  the cap can fire.
- *Pass the CDN URL to Vision (`image.source.imageUri`)* — rejected: hands a third party
  a user-data URL, adds a provider-side fetch failure mode, and forfeits local size/format
  gating (FR-015/FR-021 require rejection before the provider call).
- *trust `reportedSize` only* — rejected: one layer is not defense in depth for a
  hardcoded privacy/cost boundary.

**Sources**: discord.js.org/docs/packages/discord.js/14.27.0/Attachment:Class;
discord.com/developers/docs/resources/message#attachment-object;
cloud.google.com/vision/quotas; cloud.google.com/vision/docs/supported-files.

---

## R9 — Local image format detection

**Decision**: Two-stage format gate in the image module: (1) cheap pre-download filter —
if Discord's `contentType` is present and not `image/jpeg`/`image/png`/`image/webp`,
reject as unsupported without downloading; (2) authoritative magic-byte sniff of the first
12 bytes after download: JPEG `FF D8 FF`, PNG `89 50 4E 47 0D 0A 1A 0A`, WEBP `RIFF` at
offset 0 **and** `WEBP` at offset 8. Anything else (GIF, BMP, TIFF, HEIC `ftyp` brands,
unknown) is rejected as unsupported-format. Truncated/corrupt files that pass the sniff
are the provider's `Bad image data` backstop (R6) and land on the same user message.

**Rationale**: Discord derives `contentType` from the filename extension server-side — it
is nullable and has been observed contradicting the actual bytes (CDN reporting
`image/webp` for PNG bytes), so it can only be a pre-filter; magic bytes are the source of
truth. iPhone HEIC arrives preserved when shared "as file" (`image/heic`,
`application/octet-stream`, or no content type) and is caught by the sniff. Vision's
officially supported sync-input list (JPEG, PNG8/24, GIF first frame, BMP, WEBP, RAW, ICO)
is wider than the accepted set — accepting only JPEG/PNG/WEBP is the spec's product
decision (FR-015), not an API constraint.

**Alternatives considered**:
- *Trust `contentType` alone* — rejected: extension-derived, nullable, sometimes wrong.
- *Sniff only, no pre-filter* — viable; the pre-filter is kept because it rejects
  obviously-wrong files (PDFs, videos) without spending download bandwidth, and the spec
  wants locally-detectable formats refused before any provider call.
- *A sniffing library (`file-type`)* — rejected: three 12-byte checks do not justify a
  dependency (YAGNI).

**Sources**: github.com/discord/discord-api-docs/issues/6785 (contentType derivation);
cloud.google.com/vision/docs/supported-files; production sniffer implementations cited in
research notes.

---

## R10 — Long-reply splitting & continuation marker

**Decision**: The discord adapter owns splitting (transport concern). Algorithm: walk the
reply text; fill each message up to 2000 characters; prefer splitting at the last `"\n"`
inside the window; when no line boundary exists in the window (a single line longer than
2000 chars), split mid-line at `2000 − marker.length` and mark continuity by ending the
chunk with `…` and starting the next chunk with `…`. Chunks are sent sequentially in
order with `await`; no manual throttling (discord.js's REST manager queues per-route and
honors `retry_after`; 2–5 chunk sends are far under any bucket).

**Rationale**: 2000 is the documented bot message content limit. Line-boundary-first
splitting preserves the list's reading continuity (FR-010); the mid-line marker is
explicitly required by FR-010 and is transport-added content exempt from byte fidelity
(FR-009). `…` is a single visible character, costs 1 char of budget per cut, and needs no
localization. Sequential awaited sends preserve order; the observed ~5 msgs/5 s
per-channel bucket is not reachable for realistic list lengths.

**Alternatives considered**:
- *Split at exactly 2000 with no marker* — rejected: violates FR-010's explicit-marker
  requirement and silently truncates continuity.
- *`split: true` option on discord.js send* — rejected: it splits at fixed length without
  line-boundary preference or a continuation marker, and hides the semantics the contract
  must guarantee.
- *Upload as file attachment past N messages* — rejected: changes the user-facing surface;
  spec requires text replies.

**Sources**: discord.com/developers/docs/resources/message (2000-char limit);
docs.discord.com/developers/topics/rate-limits.

---

## R11 — Per-user busy guard & multi-image sequencing

**Decision**: A `createListSubmissionHandler` factory in the shopping-list module holds a
`Map<userId, correlationId>` of in-flight submissions. Handling order per message:
(1) metadata-level local checks for **all** attachments in order (reported size ≤ 7 MB;
contentType pre-filter) — a failure here yields the actionable message even when the user
is busy; (2) busy-guard acquire — if the user already has a submission in flight, reply
with the busy message and stop; (3) per attachment in message order: download+validate,
then OCR, all under the shared 25 s deadline; first failure aborts the submission with the
single matching message (all-or-nothing); (4) success reply; (5) release the guard in a
`finally`. Different users proceed concurrently with independent guards, deadlines, and
correlation ids.

**Rationale**: This is the spec's sequencing (US2 scenario 6: busy checked *after* local
format/size checks so persistently bad input still earns the actionable message;
edge case: sequential processing under one shared budget, all-or-nothing). Pre-checking
all attachments' metadata before any provider call avoids spending OCR money when image 2
of 3 is locally rejectable. A `Map` keyed by user id with `finally`-release is the
smallest correct guard — no locks, no queues (spec forbids queueing: the second
submission is rejected, never queued).

**Alternatives considered**:
- *Guard keyed by channel* — rejected: two users in one channel must not block each other
  (FR-016, edge case "Concurrent users").
- *Queue the second submission* — explicitly rejected by the spec (SC-010: never a queued,
  dropped, or duplicate OCR run).
- *Download everything first, then check busy* — rejected: wastes bandwidth; metadata
  checks are sufficient for the pre-busy actionable messages.

---

## R12 — Module boundaries & import enforcement

**Decision**: New modules mirror the 001 layout, one contract per module: `src/ocr/`
(provider-agnostic contract + types, zero vendor imports), `src/google-vision/` (the only
importer of `@google-cloud/vision`), `src/image/` (download + sniff; plain `fetch`, no new
dependency), `src/shopping-list/` (orchestration core, pure logic). `src/discord/` gains
the image-routing, usage-hint, and reply-splitting behavior; `src/config/` gains the OCR
env fields; `src/lifecycle/` wires the provider selected by config. `biome.json` gains
exactly one new restricted import — `@google-cloud/vision`: "Only src/google-vision may
import @google-cloud/vision." — in the base `paths` plus one override entry per existing
module pattern (per AGENTS.md's documented growth rule).

**Rationale**: Constitution constraint "external dependencies abstracted behind a local
interface" is machine-enforced the same way `discord.js`/`pino`/`zod` already are. The
stub provider used in tests (US3, SC-004) implements the `src/ocr/` contract without any
vendor import, proving swap-by-configuration. Image downloading uses no vendor library
(global fetch), so it needs no new boundary rule.

**Alternatives considered**:
- *Put the provider in `src/ocr/` directly* — rejected: the contract module would import
  the vendor SDK, coupling the boundary to one provider.
- *A generic `src/vendors/` grab-bag* — rejected: one module per capability (Constitution
  II), and the biome rule is per-directory.

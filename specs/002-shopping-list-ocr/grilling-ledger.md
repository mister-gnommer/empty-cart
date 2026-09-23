# Grilling ledger — 002-shopping-list-ocr

Decision record from the planning interview (started 2026-09-21).

Per the constitution, this ledger is a supplementary discovery artifact:
settled decisions MUST be consolidated into `spec.md` before `/speckit-plan`
consumes it. `spec.md` supersedes this file on any contradiction.

- ✅ = final answer explicitly chosen by the user.
- ◐ = final outcome derived from a conditional answer or accepted follow-up.
- ↪ = an earlier answer that was later corrected or superseded.

### Round 1 — triggers, contract, error handling (2026-09-21)

#### Q1 — Scope of this interview

- ◐ **Both spec-level and plan-level, spec amendments first.** Derived from engagement: user directed spec amendments (Q9) and answered plan-level questions; process question not explicitly answered.

#### Q2 — What counts as a trigger image

- ✅ **A — strict allowlist `image/jpeg`, `image/png`, `image/webp`; anything else (GIF, BMP, TIFF, video, non-image files) → unsupported-format reply.**
- B — allowlist plus `image/gif`
- C — any `image/*`; provider decides
- D — C + stickers and image URLs in text/embeds

Pending confirmation against Transkribus's accepted formats (fact-check round 2).

#### Q3 — When does the usage hint fire (FR-022)

- ✅ **A — every image-less message in a processed context gets the usage hint, as spec'd.** Rationale: a later feature adds an AI agent that interprets/answers all messages, so replying to every message is the intended end-state.
- B — only bot-mentioned
- C — guilds: mention-gated; DMs: always
- D — only unrecognized prefix commands

#### Q4 — Context restriction shape (FR-019)

- ✅ **A — channel-ID allowlist env var; unset = process every channel the bot sees (fail-open).**
- B — unset = process nothing (fail-closed)
- C — guild-ID allowlist only
- D — guild + channel allowlists

#### Q5 — DM support in v1

- ✅ **A — guild text channels only; amend spec (remove "or direct message" from US1); defer DM support to a GitHub issue (4th deferred item).**
- B — add DM intents and handle DMs in v1

#### Q6 — Provider contract output shape

- ✅ **C — recognized lines plus confidence scores and coordinates.** (Recommended was B.)
- A — single raw string
- B — ordered lines (`string[]`)
- D — lines + per-image grouping metadata

Follow-ups open: which fields exactly, whether per-image grouping is folded in, and how confidence/coords are treated downstream (they must not reach the reply text).

#### Q7 — Multi-image execution & budget scope

- ✅ **A — sequential OCR calls per message, one shared per-submission budget.**
- B — parallel calls, shared per-submission budget
- C — parallel calls, per-image budget

#### Q8 — Processing budget value (FR-020)

- ✅ **B — 25 s hard per-submission budget, hardcoded (not env-configurable).**
- A — 15 s
- C — 30 s
- D — other

#### Q9 — Single line longer than the platform message limit

- ✅ **B — split mid-line with an explicit continuation marker. SPEC AMENDMENT REQUIRED: SC-002/FR-009 "character-for-character" exemption list must include the marker.**
- A — hard-split mid-line, no marker
- C — truncate line + warn

#### Q10 — Neutralization mechanism (FR-012)

- ✅ **A — rely on transport empty-parse `allowedMentions` only; reply text is never altered.**
- B — additionally escape literal `@everyone`/`@here` bytes in the text
- C — wrap reply in a code block

#### Q11 — Credit-drain / spam guard

- ✅ **C — one in-flight submission per user; additional submissions are rejected with a distinct "busy, try again later" reply.** (Recommended was B — queue.)
- A — none in v1; defer as issue
- B — queue further submissions

SPEC AMENDMENT REQUIRED: error taxonomy was exactly two classes; the busy reply is a third user-facing message. Placement (which class, whether it precedes format/size checks) pending round 2.

#### Q12 — Testing against the real provider

- ✅ **A — stubbed provider in all automated tests; live service exercised only via the manual VPS validation step.**
- B — A plus opt-in live integration test behind env flag
- C — live calls in CI

#### Q13 — Deferred GitHub issues (FR-023)

- ✅ **B — issues created during task implementation as a first task in the plan (reflecting final amended scope).**
- A — create immediately when grilling concludes

### Round 2 — provider facts & refinements (2026-09-21)

Provider facts supplied by user: `transcribus-open-api.json` (Transkribus Processing/Metagrapho API, base `https://transkribus.eu/processing/v1`, spec version 1.13.1). Key facts: async submit + status polling only (no long-poll params; statuses CREATED/WAITING/RUNNING/FINISHED/FAILED); result `content` = full page `text` + regions→lines→words with pixel coords, **no confidence fields**; formats JPEG/TIFF/PNG, ≤20 MB; base64 maxLength 27 962 027 chars; 429 = volume/credits depleted; `textRecognition` requires `htrId` + `languageModel:"built-in"`; `lineDetection.modelId` optional (auto-detected if omitted); auth = OpenID Connect (READCOOP SSO).

#### Q14 — Contract payload (settles 6C)

- ✅ **Define the contract from the Transkribus result shape in `transcribus-open-api.json`** (content text + regions/lines/words + coords).
- A — lines {text, confidence, coords}, discard confidence/coords
- B — A + log avg confidence
- C — pre-joined string + structured lines

Consequence: the confidence half of Q6-C is **impossible with this provider** (no confidence in its response) — exact contract typing pending round 3 (Q22). Q6-C's coordinates portion stands.

#### Q15 — How the image reaches Transkribus

- ✅ **A — bot downloads the attachment, validates bytes locally, submits base64.**
- B — pass CDN URL as `imageUrl`

#### Q16 — Async waiting semantics

- A — submit + poll until terminal or 25 s, abandon locally on budget exit (credits already spent; no server-side cancel exists)
- B — long-poll if the API supports it

- ◐ **Falls back to A:** user chose B under the stated condition "B only if the API supports long polling"; the supplied spec has no long-poll support → A.

#### Q17 — Env config shape

- ✅ **A — `OCR_PROVIDER=transkribus|none` + `TRANSKRIBUS_USERNAME` + `TRANSKRIBUS_PASSWORD` + optional `TRANSKRIBUS_MODEL_ID` (default `38230` = general-handwriting Super Model) + `OCR_ALLOWED_CHANNEL_IDS`; with `none`, OCR path disabled and Transkribus vars not required.** Credential mechanics (OIDC password grant, token cache/refresh) pending round 3 confirmation.
- B — model ID required, no default
- C — research personal-access-token auth first

#### Q18 — Format allowlist (amends Q2)

- ✅ **A — bot accepts JPEG, PNG, TIFF only; WebP/GIF/everything else → local unsupported-format reply, no provider call, no credits spent.** (Q2-A superseded: Q2-A included WebP, which Transkribus rejects.) ↪ Q2-A.
- B — keep WebP, let provider decide

#### Q19 — Size threshold

- ✅ **A — hardcoded 10 MB local cap (provider allows 20 MB; tighter local cap is credit-safe). Confirms spec's assumption unchanged.**
- B — 20 MB

#### Q20 — Busy guard position (settles 11C)

- ✅ **B — the per-user one-in-flight check runs after local MIME/size validation, immediately before OCR submission. SPEC AMENDMENT: the "busy, try again" reply is a third user-facing message class, distinct from generic-service-failure and input-problem messages.**
- A — check before validation

#### Q21 — Usage hint vs `!echo`

- ✅ **A — recognized `!echo` wins (single reply); every other text message in an allowed channel gets the usage hint; commands in non-allowed channels keep 001 behavior (hint is allowlist-scoped).**
- B — hint fires even for valid commands
- C — unknown commands silent

### Round 3 — provider pivot (2026-09-21)

- ✅ **TRANSCRIBUS → GCP CLOUD VISION.** Transkribus's API is not available (no working access); initial provider becomes Google Cloud Vision `DOCUMENT_TEXT_DETECTION` (handwriting mode), assumed provider for the foreseeable future. `transcribus-open-api.json` is to be ignored. SPEC AMENDMENTS: spec input/assumptions/FR-007 name Transkribus → GCP Vision; Transkribus pricing link out.

Affected round-2 entries:

- ↪ Q14 basis (`transcribus-open-api.json`) superseded by pivot; Q6-C's confidence requirement is now **satisfiable** (Vision returns confidence at page/block/paragraph/word/symbol level). Contract re-asked as Q28.
- ↪ Q17 (Transkribus env vars/credentials) superseded; GCP config shape = Q30.
- ↪ Q18 (JPEG/PNG/TIFF-only allowlist) superseded; Vision format set = Q33.
- ↪ Q19 (10 MB hardcoded) re-opened: Vision caps a **JSON request at 10 MB** — a 10 MB base64-inlined image (~13.7 MB) always fails. Threshold re-asked as Q32.
- Q15 (download + submit bytes) survives with the inline caveat from Q32; Q16 (poll/long-poll) is moot — Vision is one synchronous call.
- Round-3 Q22–Q25 (asked, not answered) withdrawn — replaced by round 4. Q26/Q27 carried over (provider-agnostic).

### GCP Vision verified facts (docs, 2026-09-21)

- `POST https://vision.googleapis.com/v1/images:annotate`, `features[0].type = DOCUMENT_TEXT_DETECTION`, image as base64 `content` (or `source.imageUri`), synchronous, single call per request (up to 16 images per request supported).
- Response: `textAnnotations[0]` (whole-page text, locale) + `fullTextAnnotation` (`text` + hierarchy Page→Block→Paragraph→Word→Symbol, each with `confidence` and `boundingBox`; symbol-level `detectedBreak`). Per-image `error` can be returned **inside a 200 response**.
- Formats: JPEG, PNG8/24, GIF (first frame only), BMP, WEBP, RAW, ICO, TIFF (+PDF/DOCX files).
- Limits: image file ≤ 20 MB (hard error); **JSON request ≤ 10 MB** (base64 +~37% ⇒ inline images effectively ≤ ~7 MB); OCR pixel cap 75M px (auto-resized).
- `imageContext.languageHints` optional; handwriting form e.g. `en-t-i0-handwrit`; docs recommend **omitting** for auto-detection ("significant hindrance if the hint is wrong", Latin scripts don't need it).
- Quotas: 1,800 text-detection requests/min — non-issue at this scale. Pricing at the DOCUMENT_TEXT_DETECTION rate.
- Auth: OAuth bearer via Application Default Credentials / service account; Node samples use `@google-cloud/vision` (`ImageAnnotatorClient`).
- Line nuance: v1 `fullTextAnnotation` has **no Line entity** (Blocks→Paragraphs→Words→Symbols); line ends come from symbol `property.detectedBreak` of type `LINE_BREAK`; `textAnnotations[0].description` is the whole-page text with `\n` already applied.

### Round 4 — GCP-grounded decisions (2026-09-21)

Disposition of unanswered round-3 questions: Q22 re-asked as Q28 (answered); Q23 (Transkribus v1-vs-v2 API) moot after pivot; Q24 (Transkribus OIDC auth) replaced by Q30 (GCP service account); Q25 (Transkribus line-detection model) moot — Vision does layout analysis automatically; Q26 re-asked as Q34 (answered); Q27 re-asked as Q35 (answered).

#### Q28 — Contract payload

- ✅ **B — flat: `{ lines: [{ text, confidence, box }] }`; reply text = `lines.text` joined by `\n`. Rationale (user): lines + text are more than enough for the future AI step; regions/words/symbols hierarchy is needless complexity.**
- A — mirror Vision's full hierarchy (page→block→paragraph→word→symbol)
- C — `fullText` + per-page average confidence only

Derived constraints accepted with B (◐, stated in discussion):
- Line text must be reconstructed from symbols honoring `detectedBreak` (SPACE/NO_BREAK/hyphenation), NOT naive `word + ' '` joining — otherwise character fidelity breaks on non-space scripts.
- Invariant test: `lines.map(l => l.text).join('\n')` must equal `fullTextAnnotation.text` (modulo its trailing newline) — guards provider-adapter fidelity.
- Line `confidence` is derived (mean of word confidences) since Vision has no line-level score; `box` = union of word boxes. All derived in the adapter, not the contract consumer.

Note (2026-09-23, during planning): line confidence is refined to a **character-weighted**
mean of constituent word confidences (equivalently the mean of symbol confidences), so a long
item line is not dominated by a short token. The "mean of word confidences" wording above is
kept as the interview record. Mirrored in `research.md` R4 and `contracts/google-vision.md`
clause 3.

#### Q29 — Transport

- ✅ **B — `google-auth-library` (service-account JWT → bearer token) + plain `fetch` to REST v1; no full client library.**
- A — `@google-cloud/vision` client library
- C — zero-dependency self-signed JWT

Note (2026-09-23, during planning): the user later chose **A — the `@google-cloud/vision`
client library**, after reviewing the trade-off. The Q29-B answer above is kept as the
interview record; this note records the later decision and supersedes it. `research.md` R1
and `plan.md` use the client library.

#### Q30 — Credentials & env shape

- ✅ **A — `OCR_PROVIDER=gcp-vision|none` + `GCP_SA_KEY_PATH` (path to service-account JSON on the VPS, outside repo, secret never logged).** With `none`, OCR path disabled and no GCP vars required.
- B — inline key JSON env var
- C — stock `GOOGLE_APPLICATION_CREDENTIALS` ADC convention

#### Q31 — Language hints

- ✅ **B — optional `OCR_LANGUAGE_HINTS` env (comma-separated hint strings, e.g. `en-t-i0-handwrit`); unset = auto-detection (docs-recommended default).**
- A — never send hints in v1

#### Q32 — Size threshold (amends 19a)

- ✅ **A — single inline base64 path; hardcoded local threshold lowered to 7 MB (Vision's 10 MB JSON request cap makes ~7 MB raw the inline ceiling). SPEC AMENDMENT: spec's assumed 10 MB default becomes 7 MB, with the provider-request-limit rationale recorded.**
- B — 10 MB cap with CDN `imageUri` fallback path for 7–10 MB

#### Q33 — Format allowlist (amends 18a)

- ✅ **B — conservative: JPEG, PNG, WEBP only; everything else (GIF, BMP, TIFF, HEIC, video, files) → local unsupported-format reply, no Vision call.** (Recommended was A, Vision's full format set — user prefers the narrow real-world set.)
- A — allowlist = Vision's supported image formats
- C — JPEG/PNG/TIFF

#### Q34 — Partial failure of a multi-image message (was Q26)

- ✅ **A — all-or-nothing: any image failure (local or provider-reported, including a per-image `error` inside a 200 response) → single matching message class, no partial text posted.**
- B — best-effort with marker

#### Q35 — "No readable text" predicate (was Q27)

- ✅ **A — fires when the call succeeds but whole-page text is empty or whitespace-only; no confidence-based cutoffs (that would be interpretation).**
- B — plus confidence-cutoff noise filter

Note (2026-09-23, during planning): for a multi-image submission the predicate is evaluated
on the **combined** text of all images, not per image — an image with no recognized text is
skipped and the remaining images' text is used; the no-readable-text reply fires only when no
image yields text. The Q35-A wording above is kept as the interview record. Mirrored in
`spec.md` FR-013 and `contracts/shopping-list.md` clause 1.5.

### Round 5 — final frontier (2026-09-21)

Q28 reaffirmed: no visual grounding / overlay / any image interaction beyond reading is planned for the project's future — flat lines contract stands, no reopening.

#### Q36 — `OCR_PROVIDER=none` behavior

- ✅ **A — image in an allowed channel while OCR is off → the generic service-unavailable reply (never silence).**
- B — silently ignore images

#### Q37 — Provider cannot decode an allowlisted-format file

- ✅ **A — Vision `INVALID_ARGUMENT`/decode error (per-image error in a 200) classifies as an input problem → the distinct unsupported-format reply.**
- B — generic service-side message

#### Q38 — HEIC known-unsupported (from Q33-B)

- ✅ **B — record HEIC in spec edge cases as known-unsupported, AND add a deferred GitHub issue for image-conversion support.**
- A — just document it

#### Q39 — Monitoring (user-initiated addition)

- ✅ **Add a 5th/6th deferred GitHub issue: observability/monitoring for the bot (e.g. Grafana); the issue body must mention a metric counter for unsupported image formats.** Project framing: this is a learning project.
- (open-ended user instruction, no choices)

Deferred-issue roster is now SIX: `!help` command, context-aware/AI guidance, duplicate de-duplication, DM support, image-conversion support (HEIC), monitoring/Grafana.

### Session closed (2026-09-21)

Frontier empty after round 5; user confirmed ("lgtm") the 18-point amendment list and all decisions were consolidated into `spec.md` (revised 2026-09-21). Per the constitution this ledger is now a historical supplementary artifact only — downstream phases consume `spec.md` alone.







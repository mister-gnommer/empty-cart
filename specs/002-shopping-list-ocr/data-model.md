# Data Model: Shopping List Photo OCR

**Feature**: `002-shopping-list-ocr` | **Date**: 2026-09-22

Entities are derived from the spec's Key Entities. Everything here is **transient** —
nothing is persisted beyond the handling of one submission (FR-018). The authoritative
TypeScript home for these shapes is `src/shared/types.ts` and `src/ocr/types.ts` (the
provider-contract types live with the contract, per module ownership).

---

## Entity 1 — Shopping-List Submission

A single inbound Discord message interpreted as one shopping list.

| Field | Type | Notes |
|---|---|---|
| `correlationId` | string (uuid) | Minted at message receipt; binds all logs and the busy-guard entry for the submission's lifetime. |
| `userId` | string (snowflake) | Discord author id. Busy-guard key. |
| `guildId` | string \| null | Originating guild; null defensive (DMs are out of scope for v1). |
| `channelId` | string (snowflake) | Originating channel; the reply target ("same conversation"). |
| `attachments` | ListImage[] | Ordered exactly as they appear in the message; order is processing order. |
| `receivedAt` | number (epoch ms) | Budget and latency measurement anchor. |
| `status` | SubmissionStatus | Lifecycle state, see transitions below. |

`SubmissionStatus` = `received → checked → in-flight → (succeeded | failed | cancelled)`,
plus `rejected-busy` when the busy guard refuses the submission before processing.

**State transitions** (logged at each step with `correlationId`, FR-017):

```text
received ──(local metadata checks pass)──▶ checked ──(guard acquire ok)──▶ in-flight
received ──(any local check fails)───────▶ failed [input problem, no provider call]
checked  ──(user already in flight)──────▶ rejected-busy [no download, no provider call]
in-flight ──(all images recognized)──────▶ succeeded
in-flight ──(any image fails)────────────▶ failed [all-or-nothing: single message, no partial text]
in-flight ──(25 s shared budget spent)───▶ cancelled [generic message; client-side abandon]
```

- Not persisted; the map entry and all fields are dropped when the reply is posted.
- Multi-user isolation: submissions are keyed and processed per `userId`; no code path
  reads another user's submission, image, or text.

## Entity 2 — List Image

One image attachment belonging to a submission.

| Field | Type | Notes |
|---|---|---|
| `position` | number (0-based) | Index within the submission's attachment order. |
| `url` | string | Discord CDN url (pre-signed; original bytes — never `proxyURL`). |
| `reportedSize` | number \| null | Discord-reported bytes; free pre-download size gate (research R8). |
| `reportedContentType` | string \| null | Extension-derived hint; pre-filter only, never authoritative (R9). |
| `bytes` | Uint8Array | Present only between download and provider call; then dropped. |
| `format` | `'jpeg' \| 'png' \| 'webp'` | Authoritative, from magic-byte sniff after download. |
| `sizeBytes` | number | Authoritative downloaded byte count (stream-capped). |

**Validation rules** (all reject before any provider call, FR-015/FR-021):
- `reportedSize > 7 MB` → *too-large* (no download).
- `reportedContentType` present and outside `image/jpeg|png|webp` → *unsupported-format* (no download).
- Download exceeds 7 MB (stream cap) → *too-large*.
- Magic bytes not matching JPEG/PNG/WEBP → *unsupported-format*.
- Fetch failure / non-OK status → *unretrievable* (service-side).

## Entity 3 — Recognized List Text

The provider-agnostic recognition output for **one** image, defined at the FR-005 handoff
boundary. Owned by `src/ocr/`.

```ts
type RecognizedLine = {
  text: string;              // the line as the provider produced it
  confidence: number;        // [0,1], char-weighted mean of word confidences (R4)
  boundingBox: { x: number; y: number; width: number; height: number }; // px, word-box union (R5)
};

type Recognition = {
  text: string;              // whole-page text, provider's own break semantics
  lines: RecognizedLine[];   // ordered
};
```

**Invariant**: `lines.map(l => l.text).join('\n') === text`, except that a single trailing
empty line produced by a terminal break is dropped (R3). Only `text` crosses into
user-facing output in v1; `lines` (confidence/position) is the future AI handoff.

**Multi-image presentation**: the user-facing reply body is the per-image `text` values in
attachment order, joined with a single `'\n'` between images. No trimming, normalization,
or reordering anywhere (FR-003/FR-004; spec §Assumptions "List fidelity over accuracy").

## Entity 4 — OCR Provider

The replaceable recognition service behind the provider contract.

| Attribute | Value |
|---|---|
| selection identity | `'gcp-vision' \| 'none'` (config `OCR_PROVIDER`) |
| credential reference | service-account key file path (config `GCP_SA_KEY_PATH`) |
| language hints | optional BCP-47 list (config `OCR_LANGUAGE_HINTS`) |
| operational status | derived per-call from outcome mapping (R6); no health state is kept |

Two implementations exist in v1: the Google Vision provider (real) and the disabled
provider (always returns `unavailable` cause `disabled`, so a disabled configuration still
answers every image with the generic message, FR-025). Tests add a stub provider.

## Entity 5 — OCR Request / Result

One recognition attempt against one List Image.

| Field | Type | Notes |
|---|---|---|
| `image` | List Image (bytes + format) | input |
| `languageHints` | readonly string[] | forwarded to the provider's `imageContext` |
| `timeoutMs` | number | remaining shared-budget ms at call time (R7) |
| `outcome` | OcrProviderResult | see below |

```ts
type OcrProviderResult =
  | { status: 'ok'; recognition: Recognition }
  | { status: 'undecodable-image' }                       // provider could not decode bytes
  | { status: 'unavailable'; cause: UnavailableCause };   // all service-side failures

type UnavailableCause =
  | 'unreachable' | 'unauthorized' | 'quota-exhausted'
  | 'provider-error' | 'deadline-exceeded' | 'disabled';
```

Mapping to user-facing output (the single place this decision lives, FR-013/014/015):

| Provider/image outcome | User message |
|---|---|
| ok, `text` empty or whitespace-only | *no-readable-text* message |
| ok, non-empty | recognized text (possibly split) |
| undecodable-image | *unsupported-format* message |
| unavailable (any cause) | *generic service-unavailable* message; cause + code logged with correlation id |
| local: size / format / unretrievable | *too-large* / *unsupported-format* / *generic* respectively |

## Entity 6 — Provider Configuration

Environment-derived; additions to the existing `Config` type:

| Env var | Config field | Required | Validation |
|---|---|---|---|
| `OCR_PROVIDER` | `ocrProvider: 'gcp-vision' \| 'none'` | no (default `'none'`) | enum |
| `GCP_SA_KEY_PATH` | `gcpSaKeyPath: string` | iff provider = `gcp-vision` (cross-field rule) | non-empty; readability checked at provider construction (startup) |
| `OCR_LANGUAGE_HINTS` | `ocrLanguageHints: readonly string[]` | no (default `[]` = auto-detect) | comma-separated; each entry loosely BCP-47 (`/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/`, accepts `en-t-i0-handwrit`) |
| `OCR_CHANNEL_ALLOWLIST` | `ocrChannelAllowlist: readonly string[] \| null` | no (`null` = every channel processed) | comma-separated snowflakes (`/^\d{17,20}$/`) |

Secrets rule: the key **path** may be logged; key **contents** never. The hardcoded
constants — 7 MB image ceiling, 25 s submission budget, 2000-char transport limit — are
module constants, not config (not operator-configurable in v1).

## Entity 7 — Deferred Work Item

Six concerns deliberately excluded from v1 (spec §Deferred Work), each tracked by a
GitHub issue created as part of delivering this feature (FR-023/SC-009): the `!help`
command; context-aware/AI-powered guidance; duplicate-submission de-duplication;
direct-message handling; image-format conversion (HEIC→JPEG); operator
observability/monitoring (incl. an unsupported-format counter metric). Attributes per
item: title, rationale, issue link. Tracked outside the system; no runtime
representation.

---

## Relationships

```text
Shopping-List Submission 1──* List Image            (ordered, all-or-nothing)
Shopping-List Submission 1──* OCR Request/Result     (one per image, sequential)
OCR Request/Result      *──1 OCR Provider            (via contract only)
OCR Provider            1──1 Provider Configuration  (selected/wired at startup)
OCR Request/Result ok   1──1 Recognized List Text    (transient; only text reaches the user)
```

## Multi-user isolation note

Per the Constitution, isolation is structural, not feature-gated: every entity above is
scoped to one submission (one user, one channel); the only shared mutable state is the
busy-guard `Map<userId, correlationId>`, which is write-only-until-release per key and
never exposes another user's data. Logs carry ids and sizes only — never image bytes,
recognized text, or credentials (FR-017, SC-005).

# Contract — `google-vision`

**Module path**: `src/google-vision/`
**Depends on**: `src/ocr/` (contract), `src/shared/types`; the ONLY module permitted to
import `@google-cloud/vision` (enforced by `biome.json` `noRestrictedImports`, research R12)
**Depended on by**: `lifecycle` (wiring) — nothing else may know it exists
**Spec refs**: FR-002, FR-006, FR-007, FR-008, FR-020, User Story 3

## Public surface

```typescript
export function createGoogleVisionProvider(deps: { keyFile: string }): OcrProvider;

// Pure mappers, exported for unit tests (no client needed):
export function toRecognition(annotation: FullTextAnnotationLike): Recognition;
export function mapGoogleError(err: unknown): OcrProviderResult;
```

`createGoogleVisionProvider` reads the service-account key file at construction
(startup) and throws if it is missing/unreadable — the operator learns about a bad
`OCR_GOOGLE_VISION_KEY_FILE` at boot, not at the first photo (research R2). It constructs
`new ImageAnnotatorClient({ keyFilename: keyFile })` internally.

## Behavioral contract

1. **Request shape.** Each `recognize` call issues one
   `documentTextDetection` (feature `DOCUMENT_TEXT_DETECTION`) request with inline
   `image.content` bytes; when `languageHints` is non-empty it is forwarded as
   `imageContext.languageHints` (BCP-47), otherwise omitted (provider auto-detect,
   spec §Assumptions "Recognition language/model").
2. **Budget enforcement.** The call is made with google-gax call options
   `{ timeout: req.timeoutMs, retry: null }` — the client default (retries on
   `DEADLINE_EXCEEDED`/`UNAVAILABLE` with a 600 s total timeout) is disabled because it
   would destroy the 25 s submission budget (research R7).
3. **Line reconstruction (`toRecognition`, research R3).** Walk
   `pages → blocks → paragraphs → words → symbols`; append each symbol's text, then the
   translation of its `property.detectedBreak` (honoring `isPrefix`):
   `SPACE`/`SURE_SPACE` → `' '`, `EOL_SURE_SPACE`/`LINE_BREAK` → `'\n'`,
   `HYPHEN`/`UNKNOWN`/absent → `''`. Lines = the reconstructed string split on `'\n'`;
   drop exactly one trailing empty line if present. Per-line `confidence` = char-weighted
   mean of constituent word confidences (R4); per-line `boundingBox` = axis-aligned union
   of constituent word `boundingBox.vertices` in page pixel space (R5). The `ocr`
   contract fidelity invariant (`lines.join('\n') === text`) MUST hold.
4. **Empty success.** A successful response with no `fullTextAnnotation` or with
   empty/whitespace text resolves `ok` with the empty recognition — the "no readable
   text" decision belongs to the orchestrator, not the provider.
5. **Error mapping (`mapGoogleError`, research R6).** gRPC `GoogleError.code`:
   `3` + message containing `Bad image data` → `undecodable-image`;
   `4` → `unavailable`/`deadline-exceeded`; `7` → `unavailable`/`unauthorized`;
   `8` → `unavailable`/`quota-exceeded`; `14` → `unavailable`/`unreachable`;
   `16` → `unavailable`/`unauthorized`; any other code or non-GoogleError →
   `unavailable`/`provider-error`. The numeric code and `reason` (when present) are
   carried on the result's log context; secrets never are (key path is the most sensitive
   value allowed in logs, FR-008).
6. **No retention, no content logging** — per the `ocr` contract clauses 4.

## Test obligations (TDD — written first, red, then green)

- `toRecognition` unit tests over crafted annotation fixtures (no network, no client):
  - multi-paragraph input with `LINE_BREAK` and `EOL_SURE_SPACE` → ordered lines, and
    `lines.join('\n')` equals the fixture's `text` field byte-for-byte (fidelity
    invariant);
  - `SURE_SPACE` mid-line → single space, no line split;
  - terminal break → trailing empty line dropped;
  - word confidences → char-weighted line confidence (hand-computed expectation);
  - word boxes → expected union envelope;
  - empty annotation → `ok`-shaped empty recognition.
- `mapGoogleError` table tests: one case per row of the mapping table in clause 5,
  including a non-Error throw and a `code: 3` without the `Bad image data` signature
  (conservative `provider-error`).
- `createGoogleVisionProvider` construction failure: nonexistent `keyFile` → throws at
  construction (startup), error message names the env var, never the key contents.
- Request-shape test with a stubbed `ImageAnnotatorClient` (constructor seam): asserts
  feature type, inline bytes pass-through, languageHints forwarding (set vs omitted), and
  that call options carry `retry: null` and the forwarded `timeout`.
- NO test contacts the real Vision API; live behavior is validated in quickstart's manual
  smoke run.

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
`GCP_SA_KEY_PATH` at boot, not at the first photo (research R2). It constructs
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
4. **Response handling.** `documentTextDetection` resolves to a `BatchAnnotateImagesResponse`
   (the library's own type); the provider reads the single entry at `responses[0]`. No
   exhaustive failure matrix is invented — the library types define the surface, and only
   two fields matter:
   - `responses[0].error` present (Vision reports per-image failures in-band on a 200) →
     mapped through `mapGoogleError`; the `google.rpc.Status` carries the same numeric
     `code`/`message` shape, so a decode failure becomes `undecodable-image` (Q37);
   - otherwise `responses[0].fullTextAnnotation` is passed to `toRecognition`; a missing or
     empty annotation resolves `ok` with the empty recognition — the "no readable text"
     decision belongs to the orchestrator, not the provider;
   - when the annotation carries its own `text`, `recognition.text` IS that provider
     text (what the user receives), `recognition.lines` comes from the reconstruction,
     and the result reports `fidelityCheck: 'match' | 'mismatch'` comparing the two.
     Without a `text` field, the reconstruction supplies both and no check is reported.
5. **Error mapping (`mapGoogleError`, research R6).** Applied to both a thrown `GoogleError`
   and an in-band `responses[0].error`. gRPC/status `code`:
   `3` + message containing `Bad image data` → `undecodable-image`;
   `4` → `unavailable`/`deadline-exceeded`; `7` → `unavailable`/`unauthorized`;
   `8` → `unavailable`/`quota-exhausted`; `14` → `unavailable`/`unreachable`;
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
- In-band failure: a `BatchAnnotateImagesResponse` whose `responses[0].error` carries
  `code: 3`/`Bad image data` → `undecodable-image`, NOT empty text (Q37).
- `createGoogleVisionProvider` construction failure: nonexistent `keyFile` → throws at
  construction (startup), error message names the env var, never the key contents.
- Request-shape test with a stubbed `ImageAnnotatorClient` (constructor seam): asserts
  feature type, inline bytes pass-through, languageHints forwarding (set vs omitted), and
  that call options carry `retry: null` and the forwarded `timeout`.
- Fidelity self-check: provider text equal to the reconstruction → `match`; different →
  `mismatch` with the provider's text returned and the reconstructed lines kept; no
  provider text → reconstruction returned, no check.
- NO test contacts the real Vision API. Live behavior, including a recorded real-response
  fixture for the reconstruction, is validated after merge (see the post-merge
  validation issue).

## Supersession notes

- **2026-09-25** (post-implementation analysis): added the `fidelityCheck` self-check
  (clause 4). Fixed the `quota-exceeded` → `quota-exhausted` naming drift in clause 5 to
  match the `ocr` contract and the code.
- **2026-09-25** (PR review): on `mismatch` the provider's own page text is returned, not
  the reconstruction. This supersedes the earlier clause-4 wording and research R3's
  choice of the reconstruction as reply text. The reconstruction now only supplies
  per-line metadata.


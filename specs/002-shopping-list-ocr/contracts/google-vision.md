# Contract — `google-vision`

**Module path**: `src/ocr/google-vision/`
**Depends on**: `src/ocr/` (contract), `src/shared/types`; the ONLY module permitted to
import `@google-cloud/vision` (enforced by `biome.json` `noRestrictedImports`, research R12)
**Depended on by**: `lifecycle` (wiring) — nothing else may know it exists
**Spec refs**: FR-002, FR-006, FR-007, FR-008, FR-020, User Story 3

## Public surface

```typescript
export function createGoogleVisionProvider(deps: { keyFilePath: string }): OcrProvider;

// Pure mapper, exported for unit tests (no client needed):
export function mapGoogleError(err: unknown): OcrProviderResult;
```

`createGoogleVisionProvider` reads the service-account key file at construction
(startup) and throws if it is missing/unreadable — the operator learns about a bad
`GCP_SA_KEY_PATH` at boot, not at the first photo (research R2). It constructs
`new ImageAnnotatorClient({ keyFilename: keyFilePath })` internally.

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
3. **Page text only.** The provider uses `fullTextAnnotation.text` as-is. The
   annotation's structure tree (`pages → … → symbols`, `detectedBreak`, confidences,
   bounding boxes) is not read in v1; word-level confidence from it is planned for
   feature 003.
4. **Response handling.** `documentTextDetection` resolves to a `BatchAnnotateImagesResponse`
   (the library's own type); the provider reads the single entry at `responses[0]`. No
   exhaustive failure matrix is invented — the library types define the surface, and only
   two fields matter:
   - `responses[0].error` present (Vision reports per-image failures in-band on a 200) →
     mapped through `mapGoogleError`; the `google.rpc.Status` carries the same numeric
     `code`/`message` shape, so a decode failure becomes `undecodable-image` (Q37);
   - otherwise the result is `{ status: 'ok', text: responses[0].fullTextAnnotation?.text ?? '' }`;
     a missing annotation or text resolves `ok` with `''` — the "no readable text"
     decision belongs to the orchestrator, not the provider.
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

- `mapGoogleError` table tests: one case per row of the mapping table in clause 5,
  including a non-Error throw and a `code: 3` without the `Bad image data` signature
  (conservative `provider-error`).
- In-band failure: a `BatchAnnotateImagesResponse` whose `responses[0].error` carries
  `code: 3`/`Bad image data` → `undecodable-image`, NOT empty text (Q37).
- `createGoogleVisionProvider` construction failure: nonexistent `keyFilePath` → throws at
  construction (startup), error message names the env var, never the key contents.
- Request-shape test with a stubbed `ImageAnnotatorClient` (constructor seam): asserts
  feature type, inline bytes pass-through, languageHints forwarding (set vs omitted), and
  that call options carry `retry: null` and the forwarded `timeout`.
- Response mapping: the annotation's `text` is returned byte-for-byte; a missing
  annotation or `text` → `ok` with `''`; an in-band `error` wins over an annotation that
  is also present.
- NO test contacts the real Vision API. Live behavior is validated after merge (see the
  post-merge validation issue).

## Supersession notes

- **2026-09-25** (post-implementation analysis): added the `fidelityCheck` self-check
  (clause 4). Fixed the `quota-exceeded` → `quota-exhausted` naming drift in clause 5 to
  match the `ocr` contract and the code.
- **2026-09-25** (PR review): on `mismatch` the provider's own page text is returned, not
  the reconstruction. This supersedes the earlier clause-4 wording and research R3's
  choice of the reconstruction as reply text. The reconstruction now only supplies
  per-line metadata.
- **2026-09-27** (PR review): the provider returns `fullTextAnnotation.text ?? ''` and no
  longer walks the structure tree. `toRecognition`, the `detectedBreak` line building,
  per-line confidence and box, and the `fidelityCheck` comparison are removed (clauses 3
  and 4), along with their tests. The in-band error check still comes first. Why: the
  reconstruction only rebuilt the page text to attach per-line metadata that nothing in
  v1 consumes; per-word confidence for the AI step is planned for feature 003.

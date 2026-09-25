# Contract — `ocr`

**Module path**: `src/ocr/`
**Depends on**: nothing outside `src/shared/types` (pure types + the disabled provider)
**Depended on by**: `shopping-list` (orchestrator), `google-vision` (implements), `lifecycle` (wiring)
**Spec refs**: FR-005, FR-006, FR-007, FR-014, FR-025, User Story 3

## Public surface

```typescript
export type OcrImageFormat = 'jpeg' | 'png' | 'webp';

export type UnavailableCause =
  | 'unreachable'
  | 'unauthorized'
  | 'quota-exhausted'
  | 'provider-error'
  | 'deadline-exceeded'
  | 'disabled';

// Vendor diagnostics for the operator log; never secrets, bytes, or text.
export type ProviderLogContext = Readonly<Record<string, string | number | null>>;

export type OcrProviderResult =
  | { status: 'ok'; text: string } // whole-page text, provider's own break semantics
  | { status: 'undecodable-image'; logContext?: ProviderLogContext }
  | { status: 'unavailable'; cause: UnavailableCause; logContext?: ProviderLogContext };

export interface OcrProvider {
  readonly id: string;
  recognize(req: {
    image: { bytes: Uint8Array; format: OcrImageFormat };
    languageHints: readonly string[];
    timeoutMs: number;
  }): Promise<OcrProviderResult>;
}

export function createDisabledProvider(): OcrProvider;
```

## Behavioral contract

1. **Result union, never throws for expected failures.** `recognize` resolves with
   exactly one of the three result arms for every anticipated failure mode (unreachable
   network, bad credentials, quota, provider error, deadline, undecodable bytes). It MAY
   only reject on programmer error (e.g. empty `bytes`); the orchestrator treats any
   rejection as `unavailable`/`provider-error` defensively.
2. **Page text as returned.** For every `ok` result, `text` is the vendor's whole-page
   text for the image, including its line breaks. Providers MUST NOT trim, normalize,
   sort, de-duplicate, or otherwise alter it (FR-003). A missing vendor page text is
   `''`, never an error.
3. **No per-line or per-word metadata in v1** (FR-005). Word-level detail with per-word
   confidence is added by feature 003 together with its AI consumer.
4. **No retention.** The provider MUST NOT retain image bytes or recognition output after
   its promise settles (FR-018), and MUST NOT log either (FR-017, SC-005).
5. **Deadline respect.** The provider MUST abandon the remote call client-side within
   `timeoutMs` and resolve `unavailable`/`deadline-exceeded` (or `provider-error` if the
   underlying transport reports it differently); it MUST NOT wait past the budget.
6. **`createDisabledProvider()`** returns a provider with `id: 'disabled'` whose every
   call resolves `{ status: 'unavailable', cause: 'disabled' }` without any I/O — this is
   how a disabled configuration still answers every image submission that passes the
   input checks (FR-025).
7. **Opaque log context.** A failure arm MAY carry `logContext` with vendor diagnostics
   (e.g. a raw error code). The orchestrator logs it nested and never branches on it; it
   MUST NOT hold secrets, image bytes, or recognized text (FR-008, SC-005).
8. **Swap-by-configuration.** Adding a provider = a new sibling module implementing
   `OcrProvider` plus one config enum value plus one wiring branch in `lifecycle`. No edit
   to `shopping-list`, `image`, or `discord` (FR-006, SC-004).

## Test obligations (TDD — written first, red, then green)

- A **stub provider** implementing `OcrProvider` is defined in `tests/helpers/` and used
  by the orchestrator and integration tests — its existence and conformance IS the
  contract test for FR-006/SC-004 (the full user-facing flow runs against it with zero
  external calls, US3 scenario 3).
- Stub conformance cases: scripted `ok` (page text), `undecodable-image`, and every
  `UnavailableCause` — the orchestrator contract tests enumerate them.
- `createDisabledProvider`: every call resolves `unavailable`/`disabled`; performs no
  network access (asserted by running with a sabotaged global fetch).

## Supersession notes

- **2026-09-25** (post-implementation analysis): added the optional `fidelityCheck` to the
  `ok` arm. The fidelity invariant had only been checked against hand-crafted fixtures,
  never against a real vendor response.
- **2026-09-25** (PR review): `recognition.text` is the vendor's page text when
  available. The fidelity invariant is relaxed to "holds unless `fidelityCheck` is
  `mismatch`".
- **2026-09-27** (PR review): the `ok` arm is `{ status: 'ok'; text }`. `Recognition`,
  `RecognizedLine`, the fidelity invariant and `fidelityCheck` are removed, together with
  the fixture property check. Why: the vendor's page text already carries the line
  breaks and is what the user receives; per-line metadata had no v1 consumer, and
  per-word confidence (feature 003) is the shape the AI step needs.
- **2026-09-28** (PR review): failure arms gain the optional `logContext`. Why: the
  `google-vision` contract already required the Vision code and reason to be carried for
  the log, but the result union had nowhere to put them, so they were computed and
  dropped and the operator saw only the broad cause.

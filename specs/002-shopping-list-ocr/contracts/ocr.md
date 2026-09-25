# Contract — `ocr`

**Module path**: `src/ocr/`
**Depends on**: nothing outside `src/shared/types` (pure types + the disabled provider)
**Depended on by**: `shopping-list` (orchestrator), `google-vision` (implements), `lifecycle` (wiring)
**Spec refs**: FR-005, FR-006, FR-007, FR-014, FR-025, User Story 3

## Public surface

```typescript
export type RecognizedLine = {
  text: string;
  confidence: number; // [0,1]
  boundingBox: { x: number; y: number; width: number; height: number };
};

export type Recognition = {
  text: string;             // whole-page text, provider's own break semantics
  lines: RecognizedLine[];  // ordered
};

export type OcrImageFormat = 'jpeg' | 'png' | 'webp';

export type UnavailableCause =
  | 'unreachable'
  | 'unauthorized'
  | 'quota-exhausted'
  | 'provider-error'
  | 'deadline-exceeded'
  | 'disabled';

export type OcrProviderResult =
  | {
      status: 'ok';
      recognition: Recognition;
      // Provider self-check: its own whole-page text === recognition.text?
      // Absent when the provider has no separate page text. Content-free, loggable.
      fidelityCheck?: 'match' | 'mismatch';
    }
  | { status: 'undecodable-image' }
  | { status: 'unavailable'; cause: UnavailableCause };

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
2. **Fidelity invariant.** For every `ok` result:
   `recognition.lines.map((l) => l.text).join('\n') === recognition.text`, except that a
   single trailing empty line produced by a terminal provider break MAY be dropped.
   Providers MUST NOT trim, normalize, sort, de-duplicate, or otherwise alter text
   (FR-003; the joined-lines-equals-page-text rule is from spec §Assumptions). A
   provider whose `lines` are derived separately from the vendor's page text SHOULD put
   the vendor's page text in `recognition.text`, and SHOULD report `fidelityCheck`. On
   `mismatch` the invariant above does not hold: `text` stays authoritative for the
   reply, and the lines are best-effort metadata.
3. **Handoff metadata.** Every line carries `confidence` and `boundingBox` (FR-005).
   v1 consumers use only `recognition.text`; the metadata exists for the future AI flow.
4. **No retention.** The provider MUST NOT retain image bytes or recognition output after
   its promise settles (FR-018), and MUST NOT log either (FR-017, SC-005).
5. **Deadline respect.** The provider MUST abandon the remote call client-side within
   `timeoutMs` and resolve `unavailable`/`deadline-exceeded` (or `provider-error` if the
   underlying transport reports it differently); it MUST NOT wait past the budget.
6. **`createDisabledProvider()`** returns a provider with `id: 'disabled'` whose every
   call resolves `{ status: 'unavailable', cause: 'disabled' }` without any I/O — this is
   how a disabled configuration still answers every image submission that passes the
   input checks (FR-025).
7. **Swap-by-configuration.** Adding a provider = a new sibling module implementing
   `OcrProvider` plus one config enum value plus one wiring branch in `lifecycle`. No edit
   to `shopping-list`, `image`, or `discord` (FR-006, SC-004).

## Test obligations (TDD — written first, red, then green)

- A **stub provider** implementing `OcrProvider` is defined in `tests/helpers/` and used
  by the orchestrator and integration tests — its existence and conformance IS the
  contract test for FR-006/SC-004 (the full user-facing flow runs against it with zero
  external calls, US3 scenario 3).
- Stub conformance cases: scripted `ok` (with lines/text honoring the fidelity invariant),
  `undecodable-image`, and every `UnavailableCause` — the orchestrator contract tests
  enumerate them.
- `createDisabledProvider`: every call resolves `unavailable`/`disabled`; performs no
  network access (asserted by running with a sabotaged global fetch).
- Fidelity invariant property check: for a table of crafted `Recognition` fixtures,
  `lines.join('\n') === text` holds (this guards the fixtures the google-vision mapper
  tests rely on).

## Supersession notes

- **2026-09-25** (post-implementation analysis): added the optional `fidelityCheck` to the
  `ok` arm. The fidelity invariant had only been checked against hand-crafted fixtures,
  never against a real vendor response.
- **2026-09-25** (PR review): `recognition.text` is the vendor's page text when
  available. The fidelity invariant is relaxed to "holds unless `fidelityCheck` is
  `mismatch`".


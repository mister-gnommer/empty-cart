# Implementation Plan: Shopping List Photo OCR

**Branch**: `002-shopping-list-ocr` | **Date**: 2026-09-22 | **Spec**: `specs/002-shopping-list-ocr/spec.md`

**Input**: Feature specification from `/specs/002-shopping-list-ocr/spec.md`

## Summary

Extend the 001 Discord bot so that a photo of a handwritten shopping list posted in a
processed channel comes back as recognized text — byte-faithful to the OCR provider's
output, in the provider's line order, with no AI interpretation. Recognition goes through
a provider-agnostic `src/ocr/` contract; the initial provider is Google Cloud Vision
document text detection behind `src/google-vision/` (the only module importing
`@google-cloud/vision`, machine-enforced via Biome). A pure orchestrator
(`src/shopping-list/`) owns the evaluation order — local metadata checks → per-user busy
guard → sequential multi-image processing under one shared 25 s budget, all-or-nothing —
and maps every outcome to the spec's three message classes (one generic service message,
distinct actionable input-problem messages, a distinct busy message). The `src/discord/`
adapter gains attachment routing, a channel allowlist, the hardcoded `!help` usage hint,
and 2000-char line-boundary reply splitting with an explicit mid-line continuation
marker; mention neutralization stays at the transport (empty `allowedMentions` on every
send). Phase 0 research (`research.md` R1–R12) fixed the client library and version, the
symbol-level line-reconstruction algorithm, per-line confidence/position conventions, the
gRPC error→taxonomy mapping, gax timeout/retry control, attachment download size guards,
magic-byte format sniffing, and the module boundaries.

## Technical Context

Filled from `research.md` (Phase 0); all initially-unknown items are resolved there.

**Language/Version**: TypeScript 7.0.2 on Node.js 24 LTS, compiled by `tsc` to CommonJS
in `dist/` (unchanged from 001).

**Primary Dependencies**:
- `@google-cloud/vision@6.1.0` — NEW. Official Vision client (`ImageAnnotatorClient.
  documentTextDetection`); `engines.node >= 22` covers Node 24. Exact pin per AGENTS.md.
  Imported only by `src/google-vision/` (research R1, R12).
- `discord.js@14.27.0`, `pino@10.3.1`, `zod@4.4.3`, `vitest@4.1.10`, `tsx@4.23.1`,
  `@types/node@24.13.3`, `@biomejs/biome@2.5.6` — unchanged from 001.
- No other new runtime dependency: attachment download uses global `fetch`; format
  sniffing is three 12-byte checks (research R9 — a sniffing library was rejected under
  YAGNI).

**Storage**: N/A. Images and recognized text are transient per submission and never
persisted (FR-018); logs carry ids/sizes only (FR-017, SC-005).

**Testing**: Vitest, three tiers under `tests/` as in 001 — unit (pure mappers: line
reconstruction, error mapping, sniff, splitReply, config), contract (stub-provider swap,
orchestrator evaluation order, adapter routing), integration (message-in → reply-out via
the stubbed Discord client + stub provider, incl. the SC-005 log scan). No test contacts
the real Vision API or Discord gateway.

**Target Platform**: The existing single personal Linux VPS + systemd deployment from
001 (docs/deployment.md); one new secret file (service-account JSON key) on that host.

**Project Type**: Long-running background service / bot daemon (one process), extended
in place.

**Performance Goals**:
- Recognized-text reply within 30 s for ≥90% of typical single-page lists (SC-001) —
  manual live smoke validation (quickstart §3 #1); automated tests assert correctness
  and the 25 s budget, not wall-clock provider latency.
- Hard per-submission budget of 25 s shared across all images (FR-020) — enforced
  client-side via per-call gax `timeout` with retries disabled (research R7); automated
  via the orchestrator's `now()` seam.
- >2000-char replies delivered completely and in order (SC-007) — automated
  splitReply + adapter contract tests.

**Constraints**: hardcoded 7 MB image ceiling and 25 s budget (not operator-configurable,
spec §Assumptions); accepted formats JPEG/PNG/WEBP only; Discord 2000-char message limit;
single generic user message for all service-side failures (FR-014); no AI/LLM anywhere in
v1 (FR-005); the six deferred concerns ship as GitHub issues, not code (FR-023/SC-009).

**Scale/Scope**: one operator, one bot process; multi-user isolation structural
(per-user busy guard, per-submission state) per the Constitution constraint.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle / Constraint | How this plan satisfies it | Evidence |
|---|---|---|
| **I. Test-First (non-negotiable)** | Every new/changed module contract carries an explicit "Test obligations" section to be written red-first; the stub provider makes the whole user-facing flow testable without external services. | `contracts/*.md` test sections; `quickstart.md` §1 |
| **II. Modular Orchestration** | One module per capability with a declared contract: `ocr` (contract), `google-vision` (provider), `image` (download+sniff), `shopping-list` (orchestration), plus extensions to `discord`/`config`/`lifecycle`. The orchestrator and contract modules are pure/vendor-free; `@google-cloud/vision` import is confined to `src/google-vision/` and machine-enforced by Biome. | `research.md` R12; `contracts/*.md`; `data-model.md` Relationships |
| **III. Observability** | Correlation id per submission across received → submitted → succeeded/failed/cancelled/rejected-busy; failure logs carry the specific cause (gRPC code/reason) while the user gets the generic message. | `contracts/shopping-list.md` clause 4; `contracts/google-vision.md` clause 5 |
| **IV. Data Privacy & Integrity** | Nothing persisted beyond submission handling; logs never contain image bytes, recognized text, or key material (verified by an automated post-run log scan); recognized text treated as untrusted — mention neutralization enforced at the transport with text bytes untouched; per-user/per-channel scoping everywhere. | FR-017/FR-018/SC-005; `contracts/discord.md` clause 2; `data-model.md` isolation note |
| **V. Simplicity & YAGNI** | One new runtime dependency, justified in research against raw-REST and local-OCR alternatives; no sniffing library, no queue, no cache, no de-duplication; hardcoded thresholds instead of config knobs (spec); deterministic OCR, no LLM (FR-005). | `research.md` R1/R9/R11; Complexity Tracking |
| **Constraint: Deployment target** | Same single VPS + systemd; one added secret file; no new services. | `quickstart.md` §2, §5 |
| **Constraint: Primary interface** | All user-facing behavior is Discord-only; no new required surface. | `contracts/discord.md` |
| **Constraint: Multi-user from day one** | Per-user busy guard and per-submission state; concurrent users isolated structurally and tested. | `contracts/shopping-list.md` clauses 1/3 |
| **Constraint: Language policy** | TypeScript throughout; no deviation. | — |
| **Constraint: External dependencies abstracted** | Vision sits behind the `src/ocr/` provider contract; swap = new module + config value + one wiring branch; the stub provider proves it (SC-004). | `contracts/ocr.md` clause 7; research R12 |
| **Constraint: Graceful degradation** | Every failure class maps to a defined user message; disabled provider still answers every image (FR-025); budget overruns abandon client-side and keep the bot responsive (FR-020). | `contracts/shopping-list.md`; research R6/R7 |
| **Workflow: Validate on VPS** | Live smoke scenarios incl. failure-injection run against the real deployment before "done". | `quickstart.md` §3, §5 |

**Gate verdict (pre-Phase 0)**: PASS — no unjustified violations.

## Project Structure

### Documentation (this feature)

```text
specs/002-shopping-list-ocr/
├── plan.md              # this file
├── research.md          # Phase 0 output (R1–R12)
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output — automated + live smoke validation
├── contracts/           # Phase 1 output — one declared contract per module
│   ├── ocr.md
│   ├── google-vision.md
│   ├── image.md
│   ├── shopping-list.md
│   ├── discord.md       # 002 extensions to the 001 adapter contract
│   └── config.md        # 002 extensions to the 001 config contract
├── checklists/          # pre-existing spec checklist (spec phase)
├── grilling-ledger.md   # supplementary discovery artifact (spec.md is canonical)
└── tasks.md             # Phase 2 output (/speckit.tasks — NOT created by /speckit.plan)
```

### Source Code (repository root)

New and changed modules, extending the 001 layout (flat `src/`, one contract per module):

```text
src/
├── shared/
│   └── types.ts          # extended: Config gains ocr fields (see contracts/config.md)
├── config/
│   ├── schema.ts         # extended: OCR env validation
│   └── load-config.ts    # extended: new fields + provider/key-file cross-field rule
├── ocr/                  # NEW — provider-agnostic contract (zero vendor imports)
│   ├── types.ts          # RecognizedLine, Recognition, OcrProviderResult, OcrProvider
│   └── disabled-provider.ts  # always-unavailable provider (FR-025)
├── google-vision/        # NEW — ONLY importer of @google-cloud/vision
│   ├── provider.ts       # createGoogleVisionProvider (key-file check at construction)
│   ├── to-recognition.ts # pure: fullTextAnnotation → Recognition (lines/confidence/boxes)
│   └── map-google-error.ts # pure: gRPC GoogleError → OcrProviderResult taxonomy
├── image/                # NEW — download + validate (global fetch, no vendor imports)
│   ├── fetch-image.ts    # size guards (reported/Content-Length/stream cap), 7 MB ceiling
│   └── sniff-format.ts   # pure: JPEG/PNG/WEBP magic bytes
├── shopping-list/        # NEW — pure orchestration core (no vendor, no discord)
│   ├── handle-list-submission.ts # evaluation order, busy guard, shared budget, all-or-nothing
│   └── messages.ts       # canonical user-facing strings + usage hint
├── discord/
│   ├── adapter.ts        # extended: attachment routing, allowlist, usage hint, submission calls
│   └── split-reply.ts    # NEW pure: 2000-char line-boundary split + … continuation marker
├── lifecycle/
│   └── run-app.ts        # extended: build provider per config (google-vision | disabled),
│                         #   wire fetchImage + handler + usage hint into the adapter
├── health/               # unchanged
├── logger/               # unchanged
├── index.ts, health-cli.ts  # unchanged

tests/
├── unit/                 # to-recognition, map-google-error, sniff-format, split-reply,
│                         #   config (new fields), messages
├── contract/             # ocr (stub conformance), google-vision (request shape via
│                         #   stubbed client), image, shopping-list, discord routing,
│                         #   config
├── integration/          # full flow: message-in → reply-out vs stub provider; failure
│                         #   classes; multi-image; concurrent users; long text; log scan
└── helpers/              # + stub-ocr-provider.ts, scripted fetch helpers

biome.json                # +1 restricted import: @google-cloud/vision → src/google-vision only
.env.example              # + OCR_PROVIDER, OCR_GOOGLE_VISION_KEY_FILE, OCR_LANGUAGE_HINTS,
                          #   OCR_CHANNEL_ALLOWLIST
package.json              # + @google-cloud/vision@6.1.0 (exact pin)
docs/deployment.md        # + key-file provisioning and OCR env vars
```

**Structure Decision**: single-package layout (001 decision) unchanged; growth follows
the documented rule — new sibling modules under flat `src/`, each with its own contract,
and exactly one new `noRestrictedImports` entry for the one new vendor library
(`research.md` R12). The recognition capability is deliberately transport-independent
(`ocr`/`image`/`shopping-list` know nothing about Discord), honoring the spec's
"recognition defined independently of the transport" assumption.

## Complexity Tracking

> Filled per Principle V for choices that cross the simplest-possible line.

| Choice | Why needed | Simpler alternative rejected because |
|---|---|---|
| `@google-cloud/vision@6.1.0` (new runtime dep) | FR-007 fixes Google Cloud Vision as the initial provider; the official client bundles service-account auth, typed request/response, and gRPC transport. | Raw REST + hand-rolled OAuth2 JWT exchange (rejected, research R1): re-implements auth and retries for no gain; Tesseract.js (rejected by spec: external OCR, poor handwriting quality). |
| Two pure mapper functions exported from `google-vision` (`to-recognition`, `map-google-error`) | Line reconstruction and the error taxonomy are the highest-risk logic in the feature; as pure exports they are unit-testable against fixtures with no client, no network, no credentials. | Testing through a mocked client only: heavier fixtures, slower tests, and the mapping logic hidden behind the I/O seam. |
| `image` as its own module (not inside `discord` or `shopping-list`) | Download size-guarding and format sniffing are transport-independent (global fetch to a CDN url) and independently testable; keeping them out of the adapter preserves "only the adapter knows discord.js" and out of the orchestrator keeps it pure. | Inline in the adapter: mixes plain HTTPS with the discord.js boundary and makes the size-cap logic untestable without the Discord seam. |
| Busy guard as an in-memory `Map` inside the handler factory | FR-024/SC-010 require reject-don't-queue per user; a Map with `finally`-release is the smallest correct structure. | A queue or lock library (rejected, research R11): the spec forbids queueing; a Map is one data structure with no dependency. |

No other complexity additions: no new framework, no cache, no persistence, no extra
config knobs (thresholds are hardcoded per spec).

## Post-Phase-1 Constitution re-check

Re-evaluated after `data-model.md`, `contracts/`, and `quickstart.md` were drafted:

- **Principle I**: every contract now enumerates concrete red-first test obligations, and
  quickstart §1 maps tiers to success criteria → satisfied.
- **Principle II**: the 1:1 module ↔ contract mapping holds for all four new modules and
  both extended ones; the vendor-import boundary is machine-enforced exactly like 001's
  (`@google-cloud/vision` confined to `src/google-vision/`) → satisfied and strengthened.
- **Principle III**: transition-level logging with correlation ids is contractual
  (`contracts/shopping-list.md` clause 4), with the content-free log rule verified by an
  automated scan → satisfied.
- **Principle IV**: transient-only data handling (FR-018), transport-level mention
  neutralization with byte-fidelity (FR-009/FR-012), per-user structural isolation, and
  the secrets rule (key path loggable, contents never) are all written into contracts →
  satisfied.
- **Principle V**: Complexity Tracking justifies the single new dependency and the three
  non-trivial structural choices; no scope crept in during design (still no AI, no
  preprocessing, no de-duplication) → satisfied.
- **Constraints**: VPS/systemd deployment, Discord-only surface, structural multi-user
  isolation, TypeScript, abstracted external dependency (stub-provable), graceful
  degradation incl. disabled-provider replies → all satisfied.

**Post-design gate verdict**: PASS. No Constitutional violation remains unjustified;
Phase 2 (`tasks.md`) may proceed under the `/speckit.tasks` command.

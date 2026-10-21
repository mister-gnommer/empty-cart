# Contract — `config` (002 extensions)

**Module path**: `src/config/`
**Depends on**: `src/shared/types`; remains the ONLY module permitted to import `zod`
**Depended on by**: everything (via the `Config` type)
**Spec refs**: FR-008, FR-019, FR-025, spec §Assumptions (initial provider, language
hints, allowlist)
**Base**: extends the 001 `config` contract (per-field `missing`/`malformed` `ConfigError`
in documented field order, frozen result) — unchanged clauses are not restated.

## Public surface (additions to `Config`)

```typescript
type OcrProviderConfig =
  | Readonly<{ kind: 'gcp-vision'; keyFilePath: string }>
  | Readonly<{ kind: 'none' }>;

type Config = Readonly<{
  /* ...existing 001 fields... */
  ocrProvider: OcrProviderConfig;
  ocrLanguageHints: readonly string[];
  ocrChannelAllowlist: readonly string[] | null; // null = process every channel
}>;
```

## Env mapping & validation

| Env var | Field | Rule |
|---|---|---|
| `OCR_PROVIDER` | `ocrProvider.kind` | Optional; default `'none'`. Any other non-empty value → `malformed`. |
| `GCP_SA_KEY_PATH` | `ocrProvider.keyFilePath` (gcp-vision arm only) | **Required iff `OCR_PROVIDER=gcp-vision`** (cross-field rule): absent/empty then → `ConfigError('GCP_SA_KEY_PATH', 'missing')`. When provider is `none`, any value (absent, empty, or a pre-staged path) is accepted and dropped — the `none` arm carries no key path. File readability is NOT checked here (config is pure I/O-free) — the `google-vision` module checks at provider construction (startup). |
| `OCR_LANGUAGE_HINTS` | `ocrLanguageHints` | Optional; default `[]`. Comma-separated; each non-empty entry must match `/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/` (loose BCP-47, accepts the `en-t-i0-handwrit` handwriting form) → else `malformed`. `[]` = provider auto-detect. |
| `OCR_CHANNEL_ALLOWLIST` | `ocrChannelAllowlist` | Optional; absent → `null` (process every channel the bot can see, FR-019). Comma-separated; each entry must match `/^\d{17,20}$/` (Discord snowflake) → else `malformed`. An explicitly empty value is `malformed` (an empty allowlist would silently disable OCR everywhere — almost certainly operator error). |

1. **Field order**: the new fields validate after all 001 fields, in the table order
   above, so the first-error contract remains deterministic. The cross-field
   `GCP_SA_KEY_PATH` rule is evaluated at its position (after `ocrProvider` has
   been parsed).
2. **Secrets**: the key file path is a PATH, loggable; the key file's contents are
   never read by config and never logged anywhere (FR-008). No other OCR field is
   sensitive.
3. **Hardcoded constants are NOT config**: the 7 MB image ceiling, the 25 s submission
   budget, and the 2000-char transport limit are module constants (spec §Assumptions:
   not operator-configurable in v1).
4. Existing defaults and errors for all 001 fields are unchanged; a 001-era env file
   (only `DISCORD_TOKEN` set) still loads, yielding `ocrProvider: { kind: 'none' }` — the bot
   then answers image submissions with the generic message (FR-025) instead of failing
   to boot.

## Test obligations (TDD — written first, red, then green)

- Defaults: env with only `DISCORD_TOKEN` → `ocrProvider { kind: 'none' }`,
  `ocrLanguageHints []`, `ocrChannelAllowlist null`.
- `OCR_PROVIDER=gcp-vision` without `GCP_SA_KEY_PATH` → `ConfigError`
  naming `GCP_SA_KEY_PATH`, reason `missing`; with the key file set → loads.
- `OCR_PROVIDER=bogus` → `malformed` naming `OCR_PROVIDER`.
- `OCR_LANGUAGE_HINTS`: `en,de,zh-Hans,en-t-i0-handwrit` → parsed verbatim (the
  handwriting form must pass validation); entry with spaces or digits-first → `malformed`;
  absent → `[]`.
- `OCR_CHANNEL_ALLOWLIST`: two 18-digit ids → parsed array; `abc` or `123` →
  `malformed`; explicit empty string → `malformed`; absent → `null`.
- Provider `none` + key file present → loads with recognition disabled (pre-staging case).
- Regression: the full 001 config test suite passes unchanged.

## Supersession notes

- **2026-09-25** (post-implementation analysis): with provider `none`, an empty
  `GCP_SA_KEY_PATH=` now yields `null` instead of `malformed`. This matches the code and
  the blank sample env file.
- **2026-09-29** (review): `ocrProvider` + `gcpSaKeyPath` folded into one discriminated
  union, `ocrProvider: { kind: 'gcp-vision'; keyFilePath } | { kind: 'none' }`, so the
  type itself enforces the cross-field rule and the composition root switches on `kind`
  exhaustively. A key path pre-staged under provider `none` is still accepted but no
  longer stored. Env vars and error behavior are unchanged.

# Quickstart Validation: Shopping List Photo OCR

**Feature**: `002-shopping-list-ocr` | **Date**: 2026-09-22

Runnable scenarios proving the feature works end to end. Automated tiers validate
everything except live Discord/Vision behavior; the manual smoke run covers those.
Prerequisites: repo cloned, `npm ci` run, Node ≥ 24.

---

## 1. Automated validation (no external accounts)

```bash
npm run typecheck   # tsc src + tsconfig.test.json (tests included)
npm run lint        # biome — incl. the new @google-cloud/vision import boundary
npm test            # vitest: unit + contract + integration
```

What each tier proves (details: `contracts/*.md` "Test obligations"):

| Tier | Proves |
|---|---|
| `tests/unit/` | line reconstruction fidelity (`lines.join('\n') === text`, per `contracts/google-vision.md`), per-line confidence/position math, gRPC error→taxonomy mapping, magic-byte sniffing, `splitReply` chunking/marker reconstruction, config parsing incl. the provider/key-file cross-field rule |
| `tests/contract/` | stub-provider swap (the full user-facing flow runs with zero external calls — SC-004), orchestrator evaluation order (local checks → busy → sequential all-or-nothing), busy guard, 25 s budget via the `now()` seam, adapter routing/allowlist/usage-hint, empty `allowedMentions` on every send |
| `tests/integration/` | end-to-end message-in → reply-out through the stubbed Discord client and stub provider: happy path, every failure class (SC-003), multi-image order, concurrent users (SC-006), >2000-char delivery in order (SC-007), and a post-run log scan asserting no recognized text, image bytes, or key material in logs (SC-005) |

Red-first rule (Constitution I): every contract's test obligations are written and shown
failing before the module is implemented.

## 2. Operator setup (manual, one-time)

1. Google Cloud: create a project, enable billing, enable the **Vision API**, create a
   service account, download its JSON key to the VPS (e.g.
   `/etc/empty-cart/gcv-key.json`, mode `0600`, owned by the service user).
2. Env (`.env` / systemd unit):
   ```bash
   DISCORD_TOKEN=…
   OCR_PROVIDER=google-vision
   OCR_GOOGLE_VISION_KEY_FILE=/etc/empty-cart/gcv-key.json
   # OCR_LANGUAGE_HINTS=en        # optional; omit for auto-detect
   # OCR_CHANNEL_ALLOWLIST=123456789012345678   # optional; omit = all channels
   ```
3. `npm run build && npm start` — a missing/unreadable key file fails at startup naming
   `OCR_GOOGLE_VISION_KEY_FILE` (boot-time validation, not first-photo-time).

## 3. Live smoke scenarios (manual, real Discord + real Vision)

Run each and compare against the expected outcome; all replies must arrive in the same
channel, and recognized text must match the photo's lines in order (SC-002).

| # | Action | Expected |
|---|---|---|
| 1 | Post a photo of a handwritten list | Recognized text reply within ~30 s (SC-001), lines in order, no pings rendered |
| 2 | Post a photo containing `@everyone` and a username mention | Text returned verbatim but renders as plain text (mention neutralization) |
| 3 | Post a blank/unreadable photo | "I couldn't read any text — can you try a different photo?" |
| 4 | Send a PDF (or GIF) as file | Unsupported-format message; logs show no provider call was made |
| 5 | Send an image > 7 MB (or renamed to exceed) | Too-large message; no provider call in logs |
| 6 | Send two list photos in ONE message | Both pages' text, in attachment order, in one reply flow |
| 7 | Send a photo, then immediately a second photo | Second gets the busy message; first completes normally |
| 8 | Have a second user post a photo in another channel during your submission | Both get their own text; neither sees the other's (SC-006) |
| 9 | Type plain text (no image) in a processed channel | Usage hint naming the `!help` command |
| 10 | `!echo hello` anywhere (incl. non-allowlisted channel) | Echo works; no usage hint added |
| 11 | Temporarily revoke the service account / disable the Vision API, send a photo | The generic "Service is not available…" message; logs carry the specific cause + correlation id; bot stays responsive |
| 12 | Long list producing > 2000 chars | Multiple messages in order; a mid-line cut shows the `…` continuation marker |
| 13 | `OCR_PROVIDER=disabled`, send a photo | Generic service-unavailable message — never silence |

Scenario 11 restores credentials afterwards. Scenario outcomes are cross-checked against
`journalctl -u empty-cart` — every submission shows received/submitted/succeeded|failed
with a correlation id and NO text/bytes (SC-005).

## 4. Deferred-work tracking (delivery gate, FR-023 / SC-009)

Before the feature is called done, confirm one GitHub issue exists for each deferred
item: `!help` command; context-aware/AI-powered guidance; duplicate-submission
de-duplication; direct-message handling; image-format conversion (HEIC→JPEG); operator
observability/monitoring (incl. unsupported-format counter).

## 5. VPS validation (Constitution workflow §7)

The feature is not "done" until scenarios 1–3 and 11 have been exercised against the real
systemd-supervised VPS deployment (`docs/deployment.md`), not only locally.

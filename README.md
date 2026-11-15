# Empty Cart

A Discord bot for shopping lists, run as a systemd service on a single VPS.

- Post a photo of a handwritten shopping list in a processed channel. The bot replies with the recognized text (Google Cloud Vision), grouped under category headings in shop-walk order (an LLM via LangChain picks each line's category; every line keeps its exact wording).
- If sorting fails or is off, the reply is the list as written. If recognition is off, the bot still answers every photo with a clear message.
- Each list's steps run as a LangGraph graph, traced to LangSmith and logged with one correlation id.
- Also: an `!echo` command, a loopback health endpoint, and graceful shutdown.

Recognition, sorting, and tracing are each switched on by configuration.

## Docs

- [`docs/deployment.md`](docs/deployment.md): install, external accounts, **every environment variable**, systemd, logs, upgrading.
- [`docs/DEV_NOTES.md`](docs/DEV_NOTES.md): design decisions not obvious from the code.
- [`AGENTS.md`](AGENTS.md) and [`.specify/memory/constitution.md`](.specify/memory/constitution.md): working rules.
- [`specs/`](specs/): per-feature specs and plans, kept as written at the time.

## Development

Requires Node.js 24 LTS.

```bash
npm ci                  # exact pinned dependencies
npm run dev             # tsx src/index.ts
npm run typecheck       # src + tests
npm test                # vitest: unit + contract + integration
npm run lint            # biome (incl. per-directory import boundaries)
npm run eval            # scores the real categorizer on sample lists; calls the model, costs money
```

Configuration comes only from environment variables ([`docs/deployment.md` §4](docs/deployment.md#4-environment-variables)); copy [`.env.example`](.env.example) to `.env` for local runs. `npm run dev` does not read `.env` by itself:

```bash
set -a; . ./.env; set +a; npm run dev
```

`npm run eval` loads `.env` on its own and needs `SORTING_MODEL` and `SORTING_API_KEY`; it skips otherwise. To record the run in LangSmith, use `LANGSMITH_TRACING=true npm run eval`. Keep `LANGSMITH_TRACING` out of `.env`: the bot would trace every run twice.

## Adding an OCR provider

The list flow depends only on the provider-agnostic `OcrProvider` contract in `src/ocr/types.ts`. A new provider takes three changes:

1. **A sibling module** (e.g. `src/ocr/<vendor>/provider.ts`, next to `src/ocr/google-vision/`) that implements `OcrProvider` and maps the vendor's responses and errors to the contract's result types (`ok` / `undecodable-image` / `unavailable` with a cause). If it uses a vendor SDK, add a `noRestrictedImports` boundary in `biome.json` so only that module can import it.
2. **A config enum value** for `OCR_PROVIDER` (in `src/config/schema.ts`, `src/config/load-config.ts`, and the `Config` type in `src/shared/types.ts`), plus any credentials it needs.
3. **One wiring branch** in the provider-selection block of `src/lifecycle/run-app.ts`.

Image detection (`src/image/`), list handling (`src/shopping-list/`), and reply posting (`src/discord/`) need no changes. `tests/contract/ocr-swap.spec.ts` enforces this: it checks that only the lifecycle wiring knows which provider is active.

Model providers for sorting work the same way: `ENDPOINT_OPTIONS` in `src/categorizer/agent-backed-categorizer.ts` lists the supported `SORTING_MODEL` prefixes.

# Contract — `health`

**Module path**: `src/health/`
**Depends on**: Node built-in `node:http` only
**Depended on by**: `lifecycle` (owns it)
**Spec refs**: FR-007, User Story 3 #1–#3, Edge Case gateway-down, SC-004

This module MUST NOT import `discord.js`. It reads only the shared `BotState` snapshot (data-model Entity 2).

## Public surface

```typescript
export type HealthStatus = { /* see data-model.md Entity 5 */ };

export interface HealthServer {
  stop(): Promise<void>;
  readonly address: string;                // `${config.healthHost}:${config.healthPort}`
}

export function startHealthServer(deps: {
  config: Pick<Config, 'healthHost' | 'healthPort'>;
  botState: BotState;
  logger: Logger;
}): HealthServer;

export function mapHealthStatus(state: BotState, now?: number): { httpStatus: number; body: HealthStatus };
```

## Behavioral contract

1. Binds a `node:http` server to `config.healthHost` (`127.0.0.1` default — **loopback only**) on `config.healthPort`. The bot has no knowledge of any reverse proxy; if the operator fronts the endpoint with Caddy (see `docs/deployment.md`), that is a deployment-time concern and does not change this contract or the code.
2. Routes exactly `GET /healthz`; any other path/method → `404` with `{ error: "not found" }`. `GET /healthz` MUST respond within 1 s (SC-004; trivially satisfied — no I/O).
3. The response body is `mapHealthStatus(botState)` JSON; the HTTP status code and `status` field follow the mapper in `data-model.md` Entity 5 (reproduced):

   | `phase` | `discord` | HTTP | `status` |
   |---|---|---|---|
   | `starting`/`running` | `connected` | 200 | `healthy` |
   | `starting`/`running` | `disconnected`/`reconnecting` | 200 | `degraded` |
   | `shutting-down` | any | 503 | `shutting-down` |
   | `stopped` | any | 503 | `unhealthy` |

4. **No side effects, no Discord round-trip** (FR-007): the handler only reads `botState` and serializes JSON.
5. **Shutdown transitions are reflected** (User Story 3 #3): the moment `lifecycle` flips `botState.phase` to `shutting-down`, the very next `/healthz` returns `503 shutting-down` — verified by an integration test that flips phase between requests.
6. `stop()` is bounded and safe to call during the shutdown budget: it calls `server.closeAllConnections()` (available on `http.Server` since Node 18.2; this module creates its server via `node:http`, so the instance is an `http.Server` — `net.Server` does NOT expose this method) to abort any in-flight `/healthz` request, then `server.close()` to stop accepting new connections. `stop()` resolves once the listening socket is closed; because `closeAllConnections()` is called first, no in-flight request can keep the socket past the shutdown budget (`server.close()` alone only stops new connections and leaves in-flight queries to drain naturally, which could exceed the 5 s SC-003 budget under a slow/stuck probe).
7. On bind failure (port in use / permission denied) `startHealthServer` MUST throw a single `Error` with the OS error code, so `lifecycle` can log exactly one `fatal` and exit non-zero (mirrors FR-003 discipline for the health subsystem).

## Test obligations

- Unit: every cell of the mapper table (2 × for connection states, ×2 for shutdown phases) → correct HTTP code + `status` string.
- Integration: spin the real http server against an in-process `BotState`; assert the full transition matrix `connected → disconnected → shutting-down → stopped` is observable over real HTTP within 1 s each; assert a second `/healthz` during `shutting-down` does NOT return `healthy` (User Story 3 #3 no-stale-healthy).
- A `404`/method-routing test for non-`/healthz` requests.
- A redaction/composition guarantee: response body contains only the documented fields (no env, no token, no `correlationId`).
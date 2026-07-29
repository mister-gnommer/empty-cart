// Health server — node:http on loopback, no Discord round-trip (FR-007).
// Implements contracts/health.md §3 (mapper) + §1-§7 (server lifecycle).
import { createServer, type Server } from 'node:http';
import type { Logger } from 'pino';
import type { BotState, HealthStatus } from '../shared/types';

const SHUTTING_DOWN_HTTP = 503;
const UNHEALTHY_HTTP = 503;
const OK_HTTP = 200;

export interface HealthServer {
  stop(): Promise<void>;
  readonly address: string;
}

/** Read-only mapper from BotState → { httpStatus, body }. No I/O. */
export function mapHealthStatus(
  state: BotState,
  now: number = Date.now(),
): { httpStatus: number; body: HealthStatus } {
  const { phase, discord, startedAt } = state;
  let status: HealthStatus['status'];
  let httpStatus: number;
  if (phase === 'shutting-down') {
    status = 'shutting-down';
    httpStatus = SHUTTING_DOWN_HTTP;
  } else if (phase === 'stopped') {
    status = 'unhealthy';
    httpStatus = UNHEALTHY_HTTP;
  } else if (discord === 'connected') {
    status = 'healthy';
    httpStatus = OK_HTTP;
  } else {
    // starting/running with disconnected/reconnecting → degraded
    status = 'degraded';
    httpStatus = OK_HTTP;
  }
  const body: HealthStatus = {
    status,
    phase,
    discord,
    uptimeMs: Math.max(0, now - startedAt),
    checkedAt: now,
  };
  return { httpStatus, body };
}

/** Bind a node:http server to config.healthHost:healthPort, routing GET /healthz. */
export function startHealthServer(deps: {
  config: { healthHost: string; healthPort: number };
  botState: BotState;
  logger: Logger;
}): HealthServer {
  const { config, botState, logger } = deps;
  const server: Server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      const { httpStatus, body } = mapHealthStatus(botState);
      res.writeHead(httpStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }
    // All other paths/methods → 404 `{ error: "not found" }`.
    // Per contracts/health.md §2, also non-GET methods map to 404 rather than
    // 405 (single-status contract: anything that's not GET /healthz is 404).
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  // Synchronous bind throws on EADDRINUSE / permission denied — propagate.
  server.listen(config.healthPort, config.healthHost);

  const address = `${config.healthHost}:${config.healthPort}`;
  logger.info({ msg: 'health server listening', address });

  return {
    address,
    async stop(): Promise<void> {
      // `closeAllConnections` (Node 18.2+) aborts in-flight requests so the
      // socket can drain within the shutdown budget immediately.
      const anyServer = server as unknown as {
        closeAllConnections?(): void;
        close(cb?: (err?: Error) => void): void;
      };
      if (typeof anyServer.closeAllConnections === 'function') {
        anyServer.closeAllConnections();
      }
      await new Promise<void>((resolve) => {
        anyServer.close((err) => {
          if (err) {
            const code = (err as Error & { code?: string }).code;
            if (code !== 'ERR_SERVER_NOT_RUNNING') {
              // best-effort: ignore other close errors during shutdown.
              resolve();
              return;
            }
            resolve();
            return;
          }
          resolve();
        });
      });
    },
  };
}
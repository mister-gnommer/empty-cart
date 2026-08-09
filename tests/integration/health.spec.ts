import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { type HealthServer, startHealthServer } from '../../src/health/server';
import type { BotState, ConnectionState, ProcessPhase } from '../../src/shared/types';

const HOST = '127.0.0.1';

// Each test gets a unique port to avoid overlapping with the previous test's
// server in TIME_WAIT / drain state. Deterministic base+offset scheme.
function uniquePort(): number {
  uniquePort.counter += 1;
  return uniquePort.counter;
}
uniquePort.counter = 18099;

function makeState(phase: ProcessPhase, discord: ConnectionState): BotState {
  const t = Date.now();
  return {
    phase,
    discord,
    startedAt: t - 100,
    lastStateChangeAt: t,
  };
}

describe('integration: /healthz over real node:http', () => {
  let servers: HealthServer[] = [];
  afterEach(async () => {
    for (const s of servers) {
      await s.stop();
    }
    servers = [];
  });

  async function startServer(botState: BotState): Promise<{ server: HealthServer; port: number }> {
    const port = uniquePort();
    const s = startHealthServer({
      config: { healthHost: HOST, healthPort: port },
      botState,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        fatal: () => undefined,
        debug: () => undefined,
        trace: () => undefined,
        child: () => ({}) as never,
      } as never,
    });
    servers.push(s);
    await new Promise((r) => setImmediate(r));
    return { server: s, port };
  }

  function get(port: number, path: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = request({ host: HOST, port, path, method: 'GET', timeout: 1000 }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body });
        });
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy(new Error('timeout'));
      });
      req.end();
    });
  }

  function requestMethod(
    port: number,
    path: string,
    method: 'GET' | 'POST',
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = request({ host: HOST, port, path, method, timeout: 1000 }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body });
        });
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.end();
    });
  }

  it('full transition matrix connected → disconnected → shutting-down → stopped', async () => {
    const botState = makeState('starting', 'disconnected');
    const { port } = await startServer(botState);

    botState.phase = 'running';
    botState.discord = 'connected';
    let r = await get(port, '/healthz');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).status).toBe('healthy');

    botState.discord = 'disconnected';
    r = await get(port, '/healthz');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).status).toBe('degraded');

    botState.phase = 'shutting-down';
    r = await get(port, '/healthz');
    expect(r.status).toBe(503);
    expect(JSON.parse(r.body).status).toBe('shutting-down');

    botState.phase = 'stopped';
    r = await get(port, '/healthz');
    expect(r.status).toBe(503);
    expect(JSON.parse(r.body).status).toBe('unhealthy');
  });

  it('a second /healthz during shutting-down returns 503 (no stale healthy)', async () => {
    const botState = makeState('running', 'connected');
    const { port } = await startServer(botState);
    botState.phase = 'shutting-down';
    const r1 = await get(port, '/healthz');
    const r2 = await get(port, '/healthz');
    expect(r1.status).toBe(503);
    expect(r2.status).toBe(503);
    expect(JSON.parse(r2.body).status).toBe('shutting-down');
  });

  it('non-/healthz path → 404 {"error":"not found"}', async () => {
    const botState = makeState('running', 'connected');
    const { port } = await startServer(botState);
    const r = await get(port, '/other');
    expect(r.status).toBe(404);
    expect(JSON.parse(r.body).error).toBe('not found');
  });

  it('non-GET method → 404', async () => {
    const botState = makeState('running', 'connected');
    const { port } = await startServer(botState);
    const r = await requestMethod(port, '/healthz', 'POST');
    expect(r.status).toBe(404);
  });

  it('response body contains ONLY documented fields (no env, no token, no correlationId)', async () => {
    const botState = makeState('running', 'connected');
    const { port } = await startServer(botState);
    const r = await get(port, '/healthz');
    const obj = JSON.parse(r.body);
    expect(Object.keys(obj).sort()).toEqual(
      ['checkedAt', 'discord', 'phase', 'status', 'uptimeMs'].sort(),
    );
    expect(JSON.stringify(obj)).not.toMatch(/discordToken|SECRET|env/i);
  });

  it('response within 1 s budget', async () => {
    const botState = makeState('running', 'connected');
    const { port } = await startServer(botState);
    const start = Date.now();
    await get(port, '/healthz');
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

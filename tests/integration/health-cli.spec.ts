import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const HOST = '127.0.0.1';
const BASE_PORT = 18090;

function startStubServer(
  status: number,
  body: unknown,
  captureCalls?: { path: string; method: string }[],
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      captureCalls?.push({ path: req.url ?? '', method: req.method ?? '' });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
    server.listen(0, HOST, () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, port: addr.port });
    });
  });
}

function runCli(env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    // Run the shipped CLI via tsx (the dev runner) so the test exercises the
    // real source, not a compiled artifact that may be stale.
    const child = spawn(
      'npx',
      ['tsx', 'src/health-cli.ts'],
      {
        env,
        cwd: process.cwd(),
        shell: process.platform === 'win32',
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

describe('integration: src/health-cli.ts (contracts/health.md + T023a)', () => {
  let servers: Server[] = [];
  beforeEach(() => { servers = []; });
  afterEach(async () => {
    for (const s of servers) {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  it('exit code 0 on a 200 response; stdout carries the response body verbatim', async () => {
    const body = { status: 'healthy', phase: 'running', discord: 'connected', uptimeMs: 5, checkedAt: 1 };
    const { server, port } = await startStubServer(200, body);
    servers.push(server);
    const r = await runCli({ ...process.env, HEALTH_HOST: HOST, HEALTH_PORT: String(port) });
    expect(r.exitCode).toBe(0);
    // stdout carries the response body verbatim.
    expect(r.stdout).toContain('healthy');
    expect(r.stdout).toContain('running');
  });

  it('exit code 1 on a 503 response', async () => {
    const body = { status: 'shutting-down', phase: 'shutting-down', discord: 'disconnected', uptimeMs: 1, checkedAt: 1 };
    const { server, port } = await startStubServer(503, body);
    servers.push(server);
    const r = await runCli({ ...process.env, HEALTH_HOST: HOST, HEALTH_PORT: String(port) });
    expect(r.exitCode).toBe(1);
  });

  it('exit code 1 on connection refused (server not running)', async () => {
    // Pick an unlikely-to-be-bound port so the connection fails fast.
    const r = await runCli({ ...process.env, HEALTH_HOST: HOST, HEALTH_PORT: '65500' });
    expect(r.exitCode).toBe(1);
  });

  it('issues GET requests only (no side effects, FR-007)', async () => {
    const calls: { path: string; method: string }[] = [];
    const { server, port } = await startStubServer(
      200,
      { status: 'healthy' },
      calls,
    );
    servers.push(server);
    await runCli({ ...process.env, HEALTH_HOST: HOST, HEALTH_PORT: String(port) });
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const c of calls) {
      expect(c.method).toBe('GET');
      expect(c.path).toBe('/healthz');
    }
  });
});
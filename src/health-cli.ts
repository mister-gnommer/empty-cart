// health-cli — optional operator convenience wrapper around the loopback
// /healthz endpoint (independent-test alternative to the Discord interface).
// HTTP-GETs http://$HEALTH_HOST:$HEALTH_PORT/healthz (env-driven,
// defaults 127.0.0.1:8081 when unset), prints the response body verbatim to
// stdout, exits 0 on a 2xx response and 1 on any non-2xx response or
// connection failure. GET-only; no writes — the /healthz endpoint is the only
// health surface and the CLI adds NO side effects.
import { get } from 'node:http';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : fallback;
}

const host =
  process.env.HEALTH_HOST && process.env.HEALTH_HOST.length > 0
    ? process.env.HEALTH_HOST
    : '127.0.0.1';
const port = envInt('HEALTH_PORT', 8081);

const req = get({ host, port, path: '/healthz', method: 'GET', timeout: 5000 }, (res) => {
  res.setEncoding('utf8');
  let body = '';
  res.on('data', (chunk: string) => {
    body += chunk;
  });
  res.on('end', () => {
    process.stdout.write(body);
    const status = res.statusCode ?? 0;
    if (status >= 200 && status < 300) {
      process.exit(0);
    } else {
      process.exit(1);
    }
  });
});

req.on('error', () => {
  process.exit(1);
});
req.on('timeout', () => {
  req.destroy(new Error('timeout'));
  process.exit(1);
});

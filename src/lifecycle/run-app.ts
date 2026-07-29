// runApp — composition root. Owns process-signal listeners and the shutdown
// budget. The only module that calls `process.exit`. Per contracts/lifecycle.md
// §1 startup order, §2 signal handling, §3 shutdown race, §4 no flush, §5 exit
// discipline.
import { loadConfig, ConfigError } from '../config/load-config';
import {
  createLogger,
  createBootstrapLogger,
  createEmergencyLogger,
} from '../logger/create-logger';
import { startHealthServer, type HealthServer } from '../health/server';
import { createDiscordAdapter } from '../discord/adapter';
import { handleEchoCommand } from '../echo/handle-echo';
import { newCorrelationId } from '../shared/correlation-id';
import type { BotState, ProcessPhase } from '../shared/types';

let shuttingDownInFlight = false;

export async function runApp(): Promise<void> {
  // §1.0 — bootstrap logger. If stdout is unavailable its constructor throws;
  // fall through to the emergency-logger path.
  let bootLog: ReturnType<typeof createBootstrapLogger>;
  try {
    bootLog = createBootstrapLogger(process.env);
  } catch {
    // stdout unavailable → emergency logger to stderr + exit 1.
    let emergencyLog;
    try {
      emergencyLog = createEmergencyLogger();
    } catch {
      // process.stderr is also unavailable — exit non-zero without logging
      // as the last resort (contracts/lifecycle.md §1 step 0 / spec Edge
      // Case "log destination unavailable").
      process.exit(1);
      return;
    }
    emergencyLog.fatal({ msg: 'startup failed', reason: 'stdout unavailable' });
    process.exit(1);
    return;
  }

  // §1.1 — config validation
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      bootLog.fatal({
        msg: 'config validation failed',
        env: e.envField,
        reason: e.reason,
      });
    } else {
      bootLog.fatal({
        msg: 'config validation failed',
        env: 'unknown',
        reason: 'malformed',
      });
    }
    process.exit(1);
    return;
  }

  // §1.2 — validated logger
  const log = createLogger(config);

  // §1.3 — botState
  const startedAt = Date.now();
  const botState: BotState = {
    phase: 'starting' as ProcessPhase,
    discord: 'disconnected',
    startedAt,
    lastStateChangeAt: startedAt,
  };

  // §2 signal handling scaffolding (installed before any awaited long-running
  // start step so early SIGTERM is handled).
  let healthStopPromise: Promise<void> | null = null;
  let adapterStopPromise: Promise<void> | null = null;

  // runApp stays pending until shutdown completes so a thrown `process.exit`
  // from the (detached) shutdown chain propagates as a rejection to the
  // entrypoint's `.catch`. In production `process.exit` terminates the
  // process before any rejection is observed; in tests a `process.exit`
  // spy-throws inside doShutdown → shutdownPromise rejects → runApp rejects.
  let shutdownReject!: (err: unknown) => void;
  const shutdownPromise = new Promise<never>((_resolve, reject) => {
    shutdownReject = reject;
  });
  // Pre-attach a noop catch so the rejection (raised later by doShutdown's
  // `process.exit` sync-throw path) always has at least one handler before
  // the rejection tick — prevents Node's "unhandled rejection" / "handled
  // asynchronously" churn when running under test process-exit spies. The
  // outer `await shutdownPromise` re-throws the same rejection so runApp
  // itself still rejects as intended.
  shutdownPromise.catch(() => {
    /* handler attached; rejection is observed by the await site too */
  });

  async function doShutdown(): Promise<void> {
    botState.phase = 'shutting-down';
    const stops: Promise<unknown>[] = [
      adapterStopPromise ?? Promise.resolve(),
      healthStopPromise ?? Promise.resolve(),
    ];
    const budget = config.shutdownTimeoutMs;
    const winner = await Promise.race([
      Promise.allSettled(stops).then(() => 'done' as const),
      new Promise<'timeout'>((resolve) => {
        const t = setTimeout(() => resolve('timeout'), budget);
        t.unref?.();
      }),
    ]);
    if (winner === 'timeout') {
      log.warn({ msg: 'shutdown budget exceeded', phase: botState.phase });
      process.exit(1);
    } else {
      log.info({ msg: 'shutdown complete', phase: botState.phase });
      process.exit(0);
    }
  }

  function requestShutdown(reason: string): void {
    if (shuttingDownInFlight) {
      const corrId = newCorrelationId();
      log.warn({
        msg: 'shutdown already in progress',
        correlationId: corrId,
      });
      return;
    }
    shuttingDownInFlight = true;
    log.info({ msg: 'shutdown requested', reason });
    // Detached — Node signal handlers must return synchronously; the
    // rejection path of doShutdown is piped into shutdownPromise so runApp's
    // outer promise observes any `process.exit`-spy throw.
    void doShutdown().catch((err) => {
      shutdownReject(err);
    });
  }

  process.on('SIGTERM', () => requestShutdown('SIGTERM'));
  process.on('SIGINT', () => requestShutdown('SIGINT'));

  // §1.4 — start health server (post-config; phase stays `starting`).
  let healthServer: HealthServer;
  try {
    healthServer = startHealthServer({
      config: { healthHost: config.healthHost, healthPort: config.healthPort },
      botState,
      logger: log,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.fatal({ msg: `health server failed to start: ${message}` });
    process.exit(1);
    return;
  }
  healthStopPromise = (async () => {
    await healthServer.stop();
  })();

  // §1.5 — discord adapter (only importer of discord.js)
  let adapter;
  try {
    adapter = createDiscordAdapter({
      config,
      logger: log,
      botState,
      echo: handleEchoCommand,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.fatal({ msg: `discord adapter failed to construct: ${message}` });
    process.exit(1);
    return;
  }
  adapterStopPromise = (async () => {
    await adapter.stop();
  })();

  try {
    await adapter.start();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.fatal({ msg: `discord adapter failed to start: ${message}` });
    process.exit(1);
    return;
  }

  // §1.6 — bot started (no secrets)
  log.info({
    msg: 'bot started',
    healthAddress: healthServer.address,
    prefix: config.commandPrefix,
    echoCommandName: config.echoCommandName,
  });

  // runApp stays pending until a signal triggers the shutdown chain. In
  // production `doShutdown` calls `process.exit` (terminating the process
  // before this promise can resolve/reject); in tests the `process.exit`
  // spy-throws, propagating the rejection through `shutdownPromise` so
  // callers observe the exit-via-rejection pattern.
  await shutdownPromise;
}
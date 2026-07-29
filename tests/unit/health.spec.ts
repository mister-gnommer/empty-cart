import { describe, it, expect } from 'vitest';
import { mapHealthStatus } from '../../src/health/server';
import type { BotState, ConnectionState, ProcessPhase } from '../../src/shared/types';

function makeState(
  phase: ProcessPhase,
  discord: ConnectionState,
  startedAt: number = 1_700_000_000_000,
  lastStateChangeAt: number = 1_700_000_000_000,
): BotState {
  return { phase, discord, startedAt, lastStateChangeAt };
}

describe('mapHealthStatus (contracts/health.md §3 mapper)', () => {
  describe('phase × discord → HTTP code + status (full table)', () => {
    for (const phase of ['starting', 'running'] as const) {
      it(`${phase} + connected → 200 healthy`, () => {
        const r = mapHealthStatus(makeState(phase, 'connected'), 1_700_000_005_000);
        expect(r.httpStatus).toBe(200);
        expect(r.body.status).toBe('healthy');
      });
      it(`${phase} + disconnected → 200 degraded`, () => {
        const r = mapHealthStatus(makeState(phase, 'disconnected'), 1_700_000_005_000);
        expect(r.httpStatus).toBe(200);
        expect(r.body.status).toBe('degraded');
      });
      it(`${phase} + reconnecting → 200 degraded`, () => {
        const r = mapHealthStatus(makeState(phase, 'reconnecting'), 1_700_000_005_000);
        expect(r.httpStatus).toBe(200);
        expect(r.body.status).toBe('degraded');
      });
    }
    for (const discord of ['connected', 'disconnected', 'reconnecting', 'destroyed'] as const) {
      it(`shutting-down + ${discord} → 503 shutting-down (no stale healthy)`, () => {
        const r = mapHealthStatus(
          makeState('shutting-down', discord),
          1_700_000_005_000,
        );
        expect(r.httpStatus).toBe(503);
        expect(r.body.status).toBe('shutting-down');
      });
      it(`stopped + ${discord} → 503 unhealthy`, () => {
        const r = mapHealthStatus(makeState('stopped', discord), 1_700_000_005_000);
        expect(r.httpStatus).toBe(503);
        expect(r.body.status).toBe('unhealthy');
      });
    }
  });

  describe('uptimeMs = checkedAt - startedAt', () => {
    it('computes uptime from startedAt to now', () => {
      const state = makeState('running', 'connected', 1_000);
      const r = mapHealthStatus(state, 3_000);
      expect(r.body.uptimeMs).toBe(2_000);
    });
    it('never returns a negative uptime even if checkedAt is below startedAt', () => {
      const state = makeState('running', 'connected', 5_000);
      const r = mapHealthStatus(state, 1_000);
      expect(r.body.uptimeMs).toBe(0);
    });
    it('honours the optional `now` argument', () => {
      const state = makeState('running', 'connected', 0);
      expect(mapHealthStatus(state, 100).body.uptimeMs).toBe(100);
    });
    it('defaults `now` to Date.now() when omitted', () => {
      const state = makeState('running', 'connected', Date.now() - 50);
      const r = mapHealthStatus(state);
      expect(r.body.uptimeMs).toBeGreaterThanOrEqual(50);
    });
  });

  describe('no I/O performed', () => {
    it('mapper produces body containing only documented fields', () => {
      const r = mapHealthStatus(makeState('running', 'connected'), 1);
      expect(Object.keys(r.body).sort()).toEqual(
        ['checkedAt', 'discord', 'phase', 'status', 'uptimeMs'].sort(),
      );
    });
  });
});
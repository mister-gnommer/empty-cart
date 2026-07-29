import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from '../../src/config/load-config';

const VALID: NodeJS.ProcessEnv = {
  DISCORD_TOKEN: 'tok',
  LOG_LEVEL: 'info',
  COMMAND_PREFIX: '!',
  ECHO_COMMAND_NAME: 'echo',
  ECHO_MAX_LENGTH: '1900',
  SHUTDOWN_TIMEOUT_MS: '5000',
  HEALTH_HOST: '127.0.0.1',
  HEALTH_PORT: '8081',
};

function expectError(env: NodeJS.ProcessEnv, envField: string, reason: 'missing' | 'malformed'): void {
  let caught: ConfigError | undefined;
  try {
    loadConfig(env);
  } catch (e) {
    caught = e as ConfigError;
  }
  expect(caught, `expected ConfigError for ${envField}/${reason}`).toBeInstanceOf(ConfigError);
  expect(caught!.envField).toBe(envField);
  expect(caught!.reason).toBe(reason);
  // Message must NEVER contain any value (contracts/config.md §2).
  expect(caught!.message).not.toContain('tok');
  expect(caught!.message).not.toContain('5000');
}

describe('loadConfig (contracts/config.md)', () => {
  describe('golden path', () => {
    it('returns a frozen Config with inferred shape and defaults applied', () => {
      const cfg = loadConfig({ DISCORD_TOKEN: 'tok' });
      expect(cfg).toEqual({
        discordToken: 'tok',
        logLevel: 'info',
        commandPrefix: '!',
        echoCommandName: 'echo',
        echoMaxLength: 1900,
        shutdownTimeoutMs: 5000,
        healthHost: '127.0.0.1',
        healthPort: 8081,
      });
      expect(Object.isFrozen(cfg)).toBe(true);
      expect(Object.isFrozen(Object.getOwnPropertyDescriptor as unknown)).toBe(false);
    });

    it('honours all env overrides', () => {
      const cfg = loadConfig({
        ...VALID,
        LOG_LEVEL: 'trace',
        COMMAND_PREFIX: '?',
        ECHO_COMMAND_NAME: 'say',
        ECHO_MAX_LENGTH: '100',
        SHUTDOWN_TIMEOUT_MS: '12000',
        HEALTH_HOST: '10.0.0.1',
        HEALTH_PORT: '9000',
      });
      expect(cfg).toMatchObject({
        logLevel: 'trace',
        commandPrefix: '?',
        echoCommandName: 'say',
        echoMaxLength: 100,
        shutdownTimeoutMs: 12000,
        healthHost: '10.0.0.1',
        healthPort: 9000,
      });
      expect(Object.isFrozen(cfg)).toBe(true);
    });
  });

  describe('DISCORD_TOKEN', () => {
    it('missing → ConfigError missing', () => {
      const env: NodeJS.ProcessEnv = { ...VALID };
      delete env.DISCORD_TOKEN;
      expectError(env, 'DISCORD_TOKEN', 'missing');
    });
    it('empty string → ConfigError missing (treated as missing per FR-003 wording)', () => {
      expectError({ ...VALID, DISCORD_TOKEN: '' }, 'DISCORD_TOKEN', 'missing');
    });
  });

  describe('LOG_LEVEL', () => {
    it('malformed: unknown level → malformed', () => {
      expectError({ ...VALID, LOG_LEVEL: 'verbose' }, 'LOG_LEVEL', 'malformed');
    });
  });

  describe('COMMAND_PREFIX', () => {
    it('malformed: 5 chars → malformed', () => {
      expectError({ ...VALID, COMMAND_PREFIX: 'abcde' }, 'COMMAND_PREFIX', 'malformed');
    });
    it('malformed: contains whitespace → malformed', () => {
      expectError({ ...VALID, COMMAND_PREFIX: 'a b' }, 'COMMAND_PREFIX', 'malformed');
    });
  });

  describe('ECHO_COMMAND_NAME', () => {
    it('malformed: uppercase → malformed', () => {
      expectError({ ...VALID, ECHO_COMMAND_NAME: 'Echo' }, 'ECHO_COMMAND_NAME', 'malformed');
    });
    it('malformed: empty (non-default override) → malformed', () => {
      expectError({ ...VALID, ECHO_COMMAND_NAME: '' }, 'ECHO_COMMAND_NAME', 'malformed');
    });
  });

  describe('ECHO_MAX_LENGTH', () => {
    it('malformed: non-integer → malformed', () => {
      expectError({ ...VALID, ECHO_MAX_LENGTH: 'abc' }, 'ECHO_MAX_LENGTH', 'malformed');
    });
    it('malformed: 0 (below 1) → malformed', () => {
      expectError({ ...VALID, ECHO_MAX_LENGTH: '0' }, 'ECHO_MAX_LENGTH', 'malformed');
    });
    it('malformed: 1901 (above 1900) → malformed', () => {
      expectError({ ...VALID, ECHO_MAX_LENGTH: '1901' }, 'ECHO_MAX_LENGTH', 'malformed');
    });
  });

  describe('SHUTDOWN_TIMEOUT_MS', () => {
    it('malformed: 500 (below 1000) → malformed', () => {
      expectError({ ...VALID, SHUTDOWN_TIMEOUT_MS: '500' }, 'SHUTDOWN_TIMEOUT_MS', 'malformed');
    });
    it('malformed: 31000 (above 30000) → malformed', () => {
      expectError({ ...VALID, SHUTDOWN_TIMEOUT_MS: '31000' }, 'SHUTDOWN_TIMEOUT_MS', 'malformed');
    });
    it('malformed: non-numeric → malformed', () => {
      expectError({ ...VALID, SHUTDOWN_TIMEOUT_MS: '5s' }, 'SHUTDOWN_TIMEOUT_MS', 'malformed');
    });
  });

  describe('HEALTH_HOST', () => {
    it('malformed: hostname not an IPv4 literal → malformed', () => {
      expectError({ ...VALID, HEALTH_HOST: 'localhost' }, 'HEALTH_HOST', 'malformed');
    });
    it('malformed: IPv6 `::1` is rejected (v1 IPv4-only range) → malformed', () => {
      expectError({ ...VALID, HEALTH_HOST: '::1' }, 'HEALTH_HOST', 'malformed');
    });
    it('malformed: 999.999.999.999 → malformed', () => {
      expectError({ ...VALID, HEALTH_HOST: '999.999.999.999' }, 'HEALTH_HOST', 'malformed');
    });
  });

  describe('HEALTH_PORT', () => {
    it('malformed: 0 (below 1) → malformed', () => {
      expectError({ ...VALID, HEALTH_PORT: '0' }, 'HEALTH_PORT', 'malformed');
    });
    it('malformed: 65536 (above 65535) → malformed', () => {
      expectError({ ...VALID, HEALTH_PORT: '65536' }, 'HEALTH_PORT', 'malformed');
    });
    it('malformed: non-numeric → malformed', () => {
      expectError({ ...VALID, HEALTH_PORT: 'abc' }, 'HEALTH_PORT', 'malformed');
    });
  });

  describe('first-invalid-field ordering', () => {
    it('reports the first invalid field in documented order', () => {
      // Both DISCORD_TOKEN (missing) and HEALTH_PORT (malformed) — the loader
      // MUST report DISCORD_TOKEN first per documented field order.
      const env: NodeJS.ProcessEnv = { ...VALID, HEALTH_PORT: '0' };
      delete env.DISCORD_TOKEN;
      expectError(env, 'DISCORD_TOKEN', 'missing');
    });
  });
});
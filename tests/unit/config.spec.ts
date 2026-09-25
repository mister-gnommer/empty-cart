import assert from 'node:assert/strict';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config/load-config';
import type { Config } from '../../src/shared/types';

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

const DEFAULT_CONFIG: Config = {
  discordToken: 'tok',
  logLevel: 'info',
  commandPrefix: '!',
  echoCommandName: 'echo',
  echoMaxLength: 1900,
  shutdownTimeoutMs: 5000,
  healthHost: '127.0.0.1',
  healthPort: 8081,
  ocrProvider: 'none',
  gcpSaKeyPath: null,
  ocrLanguageHints: [],
  ocrChannelAllowlist: null,
};

function expectError(
  env: NodeJS.ProcessEnv,
  envField: string,
  reason: 'missing' | 'malformed',
): void {
  let caught: ConfigError | undefined;
  try {
    loadConfig(env);
  } catch (e) {
    if (e instanceof ConfigError) {
      caught = e;
    }
  }
  assert.ok(caught instanceof ConfigError, `expected ConfigError for ${envField}/${reason}`);
  expect(caught.envField).toBe(envField);
  expect(caught.reason).toBe(reason);
  // Message must NEVER contain any value — it carries only the field name
  // and reason class, never the offending value.
  expect(caught.message).not.toContain(VALID.DISCORD_TOKEN);
  expect(caught.message).not.toContain(VALID.SHUTDOWN_TIMEOUT_MS);
}

describe('loadConfig', () => {
  describe('golden path', () => {
    it('returns a frozen Config with inferred shape and defaults applied', () => {
      const cfg = loadConfig({ DISCORD_TOKEN: DEFAULT_CONFIG.discordToken });
      expect(cfg).toEqual(DEFAULT_CONFIG);
      expect(Object.isFrozen(cfg)).toBe(true);
      expect(Object.isFrozen(Object.getOwnPropertyDescriptor)).toBe(false);
    });

    it('honours all env overrides', () => {
      const envOverrides = {
        LOG_LEVEL: 'trace',
        COMMAND_PREFIX: '?',
        ECHO_COMMAND_NAME: 'say',
        ECHO_MAX_LENGTH: '100',
        SHUTDOWN_TIMEOUT_MS: '12000',
        HEALTH_HOST: '10.0.0.1',
        HEALTH_PORT: '9000',
      };

      const cfg = loadConfig({ ...VALID, ...envOverrides });
      expect(cfg).toMatchObject({
        logLevel: envOverrides.LOG_LEVEL,
        commandPrefix: envOverrides.COMMAND_PREFIX,
        echoCommandName: envOverrides.ECHO_COMMAND_NAME,
        echoMaxLength: Number(envOverrides.ECHO_MAX_LENGTH),
        shutdownTimeoutMs: Number(envOverrides.SHUTDOWN_TIMEOUT_MS),
        healthHost: envOverrides.HEALTH_HOST,
        healthPort: Number(envOverrides.HEALTH_PORT),
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
    it('empty string → ConfigError missing (blank value classified as missing)', () => {
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

  describe('OCR defaults', () => {
    it('env with only DISCORD_TOKEN → recognition disabled, no key path, no hints, no allowlist', () => {
      const cfg = loadConfig({ DISCORD_TOKEN: DEFAULT_CONFIG.discordToken });
      expect(cfg.ocrProvider).toBe('none');
      expect(cfg.gcpSaKeyPath).toBeNull();
      expect(cfg.ocrLanguageHints).toEqual([]);
      expect(cfg.ocrChannelAllowlist).toBeNull();
    });
  });

  describe('OCR_PROVIDER', () => {
    it('gcp-vision without a key path → ConfigError missing GCP_SA_KEY_PATH', () => {
      expectError({ ...VALID, OCR_PROVIDER: 'gcp-vision' }, 'GCP_SA_KEY_PATH', 'missing');
    });
    it('gcp-vision with a key path → loads', () => {
      const cfg = loadConfig({
        ...VALID,
        OCR_PROVIDER: 'gcp-vision',
        GCP_SA_KEY_PATH: '/etc/empty-cart/gcv-key.json',
      });
      expect(cfg.ocrProvider).toBe('gcp-vision');
      expect(cfg.gcpSaKeyPath).toBe('/etc/empty-cart/gcv-key.json');
    });
    it('malformed: unknown value → malformed', () => {
      expectError({ ...VALID, OCR_PROVIDER: 'bogus' }, 'OCR_PROVIDER', 'malformed');
    });
    it('explicit none → loads as none', () => {
      expect(loadConfig({ ...VALID, OCR_PROVIDER: 'none' }).ocrProvider).toBe('none');
    });
    it('empty value behaves as the default none (the sample env file ships it blank)', () => {
      expect(loadConfig({ ...VALID, OCR_PROVIDER: '' }).ocrProvider).toBe('none');
    });
  });

  describe('GCP_SA_KEY_PATH', () => {
    it('gcp-vision with an empty key path → ConfigError missing', () => {
      expectError(
        { ...VALID, OCR_PROVIDER: 'gcp-vision', GCP_SA_KEY_PATH: '' },
        'GCP_SA_KEY_PATH',
        'missing',
      );
    });
    it('provider none + key path present → loads and stores the path (operator pre-staging)', () => {
      const cfg = loadConfig({ ...VALID, GCP_SA_KEY_PATH: '/etc/empty-cart/gcv-key.json' });
      expect(cfg.ocrProvider).toBe('none');
      expect(cfg.gcpSaKeyPath).toBe('/etc/empty-cart/gcv-key.json');
    });
    it('provider none + key path absent → null', () => {
      expect(loadConfig({ ...VALID }).gcpSaKeyPath).toBeNull();
    });
  });

  describe('OCR_LANGUAGE_HINTS', () => {
    it('comma-separated loose BCP-47 tags → parsed verbatim, including the handwriting form', () => {
      const cfg = loadConfig({
        ...VALID,
        OCR_LANGUAGE_HINTS: 'en,de,zh-Hans,en-t-i0-handwrit',
      });
      expect(cfg.ocrLanguageHints).toEqual(['en', 'de', 'zh-Hans', 'en-t-i0-handwrit']);
    });
    it('malformed: entry containing a space → malformed', () => {
      expectError({ ...VALID, OCR_LANGUAGE_HINTS: 'en, de' }, 'OCR_LANGUAGE_HINTS', 'malformed');
    });
    it('malformed: entry starting with a digit → malformed', () => {
      expectError({ ...VALID, OCR_LANGUAGE_HINTS: '1en' }, 'OCR_LANGUAGE_HINTS', 'malformed');
    });
    it('absent → empty list (provider auto-detects)', () => {
      expect(loadConfig({ ...VALID }).ocrLanguageHints).toEqual([]);
    });
  });

  describe('OCR_CHANNEL_ALLOWLIST', () => {
    it('two 18-digit channel ids → parsed array', () => {
      const cfg = loadConfig({
        ...VALID,
        OCR_CHANNEL_ALLOWLIST: '123456789012345678,987654321098765432',
      });
      expect(cfg.ocrChannelAllowlist).toEqual(['123456789012345678', '987654321098765432']);
    });
    it('malformed: non-numeric entry → malformed', () => {
      expectError({ ...VALID, OCR_CHANNEL_ALLOWLIST: 'abc' }, 'OCR_CHANNEL_ALLOWLIST', 'malformed');
    });
    it('malformed: too-short entry → malformed', () => {
      expectError({ ...VALID, OCR_CHANNEL_ALLOWLIST: '123' }, 'OCR_CHANNEL_ALLOWLIST', 'malformed');
    });
    it('malformed: explicit empty value (would silently disable recognition everywhere)', () => {
      expectError({ ...VALID, OCR_CHANNEL_ALLOWLIST: '' }, 'OCR_CHANNEL_ALLOWLIST', 'malformed');
    });
    it('absent → null (every visible channel is processed)', () => {
      expect(loadConfig({ ...VALID }).ocrChannelAllowlist).toBeNull();
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
    it('validates the 001 fields before the OCR fields', () => {
      expectError(
        { ...VALID, HEALTH_PORT: '0', OCR_PROVIDER: 'bogus' },
        'HEALTH_PORT',
        'malformed',
      );
    });
    it('validates OCR_PROVIDER before the cross-field GCP_SA_KEY_PATH rule', () => {
      expectError(
        { ...VALID, OCR_PROVIDER: 'bogus', GCP_SA_KEY_PATH: '' },
        'OCR_PROVIDER',
        'malformed',
      );
    });
    it('validates GCP_SA_KEY_PATH before OCR_LANGUAGE_HINTS', () => {
      expectError(
        { ...VALID, OCR_PROVIDER: 'gcp-vision', OCR_LANGUAGE_HINTS: '1bad' },
        'GCP_SA_KEY_PATH',
        'missing',
      );
    });
    it('validates OCR_LANGUAGE_HINTS before OCR_CHANNEL_ALLOWLIST', () => {
      expectError(
        { ...VALID, OCR_LANGUAGE_HINTS: '1bad', OCR_CHANNEL_ALLOWLIST: 'abc' },
        'OCR_LANGUAGE_HINTS',
        'malformed',
      );
    });
  });
});

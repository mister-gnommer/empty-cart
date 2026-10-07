import type { Config } from '../../src/shared/types';

// One valid Config for suites that need a config but don't exercise loading
// it; adding a Config field means updating only this fixture.
const TEST_CONFIG: Config = {
  discordToken: 'tok',
  logLevel: 'info',
  commandPrefix: '!',
  echoCommandName: 'echo',
  echoMaxLength: 1900,
  shutdownTimeoutMs: 5000,
  healthHost: '127.0.0.1',
  healthPort: 8081,
  ocrProvider: { kind: 'none' },
  ocrLanguageHints: [],
  ocrChannelAllowlist: null,
};

/**
 * Builds a valid test config, with recognition disabled and every channel processed by default.
 * @param overrides fields the suite cares about
 */
export function makeConfig(overrides: Partial<Config> = {}): Config {
  return { ...TEST_CONFIG, ...overrides };
}

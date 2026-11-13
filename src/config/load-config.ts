// loadConfig — pure validator. Throws ConfigError on first invalid env field.
// Does NOT log (the composition root owns the fatal
// log line). The returned Config is frozen.
import type { Config, OcrProviderConfig, SortingConfig, TracingConfig } from '../shared/types';
import {
  CHANNEL_SNOWFLAKE_PATTERN,
  configSchema,
  LANGUAGE_HINT_PATTERN,
  MODEL_STRING_PATTERN,
} from './schema';

const FIELD_ORDER = [
  'discordToken',
  'logLevel',
  'commandPrefix',
  'echoCommandName',
  'echoMaxLength',
  'shutdownTimeoutMs',
  'healthHost',
  'healthPort',
  'ocrProvider',
  'gcpSaKeyPath',
  'ocrLanguageHints',
  'ocrChannelAllowlist',
] as const;

const ENV_NAME: Record<(typeof FIELD_ORDER)[number], string> = {
  discordToken: 'DISCORD_TOKEN',
  logLevel: 'LOG_LEVEL',
  commandPrefix: 'COMMAND_PREFIX',
  echoCommandName: 'ECHO_COMMAND_NAME',
  echoMaxLength: 'ECHO_MAX_LENGTH',
  shutdownTimeoutMs: 'SHUTDOWN_TIMEOUT_MS',
  healthHost: 'HEALTH_HOST',
  healthPort: 'HEALTH_PORT',
  ocrProvider: 'OCR_PROVIDER',
  gcpSaKeyPath: 'GCP_SA_KEY_PATH',
  ocrLanguageHints: 'OCR_LANGUAGE_HINTS',
  ocrChannelAllowlist: 'OCR_CHANNEL_ALLOWLIST',
};

// OCR fields where an explicitly-empty env value behaves as absent (the
// documented default applies) — the sample env file ships them blank, so
// blank must not break boot. GCP_SA_KEY_PATH has its own cross-field empty
// handling; an empty OCR_CHANNEL_ALLOWLIST stays malformed on purpose (an
// empty allowlist would silently disable recognition everywhere).
const EMPTY_EQUALS_ABSENT: ReadonlySet<(typeof FIELD_ORDER)[number]> = new Set([
  'ocrProvider',
  'ocrLanguageHints',
]);

export class ConfigError extends Error {
  readonly envField: string;
  readonly reason: 'missing' | 'malformed';

  constructor(args: {
    envField: string;
    reason: 'missing' | 'malformed';
  }) {
    // Message intentionally omits any value.
    super(`ConfigError: ${args.envField} ${args.reason}`);
    this.name = 'ConfigError';
    this.envField = args.envField;
    this.reason = args.reason;
  }
}

function isAbsent(v: unknown): v is undefined | null {
  // A truly absent env var is `undefined`; an explicitly-empty-string env var
  // is PRESENT and treated as malformed for fields requiring a non-empty
  // value, EXCEPT discordToken which classifies empty as 'missing' (the
  // operator leaving `DISCORD_TOKEN=` blank in the env file).
  return v === undefined || v === null;
}

function parseNumberInt(v: string): number | undefined {
  if (!/^-?\d+$/u.test(v.trim())) return undefined;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : undefined;
}

function isRequiredField(field: (typeof FIELD_ORDER)[number]): boolean {
  return !configSchema.shape[field].safeParse(undefined).success;
}

// Validate each field in documented order, returning the first error encountered
// classified as `missing` or `malformed`, or the assembled Config on success.
// `partial` carries the values validated so far, enabling cross-field rules
// (e.g. the key-path requirement depends on the already-parsed provider).
function validateField(
  field: (typeof FIELD_ORDER)[number],
  raw: unknown,
  partial: Record<string, unknown>,
): { value: unknown } | { error: ConfigError } {
  const required = isRequiredField(field);
  const envName = ENV_NAME[field];

  if (field === 'gcpSaKeyPath') {
    // Cross-field rule: required if the gcp-vision provider is selected,
    // evaluated at this field's position so the first error stays deterministic.
    // With the provider disabled, any value is accepted and then dropped when
    // the provider config is assembled (operator pre-staging must not break boot).
    const provider = partial.ocrProvider ?? 'none';
    if (isAbsent(raw) || raw === '') {
      if (provider === 'gcp-vision') {
        return { error: new ConfigError({ envField: envName, reason: 'missing' }) };
      }
      return { value: undefined };
    }
    if (typeof raw !== 'string') {
      return { error: new ConfigError({ envField: envName, reason: 'malformed' }) };
    }
    return { value: raw };
  }

  if (isAbsent(raw) || (raw === '' && EMPTY_EQUALS_ABSENT.has(field))) {
    if (required) {
      return { error: new ConfigError({ envField: envName, reason: 'missing' }) };
    }
    // Optional field truly absent (or blank where blank means absent) → zod default.
    return { value: undefined };
  }

  if (raw === '') {
    if (required) {
      // `DISCORD_TOKEN=` left blank in the env file → 'missing' (matches
      // the operator intent behind the 'missing' classification).
      return { error: new ConfigError({ envField: envName, reason: 'missing' }) };
    }
    // Optional field explicitly set to '' — for fields requiring non-empty
    // (echoCommandName) or numeric (echoMaxLength, shutdownTimeoutMs,
    // healthPort) or IPv4 (healthHost), an empty string is malformed.
    return { error: new ConfigError({ envField: envName, reason: 'malformed' }) };
  }

  // Field is present. Validate type/shape; classify a failure as `malformed`.
  switch (field) {
    case 'discordToken': {
      if (typeof raw !== 'string' || raw.length === 0) {
        return {
          error: new ConfigError({ envField: envName, reason: 'malformed' }),
        };
      }
      return { value: raw };
    }
    case 'logLevel': {
      const ok = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(raw as string);
      return ok
        ? { value: raw }
        : { error: new ConfigError({ envField: envName, reason: 'malformed' }) };
    }
    case 'commandPrefix': {
      if (typeof raw !== 'string') {
        return {
          error: new ConfigError({ envField: envName, reason: 'malformed' }),
        };
      }
      const ok = raw.length >= 1 && raw.length <= 4 && !/\s/u.test(raw);
      return ok
        ? { value: raw }
        : { error: new ConfigError({ envField: envName, reason: 'malformed' }) };
    }
    case 'echoCommandName': {
      if (typeof raw !== 'string' || raw.length === 0) {
        return {
          error: new ConfigError({ envField: envName, reason: 'malformed' }),
        };
      }
      const ok = (raw as string) === (raw as string).toLowerCase();
      return ok
        ? { value: raw }
        : { error: new ConfigError({ envField: envName, reason: 'malformed' }) };
    }
    case 'echoMaxLength': {
      if (typeof raw !== 'string') {
        return {
          error: new ConfigError({ envField: envName, reason: 'malformed' }),
        };
      }
      const n = parseNumberInt(raw);
      if (n === undefined) {
        return {
          error: new ConfigError({ envField: envName, reason: 'malformed' }),
        };
      }
      const ok = n >= 1 && n <= 1900;
      return ok
        ? { value: n }
        : { error: new ConfigError({ envField: envName, reason: 'malformed' }) };
    }
    case 'shutdownTimeoutMs': {
      if (typeof raw !== 'string') {
        return {
          error: new ConfigError({ envField: envName, reason: 'malformed' }),
        };
      }
      const n = parseNumberInt(raw);
      if (n === undefined) {
        return {
          error: new ConfigError({ envField: envName, reason: 'malformed' }),
        };
      }
      const ok = n >= 1000 && n <= 30000;
      return ok
        ? { value: n }
        : { error: new ConfigError({ envField: envName, reason: 'malformed' }) };
    }
    case 'healthHost': {
      if (typeof raw !== 'string') {
        return {
          error: new ConfigError({ envField: envName, reason: 'malformed' }),
        };
      }
      const ok = /^(25[0-5]|2[0-4]\d|1?\d{1,2})(\.(25[0-5]|2[0-4]\d|1?\d{1,2})){3}$/u.test(raw);
      return ok
        ? { value: raw }
        : { error: new ConfigError({ envField: envName, reason: 'malformed' }) };
    }
    case 'healthPort': {
      if (typeof raw !== 'string') {
        return {
          error: new ConfigError({ envField: envName, reason: 'malformed' }),
        };
      }
      const n = parseNumberInt(raw);
      if (n === undefined) {
        return {
          error: new ConfigError({ envField: envName, reason: 'malformed' }),
        };
      }
      const ok = n >= 1 && n <= 65535;
      return ok
        ? { value: n }
        : { error: new ConfigError({ envField: envName, reason: 'malformed' }) };
    }
    case 'ocrProvider': {
      if (typeof raw !== 'string') {
        return {
          error: new ConfigError({ envField: envName, reason: 'malformed' }),
        };
      }
      const ok = raw === 'gcp-vision' || raw === 'none';
      return ok
        ? { value: raw }
        : { error: new ConfigError({ envField: envName, reason: 'malformed' }) };
    }
    case 'ocrLanguageHints': {
      if (typeof raw !== 'string') {
        return {
          error: new ConfigError({ envField: envName, reason: 'malformed' }),
        };
      }
      // Comma-separated loose BCP-47 tags; empty entries carry no hint and are
      // skipped, every non-empty entry must match. No trimming — an entry with
      // surrounding whitespace is operator error and stays malformed.
      const hints = raw.split(',').filter((entry) => entry.length > 0);
      const ok = hints.every((entry) => LANGUAGE_HINT_PATTERN.test(entry));
      return ok
        ? { value: hints }
        : { error: new ConfigError({ envField: envName, reason: 'malformed' }) };
    }
    case 'ocrChannelAllowlist': {
      if (typeof raw !== 'string') {
        return {
          error: new ConfigError({ envField: envName, reason: 'malformed' }),
        };
      }
      const ids = raw.split(',');
      const ok = ids.every((entry) => CHANNEL_SNOWFLAKE_PATTERN.test(entry));
      return ok
        ? { value: ids }
        : { error: new ConfigError({ envField: envName, reason: 'malformed' }) };
    }
  }
}

/**
 * Folds the flat, env-shaped provider fields into the provider-specific config,
 * so consumers get the key path only where the provider needs it.
 * @param provider the validated OCR_PROVIDER value
 * @param keyFilePath the validated GCP_SA_KEY_PATH value, null when unset
 */
function toOcrProviderConfig(
  provider: 'gcp-vision' | 'none',
  keyFilePath: string | null,
): OcrProviderConfig {
  if (provider === 'none') {
    return Object.freeze({ kind: 'none' });
  }
  if (keyFilePath === null) {
    // Unreachable: the cross-field rule in validateField rejects this earlier.
    throw new ConfigError({ envField: ENV_NAME.gcpSaKeyPath, reason: 'missing' });
  }
  return Object.freeze({ kind: 'gcp-vision', keyFilePath });
}

const DEFAULT_LANGSMITH_PROJECT = 'empty-cart';

/**
 * Treats an empty env value like an absent one, as the sample env file ships
 * optional fields blank.
 * @param raw the env value
 */
function presentValue(raw: string | undefined): string | undefined {
  return raw === undefined || raw === '' ? undefined : raw;
}

/**
 * Reads the AI sorting fields in documented order. The key and base URL are
 * only read when sorting is on, so a pre-staged key never breaks boot.
 * @param env the process environment
 */
function loadSorting(env: NodeJS.ProcessEnv): SortingConfig {
  const model = presentValue(env.SORTING_MODEL);
  if (model === undefined) {
    return Object.freeze({ kind: 'none' });
  }
  if (!MODEL_STRING_PATTERN.test(model)) {
    throw new ConfigError({ envField: 'SORTING_MODEL', reason: 'malformed' });
  }
  const apiKey = presentValue(env.SORTING_API_KEY);
  if (apiKey === undefined) {
    throw new ConfigError({ envField: 'SORTING_API_KEY', reason: 'missing' });
  }
  const baseUrl = presentValue(env.SORTING_BASE_URL) ?? null;
  // Whitespace or `#` means a trailing env-file comment that systemd kept in the
  // value; URL.parse would accept it as a path and fragment.
  if (baseUrl !== null && (/[\s#]/u.test(baseUrl) || URL.parse(baseUrl)?.protocol !== 'https:')) {
    throw new ConfigError({ envField: 'SORTING_BASE_URL', reason: 'malformed' });
  }
  return Object.freeze({ kind: 'agent', model, apiKey, baseUrl });
}

/**
 * Reads the tracing fields in documented order. Tracing defaults to on for the
 * test period (issue #16); a missing key degrades to untraced instead of
 * failing boot. LANGSMITH_TRACING is deliberately never read: setting it would
 * make LangChain add a second, implicit tracer.
 * @param env the process environment
 */
function loadTracing(env: NodeJS.ProcessEnv): TracingConfig {
  const mode = presentValue(env.TRACING) ?? 'langsmith';
  if (mode !== 'langsmith' && mode !== 'off') {
    throw new ConfigError({ envField: 'TRACING', reason: 'malformed' });
  }
  const apiKey = presentValue(env.LANGSMITH_API_KEY);
  const project = env.LANGSMITH_PROJECT ?? DEFAULT_LANGSMITH_PROJECT;
  if (project === '') {
    throw new ConfigError({ envField: 'LANGSMITH_PROJECT', reason: 'malformed' });
  }
  if (mode === 'off') {
    return Object.freeze({ kind: 'off', reason: 'disabled' });
  }
  if (apiKey === undefined) {
    return Object.freeze({ kind: 'off', reason: 'missing-key' });
  }
  return Object.freeze({ kind: 'langsmith', apiKey, project });
}

/** Validate env exactly once; return frozen Config or throw ConfigError. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const partial: Record<string, unknown> = {};

  for (const field of FIELD_ORDER) {
    const envName = ENV_NAME[field];
    const raw = env[envName];
    const result = validateField(field, raw, partial);
    if ('error' in result) {
      throw result.error;
    }
    if (result.value !== undefined) {
      partial[field] = result.value;
    }
  }

  // Final coalesce through zod to apply defaults for unspecified optional
  // fields. All present values have already been validated, so a zod failure
  // here is unreachable; surface it as a malformed error keyed off whichever
  // field zod names (defensive).
  const parsed = configSchema.safeParse(partial);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue && issue.path.length > 0) {
      const field = String(issue.path[0]) as (typeof FIELD_ORDER)[number];
      throw new ConfigError({
        envField: ENV_NAME[field],
        reason: 'malformed',
      });
    }
    // No path information — defensive; should be unreachable.
    throw new ConfigError({ envField: 'UNKNOWN', reason: 'malformed' });
  }

  const sorting = loadSorting(env);
  const tracing = loadTracing(env);
  const { ocrProvider, gcpSaKeyPath, ...rest } = parsed.data;
  return Object.freeze({
    ...rest,
    ocrProvider: toOcrProviderConfig(ocrProvider, gcpSaKeyPath),
    sorting,
    tracing,
  });
}

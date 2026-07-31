// Zod schema for the env-config (data-model.md Entity 1 + research R5).
// This is the ONLY module permitted to import zod (enforced by
// eslint.config.mjs's `no-restricted-paths` zone).
import { z } from 'zod';

const logLevel = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

const noWhitespaceString = z
  .string()
  .refine((v) => !/\s/u.test(v), { message: 'must not contain whitespace' });

// IPv4 literal only (loopback-only intent for v1; IPv6 `::1` rejected per
// data-model.md Entity 1 §Validation note).
const ipv4Literal = z
  .string()
  .refine((v) => /^(25[0-5]|2[0-4]\d|1?\d{1,2})(\.(25[0-5]|2[0-4]\d|1?\d{1,2})){3}$/u.test(v), {
    message: 'must be a valid IPv4 literal',
  });

const positiveInt = z
  .number()
  .int()
  .refine((n) => Number.isSafeInteger(n), { message: 'must be an integer' });

export const configSchema = z.object({
  discordToken: z.string().min(1, 'discordToken must be non-empty'),
  logLevel: logLevel.default('info'),
  commandPrefix: noWhitespaceString
    .min(1, 'commandPrefix must be 1-4 chars')
    .max(4, 'commandPrefix must be 1-4 chars')
    .default('!'),
  echoCommandName: z
    .string()
    .min(1, 'echoCommandName must be non-empty')
    .refine((v) => v === v.toLowerCase(), {
      message: 'echoCommandName must be lowercase',
    })
    .default('echo'),
  echoMaxLength: positiveInt
    .min(1, 'echoMaxLength must be >= 1')
    .max(1900, 'echoMaxLength must be <= 1900')
    .default(1900),
  shutdownTimeoutMs: positiveInt
    .min(1000, 'shutdownTimeoutMs must be >= 1000')
    .max(30000, 'shutdownTimeoutMs must be <= 30000')
    .default(5000),
  healthHost: ipv4Literal.default('127.0.0.1'),
  healthPort: positiveInt
    .min(1, 'healthPort must be >= 1')
    .max(65535, 'healthPort must be <= 65535')
    .default(8081),
});

export type ConfigSchema = z.infer<typeof configSchema>;

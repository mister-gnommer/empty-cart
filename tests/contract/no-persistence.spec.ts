import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// No-persistence guarantee: "MUST NOT retain echo command payloads after the
// command has been handled." Belt-and-suspenders to the design discipline: the
// echo, discord, and lifecycle modules MUST NOT import or use a persistence
// mechanism that would retain UserCommand.args or EchoResult.reply beyond the
// command handler call. This contract test statically scans the three module
// subtrees for prohibited persistence primitives.
const SCAN_ROOTS = [
  resolve(__dirname, '../../src/echo'),
  resolve(__dirname, '../../src/discord'),
  resolve(__dirname, '../../src/lifecycle'),
];

// Prohibited string patterns — either imports of persistence libs or direct
// use of a persistence API. Tuned to the Node v1 stack: no DB, no file
// store, no cache.
const PROHIBITED_PATTERNS: RegExp[] = [
  /\bfrom\s+['"]sqlite[0-9]?['"]/, // sqlite / better-sqlite3 etc.
  /\bfrom\s+['"]level['"]/,
  /\bfrom\s+['"]redis['"]/,
  /\bfrom\s+['"]ioredis['"]/,
  /\bfrom\s+['"]node:sqlite['"]/,
  /fs\.writeFile\b/,
  /fs\.appendFile\b/,
  /fs\.writeFileSync\b/,
  /fs\.appendFileSync\b/,
  /fs\.promises\.writeFile\b/,
  /fs\.promises\.appendFile\b/,
  /\bfrom\s+['"]node:fs['"]/,
  /\blocalStorage\b/,
  /\bsessionStorage\b/,
];

function listTs(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) listTs(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('no-persistence static scan', () => {
  for (const root of SCAN_ROOTS) {
    it(`no persistence primitive reaches ${root.replace(/^.*src\//, 'src/')}`, () => {
      const files = listTs(root);
      // Tolerate empty subtrees: the contract only asserts "no offender",
      // not "files must exist". Empty subtrees trivially satisfy the
      // no-persistence guarantee.
      const offenders: string[] = [];
      for (const f of files) {
        const src = readFileSync(f, 'utf8');
        for (const pat of PROHIBITED_PATTERNS) {
          if (pat.test(src)) {
            offenders.push(`${f} matched /${pat.source}/`);
          }
        }
      }
      expect(
        offenders,
        `prohibited persistence primitives found:\n${offenders.join('\n')}`,
      ).toEqual([]);
    });
  }
});

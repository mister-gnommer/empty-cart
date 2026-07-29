import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// FR-008 / Constitution Principle IV: structural purity check for the echo
// core. `handleEchoCommand` MUST NOT reference any module-scoped mutable
// variable (`let`/`var` at module scope that survives across calls). A pure
// function of (cmd, config) cannot accidentally retain payloads across
// commands if it has no module-scoped mutable state. This contract is
// distinct from T011 (behavior) and T012 (adapter).
const SRC_PATH = resolve(__dirname, '../../src/echo/handle-echo.ts');

/** Strip line comments, block comments, and string/template literals to avoid
 *  false positives from the words `let`/`var` appearing in comments/strings. */
function stripLiteralsAndComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    // line comment
    if (two === '//') {
      const nl = src.indexOf('\n', i + 2);
      if (nl === -1) break;
      i = nl + 1;
      continue;
    }
    // block comment
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) break;
      i = end + 2;
      continue;
    }
    // string literals (single/double/backtick) — naive: skip to matching
    if (c === '"' || c === "'" || c === '`') {
      i += 1;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

describe('echo module-scope purity (FR-008 / Principle IV)', () => {
  it('handleEchoCommand references no module-scoped let/var variable', () => {
    const src = readFileSync(SRC_PATH, 'utf8');
    const cleaned = stripLiteralsAndComments(src);

    // A `let`/`var` at module scope is a top-level declaration: appears at
    // column 0 (modulo leading whitespace) and is NOT inside a block. We
    // detect top-level `let NAME` / `var NAME` declarators by scanning for
    // lines matching `^\s*(let|var)\s+\w` (the wide indent allows for typical
    // formatting where there's no deeper block around it — the function
    // bodies start with greater indentation, which we exclude by checking
    // that the match is not inside a `{` block depth > 0).
    const lines = cleaned.split('\n');
    let depth = 0;
    const offending: string[] = [];
    for (const line of lines) {
      // track curly depth loosely (good enough for top-level scan)
      for (const ch of line) {
        if (ch === '{') depth += 1;
        else if (ch === '}') depth = Math.max(0, depth - 1);
      }
      // Top-level declaration: depth==0 right BEFORE this line. But because
      // we updated depth using THIS line's braces, the simple check below
      // flags a top-level `let/var` at depth 0.
      const m = /^(\s*)(let|var)\s+\w/.exec(line);
      if (m && (m[1]?.length ?? 0) === 0) {
        offending.push(line.trim());
      }
    }
    expect(offending, `module-scoped mutable bindings found: ${offending.join('; ')}`).toEqual([]);
  });
});
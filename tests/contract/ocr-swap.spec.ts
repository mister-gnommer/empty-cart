import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Provider swap guarantee: the vendor module stays confined behind the wiring
// and no list-handling module knows which provider is active. The behavior
// side is the stub provider itself, which the integration suites run the full
// user-facing flow against.

const SRC_ROOT = resolve(__dirname, '../../src');

const VENDOR_MODULE_DIR = join(SRC_ROOT, 'ocr', 'google-vision');
const WIRING_DIR = join(SRC_ROOT, 'lifecycle');
// Modules that handle the list flow and must stay provider-agnostic. `ocr` holds
// the provider implementations as subdirectories, which are carved out below.
const PROVIDER_AGNOSTIC_DIRS = ['shopping-list', 'image', 'discord', 'ocr'].map((d) =>
  join(SRC_ROOT, d),
);

/** Whether this source file belongs to a list-handling module outside the vendor provider. */
function isProviderAgnostic(file: string): boolean {
  return (
    !isUnder(file, VENDOR_MODULE_DIR) && PROVIDER_AGNOSTIC_DIRS.some((dir) => isUnder(file, dir))
  );
}

// Static `from '…'`, side-effect `import '…'`, dynamic `import('…')`, and
// `require('…')` — multi-line import lists end in `from '…'`, so they match too.
const SPECIFIER_PATTERN =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

/** Every module specifier imported or required by this source text, in order. */
function extractSpecifiers(source: string): string[] {
  return [...source.matchAll(SPECIFIER_PATTERN)].map((m) => m[1]);
}

/**
 * Lists every .ts file under a directory, recursively; a missing directory yields none.
 * @param out accumulator shared across the recursion
 */
function listTs(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) {
    return out;
  }
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      listTs(full, out);
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

type ImportEdge = { file: string; specifier: string; target: string };

/** Every import in src/, with relative specifiers resolved to absolute paths. */
function allImports(): ImportEdge[] {
  return listTs(SRC_ROOT).flatMap((file) =>
    extractSpecifiers(readFileSync(file, 'utf8')).map((specifier) => ({
      file,
      specifier,
      target: specifier.startsWith('.') ? resolve(dirname(file), specifier) : specifier,
    })),
  );
}

/** Whether the path is the directory itself or inside it. */
function isUnder(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

/** A readable "file imports 'specifier'" line for failure output. */
function describeEdge(edge: ImportEdge): string {
  return `${relative(SRC_ROOT, edge.file)} imports '${edge.specifier}'`;
}

describe('provider swap: static import scan', () => {
  it('the import extractor recognizes every import form (guards against a vacuous pass)', () => {
    const sample = [
      "import { a } from './a';",
      'import {',
      '  b,',
      '  c,',
      "} from '../b';",
      "import type { T } from '@scope/pkg';",
      "import 'side-effect';",
      "const lazy = await import('./lazy');",
      "const legacy = require('legacy');",
    ].join('\n');
    expect(extractSpecifiers(sample)).toEqual([
      './a',
      '../b',
      '@scope/pkg',
      'side-effect',
      './lazy',
      'legacy',
    ]);
  });

  it('the scanned module trees exist and contain sources', () => {
    for (const dir of [VENDOR_MODULE_DIR, WIRING_DIR, ...PROVIDER_AGNOSTIC_DIRS]) {
      expect(listTs(dir).length, relative(SRC_ROOT, dir)).toBeGreaterThan(0);
    }
  });

  it('list-handling modules do not name the active provider anywhere', () => {
    const offenders: string[] = [];
    for (const dir of PROVIDER_AGNOSTIC_DIRS) {
      for (const file of listTs(dir).filter(isProviderAgnostic)) {
        if (/gcp-vision|google-vision|@google-cloud/i.test(readFileSync(file, 'utf8'))) {
          offenders.push(relative(SRC_ROOT, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // The vendor SDK itself is fenced off by the lint import boundaries; this
  // covers the relative imports those boundaries cannot express.
  it('the lifecycle wiring is the only importer of the vendor module', () => {
    const importers = allImports()
      .filter((e) => isUnder(e.target, VENDOR_MODULE_DIR) && !isUnder(e.file, VENDOR_MODULE_DIR))
      .map((e) => relative(SRC_ROOT, e.file));
    expect([...new Set(importers)]).toEqual(['lifecycle/run-app.ts']);
  });

  it('the vendor module depends on nothing but the provider contract among project modules', () => {
    const offenders = allImports()
      .filter((e) => isUnder(e.file, VENDOR_MODULE_DIR) && e.specifier.startsWith('.'))
      .filter((e) => !isUnder(e.target, VENDOR_MODULE_DIR))
      .filter((e) => e.target !== join(SRC_ROOT, 'ocr/types'))
      .map(describeEdge);
    expect(offenders).toEqual([]);
  });
});

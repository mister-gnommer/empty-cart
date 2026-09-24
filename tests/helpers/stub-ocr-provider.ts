// Stub OCR provider for tests: per-call scripted results with full call
// recording. Implements the provider contract without any vendor dependency,
// so the whole user-facing flow can run against it with zero external calls.
import type {
  OcrImageFormat,
  OcrProvider,
  OcrProviderResult,
  Recognition,
  UnavailableCause,
} from '../../src/ocr/types';

export type StubOcrCall = {
  bytes: Uint8Array;
  format: OcrImageFormat;
  languageHints: readonly string[];
  timeoutMs: number;
};

/** A scripted per-call result: either a fixed result or a thunk (e.g. a deferred promise). */
export type StubScriptEntry =
  | OcrProviderResult
  | (() => OcrProviderResult | Promise<OcrProviderResult>);

export type StubOcrProvider = OcrProvider & {
  /** Recorded calls, in call order. */
  readonly calls: StubOcrCall[];
};

export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolveFn: ((value: T) => void) | undefined;
  let rejectFn: ((err: unknown) => void) | undefined;
  // The Promise executor runs synchronously, so both closures are set before
  // deferred() returns; the optional calls below can never no-op in practice.
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return {
    promise,
    resolve: (value: T) => resolveFn?.(value),
    reject: (err: unknown) => rejectFn?.(err),
  };
}

/**
 * Builds a Recognition whose lines honor the fidelity invariant by
 * construction: splitting on '\n' and re-joining round-trips byte-for-byte.
 */
export function okRecognition(text: string): Recognition {
  const lines = text.split('\n').map((lineText) => ({
    text: lineText,
    confidence: 1,
    boundingBox: { x: 0, y: 0, width: 0, height: 0 },
  }));
  return { text, lines };
}

export function okResult(text: string, fidelityCheck?: 'match' | 'mismatch'): OcrProviderResult {
  return fidelityCheck === undefined
    ? { status: 'ok', recognition: okRecognition(text) }
    : { status: 'ok', recognition: okRecognition(text), fidelityCheck };
}

export function unavailableResult(cause: UnavailableCause): OcrProviderResult {
  return { status: 'unavailable', cause };
}

export function undecodableResult(): OcrProviderResult {
  return { status: 'undecodable-image' };
}

/**
 * Creates a stub provider that answers call N with script entry N. Entries may
 * be plain results or thunks (return a deferred promise to hold a call open).
 * Running past the end of the script rejects loudly so mis-scripted tests fail
 * instead of silently returning something plausible.
 */
export function createStubOcrProvider(
  script: readonly StubScriptEntry[],
  id = 'stub',
): StubOcrProvider {
  const calls: StubOcrCall[] = [];
  let nextEntry = 0;
  return {
    id,
    calls,
    recognize(req) {
      calls.push({
        bytes: req.image.bytes,
        format: req.image.format,
        languageHints: req.languageHints,
        timeoutMs: req.timeoutMs,
      });
      const entry = script[nextEntry];
      nextEntry += 1;
      if (entry === undefined) {
        return Promise.reject(
          new Error(`stub ocr provider: script exhausted after ${calls.length} call(s)`),
        );
      }
      return Promise.resolve(typeof entry === 'function' ? entry() : entry);
    },
  };
}

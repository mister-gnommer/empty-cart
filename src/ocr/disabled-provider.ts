import type { OcrProvider, OcrProviderResult } from './types';

/**
 * Provider for the recognition-disabled configuration: every call resolves
 * `unavailable`/`disabled` without any I/O, so every image submission still
 * receives the generic user-facing reply instead of silence.
 */
export function createDisabledProvider(): OcrProvider {
  const disabled: OcrProviderResult = { status: 'unavailable', cause: 'disabled' };
  return {
    id: 'disabled',
    recognize: () => Promise.resolve(disabled),
  };
}

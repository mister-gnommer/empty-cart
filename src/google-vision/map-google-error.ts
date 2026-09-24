// Pure mapper: any rejection from the Vision call path (thrown GoogleError or
// an in-band google.rpc.Status reported on a 200) → the provider contract's
// outcome union. Vendor errors never leak across the module boundary.

import type { OcrProviderResult } from '../ocr/types';

/**
 * The mapped result plus log-context fields. Only the numeric code and the
 * promoted ErrorInfo reason are carried — never the human-readable message,
 * which can embed request details.
 */
export type MappedGoogleError = OcrProviderResult & {
  readonly googleCode: number | null;
  readonly googleReason: string | null;
};

function readCode(err: unknown): number | null {
  return typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'number'
    ? err.code
    : null;
}

function readMessage(err: unknown): string {
  return typeof err === 'object' &&
    err !== null &&
    'message' in err &&
    typeof err.message === 'string'
    ? err.message
    : '';
}

function readReason(err: unknown): string | null {
  return typeof err === 'object' &&
    err !== null &&
    'reason' in err &&
    typeof err.reason === 'string'
    ? err.reason
    : null;
}

export function mapGoogleError(err: unknown): MappedGoogleError {
  const googleCode = readCode(err);
  const message = readMessage(err);
  const googleReason = readReason(err);

  let base: OcrProviderResult;
  if (googleCode === 3 && message.includes('Bad image data')) {
    // The documented undecodable-bytes signature.
    base = { status: 'undecodable-image' };
  } else if (googleCode === 4) {
    base = { status: 'unavailable', cause: 'deadline-exceeded' };
  } else if (googleCode === 7 || googleCode === 16) {
    // API/billing disabled and bad credentials both land on unauthorized.
    base = { status: 'unavailable', cause: 'unauthorized' };
  } else if (googleCode === 8) {
    base = { status: 'unavailable', cause: 'quota-exhausted' };
  } else if (googleCode === 14) {
    // DNS/TCP failures are wrapped into UNAVAILABLE by the transport.
    base = { status: 'unavailable', cause: 'unreachable' };
  } else {
    // Any other code, a code-3 without the decode signature, and non-Error
    // throws: the conservative catch-all.
    base = { status: 'unavailable', cause: 'provider-error' };
  }

  return { ...base, googleCode, googleReason };
}

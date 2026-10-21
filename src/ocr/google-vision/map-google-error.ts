// Pure mapper: any rejection from the Vision call path (thrown GoogleError or
// an in-band google.rpc.Status reported on a 200) → the provider contract's
// outcome union. Vendor errors never leak across the module boundary.

import type { OcrProviderResult } from '../types';

// gRPC canonical status codes (google.rpc.Code) the mapper distinguishes.
const GrpcCode = {
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  UNAVAILABLE: 14,
  UNAUTHENTICATED: 16,
} as const;

type FailureResult = Exclude<OcrProviderResult, { status: 'ok' }>;

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

/**
 * Maps a Vision failure onto the provider result union. Only the numeric code and
 * the promoted ErrorInfo reason reach the log context — never the human-readable
 * message, which can embed request details.
 * @param err a thrown GoogleError or an in-band google.rpc.Status
 * @returns the failure arm, carrying the code and reason for the operator log
 */
export function mapGoogleError(err: unknown): FailureResult {
  const googleCode = readCode(err);
  const message = readMessage(err);
  const googleReason = readReason(err);

  let base: FailureResult;
  if (googleCode === GrpcCode.INVALID_ARGUMENT && message.includes('Bad image data')) {
    // The documented undecodable-bytes signature.
    base = { status: 'undecodable-image' };
  } else if (googleCode === GrpcCode.DEADLINE_EXCEEDED) {
    base = { status: 'unavailable', cause: 'deadline-exceeded' };
  } else if (googleCode === GrpcCode.PERMISSION_DENIED || googleCode === GrpcCode.UNAUTHENTICATED) {
    // API/billing disabled and bad credentials both land on unauthorized.
    base = { status: 'unavailable', cause: 'unauthorized' };
  } else if (googleCode === GrpcCode.RESOURCE_EXHAUSTED) {
    base = { status: 'unavailable', cause: 'quota-exhausted' };
  } else if (googleCode === GrpcCode.UNAVAILABLE) {
    // DNS/TCP failures are wrapped into UNAVAILABLE by the transport.
    base = { status: 'unavailable', cause: 'unreachable' };
  } else {
    // Any other code, an INVALID_ARGUMENT without the decode signature, and non-Error
    // throws: the conservative catch-all.
    base = { status: 'unavailable', cause: 'provider-error' };
  }

  return { ...base, logContext: { googleCode, googleReason } };
}

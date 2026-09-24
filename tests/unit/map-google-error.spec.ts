import { describe, expect, it } from 'vitest';
import { mapGoogleError } from '../../src/google-vision/map-google-error';

/** Stand-in for a google-gax GoogleError: an Error carrying a numeric gRPC code and a promoted reason. */
class FakeGoogleError extends Error {
  readonly code: number;
  readonly reason?: string;

  constructor(code: number, message: string, reason?: string) {
    super(message);
    this.name = 'GoogleError';
    this.code = code;
    if (reason !== undefined) {
      this.reason = reason;
    }
  }
}

const SECRET_MESSAGE_DETAIL = 'S3CRET-request-detail-that-must-not-be-carried';

describe('mapGoogleError taxonomy', () => {
  it('code 3 with the decode-failure signature maps to undecodable-image', () => {
    const result = mapGoogleError(
      new FakeGoogleError(3, `3 INVALID_ARGUMENT: Bad image data. ${SECRET_MESSAGE_DETAIL}`),
    );
    expect(result).toMatchObject({ status: 'undecodable-image' });
  });

  it('code 3 WITHOUT the decode-failure signature conservatively maps to provider-error', () => {
    const result = mapGoogleError(new FakeGoogleError(3, 'Request had invalid arguments'));
    expect(result).toMatchObject({ status: 'unavailable', cause: 'provider-error' });
  });

  it('code 4 (deadline) maps to deadline-exceeded', () => {
    const result = mapGoogleError(new FakeGoogleError(4, 'Deadline exceeded'));
    expect(result).toMatchObject({ status: 'unavailable', cause: 'deadline-exceeded' });
  });

  it('code 7 (permission/service disabled) maps to unauthorized', () => {
    const result = mapGoogleError(
      new FakeGoogleError(7, 'Vision API has not been used', 'SERVICE_DISABLED'),
    );
    expect(result).toMatchObject({ status: 'unavailable', cause: 'unauthorized' });
  });

  it('code 8 (resource exhausted) maps to quota-exhausted', () => {
    const result = mapGoogleError(new FakeGoogleError(8, 'Quota exceeded for quota metric'));
    expect(result).toMatchObject({ status: 'unavailable', cause: 'quota-exhausted' });
  });

  it('code 14 (transport unavailable) maps to unreachable', () => {
    const result = mapGoogleError(new FakeGoogleError(14, 'DNS resolution failed'));
    expect(result).toMatchObject({ status: 'unavailable', cause: 'unreachable' });
  });

  it('code 16 (unauthenticated) maps to unauthorized', () => {
    const result = mapGoogleError(new FakeGoogleError(16, 'Invalid credentials'));
    expect(result).toMatchObject({ status: 'unavailable', cause: 'unauthorized' });
  });

  it('any other code maps to provider-error', () => {
    const result = mapGoogleError(new FakeGoogleError(13, 'Internal error'));
    expect(result).toMatchObject({ status: 'unavailable', cause: 'provider-error' });
  });

  it('a non-Error throw maps to provider-error', () => {
    expect(mapGoogleError('a bare string')).toMatchObject({
      status: 'unavailable',
      cause: 'provider-error',
    });
    expect(mapGoogleError(undefined)).toMatchObject({
      status: 'unavailable',
      cause: 'provider-error',
    });
    expect(mapGoogleError({})).toMatchObject({
      status: 'unavailable',
      cause: 'provider-error',
    });
  });

  it('applies to an in-band google.rpc.Status object (plain object, not an Error)', () => {
    const result = mapGoogleError({ code: 3, message: 'Bad image data.' });
    expect(result).toMatchObject({ status: 'undecodable-image' });
  });
});

describe('mapGoogleError log context', () => {
  it('carries the numeric code when present', () => {
    const result = mapGoogleError(new FakeGoogleError(14, 'unreachable'));
    expect(result.googleCode).toBe(14);
  });

  it('carries the promoted reason when present, null otherwise', () => {
    const withReason = mapGoogleError(new FakeGoogleError(7, 'disabled', 'BILLING_DISABLED'));
    expect(withReason.googleReason).toBe('BILLING_DISABLED');
    const withoutReason = mapGoogleError(new FakeGoogleError(14, 'unreachable'));
    expect(withoutReason.googleReason).toBeNull();
  });

  it('reports a null code for non-Error throws', () => {
    expect(mapGoogleError('boom').googleCode).toBeNull();
  });

  it('never carries the human-readable message (no secret details on the result)', () => {
    const result = mapGoogleError(new FakeGoogleError(3, SECRET_MESSAGE_DETAIL));
    expect(JSON.stringify(result)).not.toContain(SECRET_MESSAGE_DETAIL);
  });
});

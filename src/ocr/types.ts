// Provider-agnostic OCR contract — pure types, zero vendor imports.
// Provider modules implement OcrProvider; the orchestrator depends only on this
// surface, so swapping the active provider never touches business logic.

export type OcrImageFormat = 'jpeg' | 'png' | 'webp';

export type UnavailableCause =
  | 'unreachable'
  | 'unauthorized'
  | 'quota-exhausted'
  | 'provider-error'
  | 'deadline-exceeded'
  | 'disabled';

/**
 * Vendor diagnostics for the operator log (e.g. a raw error code). Opaque to the
 * orchestrator; MUST NOT carry secrets, image bytes, or recognized text.
 */
export type ProviderLogContext = Readonly<Record<string, string | number | null>>;

export type OcrProviderResult =
  | {
      status: 'ok';
      /** Whole-page text in the provider's own line-break semantics, never altered. */
      text: string;
    }
  | { status: 'undecodable-image'; logContext?: ProviderLogContext }
  | { status: 'unavailable'; cause: UnavailableCause; logContext?: ProviderLogContext };

export interface RecognizeRequest {
  image: { bytes: Uint8Array; format: OcrImageFormat };
  languageHints: readonly string[];
  timeoutMs: number;
}

export interface OcrProvider {
  readonly id: string;
  recognize(req: RecognizeRequest): Promise<OcrProviderResult>;
}

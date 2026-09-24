// Provider-agnostic OCR contract — pure types, zero vendor imports.
// Provider modules implement OcrProvider; the orchestrator depends only on this
// surface, so swapping the active provider never touches business logic.

export type RecognizedLine = {
  text: string;
  /** Recognition confidence in [0, 1]. */
  confidence: number;
  /** Axis-aligned box in page pixel coordinates. */
  boundingBox: { x: number; y: number; width: number; height: number };
};

export type Recognition = {
  /** Whole-page text, in the provider's own line-break semantics. */
  text: string;
  /**
   * Ordered lines. Fidelity invariant: `lines.map((l) => l.text).join('\n')`
   * equals `text`, except that a single trailing empty line produced by a
   * terminal provider break may be dropped. Text is never trimmed, normalized,
   * reordered, or de-duplicated.
   */
  lines: RecognizedLine[];
};

export type OcrImageFormat = 'jpeg' | 'png' | 'webp';

export type UnavailableCause =
  | 'unreachable'
  | 'unauthorized'
  | 'quota-exhausted'
  | 'provider-error'
  | 'deadline-exceeded'
  | 'disabled';

export type OcrProviderResult =
  // 🤖 AI-start
  | {
      status: 'ok';
      recognition: Recognition;
      /**
       * Provider self-check: whether the provider's own whole-page text equals
       * `recognition.text`. Absent when the provider supplies no separate page
       * text. Content-free by design, so it is safe to log.
       */
      fidelityCheck?: 'match' | 'mismatch';
    }
  // 🤖 AI-end
  | { status: 'undecodable-image' }
  | { status: 'unavailable'; cause: UnavailableCause };

export interface OcrProvider {
  readonly id: string;
  recognize(req: {
    image: { bytes: Uint8Array; format: OcrImageFormat };
    languageHints: readonly string[];
    timeoutMs: number;
  }): Promise<OcrProviderResult>;
}

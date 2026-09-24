// Google Cloud Vision provider — the ONLY module permitted to import the
// vendor SDK (enforced by the lint import boundaries). Implements the
// provider-agnostic OCR contract; the rest of the app never knows this
// module exists except the composition root.

import { accessSync, constants } from 'node:fs';
import { ImageAnnotatorClient } from '@google-cloud/vision';
import type { OcrProvider, OcrProviderResult } from '../ocr/types';
import { mapGoogleError } from './map-google-error';
import { type FullTextAnnotationLike, toRecognition } from './to-recognition';

export type AnnotateImageResponseLike = {
  fullTextAnnotation?: FullTextAnnotationLike | null;
  error?: { code?: number | null; message?: string | null } | null;
};

export type BatchResponseLike = {
  responses?: AnnotateImageResponseLike[] | null;
};

export type AnnotateRequestLike = {
  image: { content: Uint8Array };
  features: Array<{ type: 'DOCUMENT_TEXT_DETECTION' }>;
  imageContext?: { languageHints?: string[] };
};

/** The single call surface this module uses from the vendor client. */
export type AnnotatorClientLike = {
  batchAnnotateImages(
    request: { requests: AnnotateRequestLike[] },
    options?: { timeout?: number; retry?: unknown },
  ): Promise<[BatchResponseLike, ...unknown[]]>;
};

export function createGoogleVisionProvider(deps: {
  keyFile: string;
  /**
   * Test seam: production callers MUST omit it — the real client is
   * constructed below with the operator's service-account key file.
   */
  clientFactory?: (opts: { keyFilename: string }) => AnnotatorClientLike;
}): OcrProvider {
  // The credential file is validated once at construction (startup), so a bad
  // path is a boot failure naming the env var — never a first-photo failure.
  // Key CONTENTS are never read here nor embedded in any message.
  try {
    accessSync(deps.keyFile, constants.R_OK);
  } catch {
    throw new Error('GCP_SA_KEY_PATH does not point to a readable service-account key file');
  }

  const client: AnnotatorClientLike = deps.clientFactory
    ? deps.clientFactory({ keyFilename: deps.keyFile })
    : new ImageAnnotatorClient({ keyFilename: deps.keyFile });

  return {
    id: 'gcp-vision',
    async recognize(req): Promise<OcrProviderResult> {
      const annotateRequest: AnnotateRequestLike = {
        image: { content: req.image.bytes },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
      };
      if (req.languageHints.length > 0) {
        annotateRequest.imageContext = { languageHints: [...req.languageHints] };
      }
      try {
        // The client's default retry schedule (with a 600 s total timeout)
        // would destroy the submission budget: retries are disabled outright
        // and the remaining budget is forwarded as the per-call timeout.
        const [batch] = await client.batchAnnotateImages(
          { requests: [annotateRequest] },
          { timeout: req.timeoutMs, retry: null },
        );
        const first = batch?.responses?.[0];
        if (first?.error) {
          // Vision reports per-image failures in-band on a 200.
          return mapGoogleError(first.error);
        }
        // A missing/empty annotation resolves ok with an empty recognition —
        // the "no readable text" decision belongs to the orchestrator.
        // 🤖 AI-start
        const annotation = first?.fullTextAnnotation ?? {};
        const recognition = toRecognition(annotation);
        // The provider's own page text is what the user receives whenever it
        // is present; the symbol-level reconstruction only supplies the
        // per-line breakdown. Comparing the two flags drift in that breakdown
        // without ever logging the text itself.
        if (typeof annotation.text !== 'string') {
          return { status: 'ok', recognition };
        }
        const fidelityCheck = annotation.text === recognition.text ? 'match' : 'mismatch';
        return {
          status: 'ok',
          recognition: { text: annotation.text, lines: recognition.lines },
          fidelityCheck,
        };
        // 🤖 AI-end
      } catch (err) {
        return mapGoogleError(err);
      }
    },
  };
}

// Google Cloud Vision provider — the ONLY module permitted to import the
// vendor SDK (enforced by the lint import boundaries). Implements the
// provider-agnostic OCR contract; the rest of the app never knows this
// module exists except the composition root.

import { accessSync, constants } from 'node:fs';
import { ImageAnnotatorClient } from '@google-cloud/vision';
import type { OcrProvider, OcrProviderResult, RecognizeRequest } from '../types';
import { mapGoogleError } from './map-google-error';

export type FullTextAnnotationLike = { text?: string | null };

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

/** Vision request for one image; hints are omitted when empty so Vision auto-detects. */
function buildAnnotateRequest(req: RecognizeRequest): AnnotateRequestLike {
  const annotateRequest: AnnotateRequestLike = {
    image: { content: req.image.bytes },
    features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
  };
  if (req.languageHints.length > 0) {
    annotateRequest.imageContext = { languageHints: [...req.languageHints] };
  }
  return annotateRequest;
}

/**
 * Interprets Vision's per-image response. An in-band error maps to a failure;
 * otherwise the page text is returned as-is, and a missing one is ok with
 * empty text, because the "no readable text" decision belongs to the orchestrator.
 * @param response the first entry of the batch response, if any
 */
function toProviderResult(response: AnnotateImageResponseLike | undefined): OcrProviderResult {
  if (response?.error) {
    // Vision reports per-image failures in-band on a 200.
    return mapGoogleError(response.error);
  }
  return { status: 'ok', text: response?.fullTextAnnotation?.text ?? '' };
}

/**
 * Builds the OCR provider backed by Cloud Vision DOCUMENT_TEXT_DETECTION. Fails
 * fast at startup when the key file is unreadable; afterwards `recognize`
 * never throws — every vendor failure is mapped onto the provider result union.
 * @param deps service-account key path and an optional client factory for tests
 * @returns the provider the composition root hands to the list-submission handler
 */
export function createGoogleVisionProvider(deps: {
  keyFilePath: string;
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
    accessSync(deps.keyFilePath, constants.R_OK);
  } catch {
    throw new Error('GCP_SA_KEY_PATH does not point to a readable service-account key file');
  }

  const client: AnnotatorClientLike = deps.clientFactory
    ? deps.clientFactory({ keyFilename: deps.keyFilePath })
    : new ImageAnnotatorClient({ keyFilename: deps.keyFilePath });

  async function recognize(req: RecognizeRequest): Promise<OcrProviderResult> {
    try {
      // The client's default retry schedule (with a 600 s total timeout)
      // would destroy the submission budget: retries are disabled outright
      // and the remaining budget is forwarded as the per-call timeout.
      const [batch] = await client.batchAnnotateImages(
        { requests: [buildAnnotateRequest(req)] },
        { timeout: req.timeoutMs, retry: null },
      );
      return toProviderResult(batch?.responses?.[0]);
    } catch (err) {
      return mapGoogleError(err);
    }
  }

  return { id: 'gcp-vision', recognize };
}

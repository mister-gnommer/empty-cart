# Google Cloud Vision: notes for reading this module

We use one Vision endpoint, the synchronous `images:annotate`, through
`ImageAnnotatorClient.batchAnnotateImages` from `@google-cloud/vision`. Each call sends
one image as inline bytes (no Cloud Storage) and asks for the `DOCUMENT_TEXT_DETECTION`
feature, which is tuned for dense text and handwriting. Its sibling `TEXT_DETECTION`
targets sparse text such as signs and is the wrong choice for lists. Google bills per image.

## Vocabulary

- **Feature**: which detector to run. Vision has many (labels, faces, logos, text), and the
  request lists the ones you want in `features: [{ type }]`.
- **Annotation**: Google's name for a detector's output. "Annotate an image" means "run
  detectors on it". Each feature fills its own field in the response. We request one
  feature, so we read one field, `fullTextAnnotation`.
- **Batch**: the API always takes a list of requests and returns `responses[]` in the same
  order. We send a list of one and read `responses[0]`.
- **`fullTextAnnotation.text`**: the whole page as one string with line breaks. The user
  receives this text.
- **`pages → blocks → paragraphs → words → symbols`**: the same text as a tree. A symbol
  is roughly one character. Every level carries `confidence` (0 to 1) and
  `boundingBox.vertices` in image pixels.
- **`detectedBreak`**: set on a symbol, it says what whitespace follows it (a space, a
  newline, or nothing). Google builds `text` from these breaks.
- **`languageHints`**: BCP-47 tags such as `en`, or `en-t-i0-handwrit` for handwriting.
  Google recommends sending none and letting Vision detect the language, because a wrong
  hint makes results worse. We send hints only when the operator configures them.

## We use the page text as-is

The provider returns `fullTextAnnotation.text` unchanged; a missing annotation is empty
text. The tree is ignored for now. Word-level confidence from it is planned for
feature 003 (AI list interpretation).

## Errors arrive two ways

1. **Thrown.** The client rejects with a google-gax `GoogleError` carrying a numeric gRPC
   `code`, a `message`, and sometimes a `reason` such as `SERVICE_DISABLED` or
   `BILLING_DISABLED`.
2. **In-band.** The call succeeds (HTTP 200), but `responses[0].error` holds a
   `google.rpc.Status` of `{ code, message }`. Per-image failures come back this way. The
   provider checks this field before reading the annotation, so a corrupt image is not
   mistaken for an image with no text.

`mapGoogleError` handles both:

| gRPC code | Meaning | Our result |
|---|---|---|
| 3 `INVALID_ARGUMENT` with "Bad image data" | bytes Vision can't decode | `undecodable-image` |
| 3 `INVALID_ARGUMENT` without that message | other bad request | `provider-error` |
| 4 `DEADLINE_EXCEEDED` | our per-call timeout fired | `deadline-exceeded` |
| 7 `PERMISSION_DENIED` | API or billing disabled on the project | `unauthorized` |
| 8 `RESOURCE_EXHAUSTED` | quota used up | `quota-exhausted` |
| 14 `UNAVAILABLE` | network failure (the transport reports DNS/TCP errors as 14) | `unreachable` |
| 16 `UNAUTHENTICATED` | bad or expired key | `unauthorized` |
| anything else | | `provider-error` |

Only `code` and `reason` get logged. `message` can echo request details, so it never does.

## Timeouts and retries

The client ships a default retry policy for this call: it retries on codes 4 and 14 with
backoff, for up to 600 s in total. That would blow the 25 s per-submission budget, so every
call passes the gax call options `{ timeout: remainingMs, retry: null }`. When that timeout
fires the client throws code 4. Google may still bill a call we gave up on.

## Auth

The service-account JSON key file's path comes from `GCP_SA_KEY_PATH` and goes to the
client as `keyFilename`. The project ID is read from the key file. We check at startup
that the file is readable and never read its contents ourselves.

## The `...Like` types

These are hand-written subsets of the SDK's generated protobuf types, covering only the
fields we read. Test stubs can then be plain objects. Assigning the real
`ImageAnnotatorClient` to `AnnotatorClientLike` makes the compiler check that the SDK still
matches, so an SDK change that breaks us fails the build.

Sources and rejected alternatives: `specs/002-shopping-list-ocr/research.md`, sections R1–R7 (R3–R5, which covered line reconstruction, are superseded).

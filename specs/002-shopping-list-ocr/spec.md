# Feature Specification: Shopping List Photo OCR

**Feature Branch**: `002-shopping-list-ocr`

**Created**: 2026-09-18

**Status**: Draft

**Input**: User description: "New feature will focus on adding functionality to handle shopping lists sent via Discord as photos. The shopping list is handwritten, and an empty cart should use external OCR. To start, we will use Transcribus (link below), but the architecture should allow easy switching, so we are using interfaces approach probably. After OCR, an empty cart should return the shopping list as is, in the same order, without changing anything—just OCR it and send it back. No AI for now. https://www.transkribus.org/pricing"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Send a Photo, Get the List Text Back (Priority: P1)

A Discord user photographs a handwritten shopping list and sends the image to a channel (or direct message) where the bot is present. The bot recognizes the image, sends it to the configured external OCR service, and replies in the same conversation with the recognized text. The text is returned exactly as the OCR service produced it — same lines, same order, same wording — with no cleanup, correction, translation, reordering, or extraction into structured items.

**Why this priority**: This is the entire point of the feature and the smallest slice that proves the OCR integration and the list-handling path end to end. Every later refinement (multiple photos, provider switching, error reporting) assumes a working single-image passthrough.

**Independent Test**: Can be fully tested by posting a prepared handwritten-list image in a channel the bot can read and verifying that the bot posts back text whose content and line order match the OCR service's recognized output, within a bounded time.

**Acceptance Scenarios**:

1. **Given** the bot is running with OCR configured, **When** a user sends a message containing one handwritten shopping-list image, **Then** the bot replies in the same channel with the recognized text in the order the OCR service returned it, without adding, removing, or reordering lines.
2. **Given** the bot is running, **When** the OCR service returns recognized text, **Then** the text posted by the bot is character-for-character identical to the service's text (allowing only the transport's own handling such as mention neutralization, injection sanitization, and multi-message splitting).
3. **Given** the bot is running in a context it processes, **When** a user sends a message that contains no image attachment (for example, typed text), **Then** the bot does not attempt OCR and replies with a fixed, hardcoded usage hint that tells the user to type `!help` for information on how to use the bot.
4. **Given** the bot is running, **When** a user sends an image that the OCR service recognizes as containing no text, **Then** the bot replies with a distinct, user-actionable message asking the user to try a different photo (for example, "I couldn't read any text — can you try a different photo?"), rather than posting an empty reply, the generic service-unavailable message, or failing silently.

---

### User Story 2 - The Bot Tells Me Clearly When It Cannot Read My List (Priority: P2)

A Discord user sends a photo, but the bot cannot return the list text. From the user's point of view there are only two kinds of failure. **Service-side failures** happen on the bot's/provider's side: the OCR service is unreachable, credentials are missing or invalid, quota/credits are exhausted, the provider returns an error, the request exceeds its processing budget, or the bot cannot fetch the image. The user is not the creator/admin and cannot act on the specific cause, so all of these MUST produce one and the same generic message ("Service is not available, please try again later or contact the admin"), never a technical explanation. **Input problems** are caused by what the user sent: the photo is unreadable or contains no text, the file format is unsupported, or the image is too large. These MUST produce a short, distinct, actionable message telling the user what to change.

**Why this priority**: Graceful degradation is an explicit project constraint and the difference between a trustworthy assistant and one that silently drops a list. It ranks below P1 because it only matters once the happy path exists.

**Independent Test**: Can be tested by simulating both failure classes — service-side failure (unreachable service, denied credentials, quota exhausted, provider error, timeout, unretrievable attachment) and input problems (no text, unsupported format, oversized image) — and observing exactly one generic message for all service-side cases and a distinct, actionable message for each input problem, with no crash and no stuck request.

**Acceptance Scenarios**:

1. **Given** any service-side failure (OCR service unreachable, credentials missing/invalid, quota or credits exhausted, provider error, request exceeding the processing budget, or the image cannot be retrieved), **When** a user sends a list image, **Then** the bot replies with the same single generic hardcoded message — service not available, please try later or contact the admin — with no technical detail about the cause, and logs the specific failure with a correlation identifier.
2. **Given** the OCR service returns no readable text for the image, **When** the user sends it, **Then** the bot replies with a distinct, actionable message asking the user to try a different photo, not the generic service-unavailable message.
3. **Given** the attachment is not a supported image format or is corrupt, **When** the user sends it, **Then** the bot replies with a distinct message stating that the format is unsupported.
4. **Given** the image exceeds the accepted size threshold, **When** the user sends it, **Then** the bot rejects it without calling the OCR service and replies with a distinct message that the image is too large.
5. **Given** the OCR request exceeds the processing budget, **When** the bot gives up on it, **Then** the outstanding request is cancelled and the bot replies with the generic service-unavailable message and remains responsive to subsequent messages.

---

### User Story 3 - Operators Can Switch OCR Providers Without Changing Behavior (Priority: P3)

The operator wants to replace the current OCR provider (initially Transkribus) with another service later — perhaps due to pricing, accuracy, or availability. Switching the provider must be a configuration change plus a new provider implementation that honors the same contract; the user-facing behavior (what the user sends, what the bot replies, how order is preserved, how errors surface) must not change, and no list-handling logic must be rewritten.

**Why this priority**: It is a durability requirement rather than a user-visible capability. It ranks below P1/P2 because it delivers no new user value on day one, but it is recorded now because the project constitution requires external services to be abstracted behind a local interface, and the user explicitly asked for it.

**Independent Test**: Can be tested by running the bot against a stub OCR provider that satisfies the same contract and confirming that the user-facing flow and all P1/P2 behaviors are unchanged, without editing list-handling or Discord-handling logic.

**Acceptance Scenarios**:

1. **Given** the bot's OCR configuration points at a different provider implementation, **When** a user sends the same photo, **Then** the user-facing behavior (trigger, reply format, order preservation, error messages) is identical to the previous provider.
2. **Given** a new OCR provider is added, **When** the operator selects it via configuration only, **Then** no change is required to the code that detects images, orders results, or posts replies.
3. **Given** the OCR provider is mocked in tests, **When** the test suite runs, **Then** the complete user-facing flow can be exercised without contacting any external service.

---

### Edge Cases

- **Multiple images in one message**: The user sends several photos of the same list (for example, a list split across two pages). The message is treated as one shopping list; images are processed in the order the attachments appear in the message, and their recognized text is presented in that same order, with no reordering.
- **Non-image attachment**: A message contains a PDF, audio file, or other non-image attachment. The bot reports that the format is unsupported and does not send it for OCR.
- **Unsupported or corrupt image**: The file is not a readable image or is in a format the provider does not accept. The bot replies with a distinct unsupported-format message and does not crash or retry endlessly.
- **Image above the size threshold**: The image exceeds a fixed, hardcoded size threshold. The bot rejects it before contacting the OCR service and tells the user the image is too large. Text longer than a single platform message is handled normally: it is split across as many messages as needed, preserving line order.
- **OCR output contains mention tokens or injection-like content**: The recognized text contains `@everyone`, `@here`, a username mention, a role mention, or wording crafted to look like instructions to the bot. The bot neutralizes mention tokens and sanitizes the text so it cannot be interpreted as commands or instructions, while leaving ordinary list text unchanged. When AI-based interpretation is added later, a system prompt that prevents prompt injection MUST be introduced (tracked as deferred work).
- **Concurrent users**: Two users send lists at nearly the same time. Both are processed independently, each reply goes to its own originating conversation, and neither user sees the other's list.
- **Duplicate image sent twice**: The user accidentally sends the same photo twice. The bot processes and returns it each time; de-duplication/caching is not implemented in v1 and is tracked as deferred work (GitHub issue).
- **Text-only message**: The user types the list instead of photographing it. The bot does not attempt OCR and replies with the hardcoded usage hint pointing to `!help`.
- **Provider returns unexpected characters/whitespace**: The bot passes the text through unchanged; it does not trim, normalize, or "fix" content, because the requirement is to return the list as-is.
- **OCR succeeded but is slow**: The bot does not wait past the processing budget; it cancels the outstanding OCR request, returns the generic service-unavailable message, and stays responsive to other users.
- **Bot lacks permission to read the attachment**: The bot cannot download the attached image. It replies with the generic service-unavailable message and does not expose technical details; the user only needs to know that it did not work.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST detect when an inbound Discord message contains one or more image attachments and treat that message as a shopping-list submission.
- **FR-002**: The system MUST retrieve the image content for each detected image attachment and submit it for text recognition using the configured OCR provider.
- **FR-003**: The system MUST return the recognized text to the originating conversation in the same order the OCR provider produced it, without reordering, sorting, merging, de-duplicating, extracting, summarizing, correcting, or otherwise altering the text.
- **FR-004**: When a message contains multiple image attachments, the system MUST treat them as a single shopping list and present recognized text in the order the attachments appear in the message.
- **FR-005**: The system MUST NOT use any AI/LLM interpretation, item extraction, categorization, quantity parsing, price parsing, or content cleanup at any point in v1; recognition is performed solely by the external OCR provider and its output is passed through. However, the recognized text MUST be exposed at a defined handoff boundary so that a future AI interpretation flow can consume it without reworking the recognition or transport logic.
- **FR-006**: The system MUST perform OCR through a provider-agnostic contract so that the active OCR provider can be selected or replaced by configuration without modifying the logic that detects images, orders results, or posts replies.
- **FR-007**: The system MUST support at least one initial OCR provider (Transkribus) and MUST allow additional providers to be added without changing user-facing behavior.
- **FR-008**: The system MUST read all OCR provider configuration (provider selection, credentials, model/endpoint settings) from environment variables; secrets MUST NOT be committed to the repository or written to logs.
- **FR-009**: The system MUST ensure that the recognized text it posts is identical to the OCR provider's output, except where the transport requires neutralization/sanitization of untrusted text (FR-012) or splitting across multiple messages (FR-010).
- **FR-010**: The system MUST handle recognized text that exceeds a single message length by splitting it across multiple messages while preserving line order and reading continuity; it MUST NOT silently truncate.
- **FR-011**: The system MUST reply in the same conversation in which the list image was sent, and a user's list MUST NOT be visible to any other user as a result of processing.
- **FR-012**: The system MUST treat recognized text as untrusted. It MUST neutralize any user mention, role mention, `@everyone`, or `@here` token before posting so the reply cannot trigger a mention notification, and MUST sanitize the text so it cannot be interpreted as commands or instructions by the bot or any downstream consumer, while leaving ordinary list text unchanged. The code that prepares recognition output for the user MUST carry a comment that when AI interpretation is added, the AI call MUST include a system prompt that prevents prompt-injection attacks.
- **FR-013**: When the OCR provider returns no readable text for a submission, the system MUST post a distinct, user-actionable message asking the user to try a different photo, rather than the generic service-unavailable message, an empty reply, or silence.
- **FR-014**: For every service-side failure — OCR provider unreachable, credentials missing/invalid, quota or credits exhausted, provider error, request exceeding the processing budget, or failure to retrieve the image attachment — the system MUST post the SAME single generic user-facing message (for example, "Service is not available, please try again later or contact the admin"), MUST NOT differentiate between causes or expose technical details, and MUST log the specific cause with a correlation identifier and without secrets.
- **FR-015**: When a submitted file is not a supported/readable image (unsupported format or corrupt content), the system MUST post a distinct message stating that the format is unsupported, rather than the generic service-unavailable message.
- **FR-016**: The system MUST process submissions independently and concurrently, so that one slow or failing OCR request does not block other users' submissions or the bot's overall responsiveness.
- **FR-017**: The system MUST log each OCR submission outcome with a correlation identifier (received, submitted, succeeded, failed, cancelled) with enough context to reproduce the outcome without the user; log entries MUST NOT contain image content or recognized list text.
- **FR-018**: The system MUST NOT persist shopping-list images or recognized list text beyond the duration needed to handle the submission; after the reply is posted, neither the image nor the text is retained by the system.
- **FR-019**: The system MUST allow the operator to restrict which Discord contexts (servers/channels) the bot processes list images in, so that it does not OCR images in unintended places.
- **FR-020**: The system MUST apply a bounded processing budget to each OCR request; when the budget is exceeded it MUST cancel the outstanding request and report the failure via the generic service-unavailable message per FR-014, leaving the bot responsive to further submissions.
- **FR-021**: The system MUST reject any image whose size exceeds a fixed, hardcoded size threshold before submitting it for OCR, and MUST post a distinct user-facing message that the image is too large.
- **FR-022**: When a message contains no image attachment in a context the bot processes, the system MUST reply with a fixed, hardcoded usage hint that includes telling the user to type `!help` for information on how to use the bot.
- **FR-023**: The system MUST NOT implement the deferred concerns in v1 (the `!help` command itself, context-aware or AI-powered guidance messages, and duplicate-submission de-duplication); instead, creating a tracked GitHub issue for each of them MUST be part of delivering this feature.

### Key Entities *(include if feature involves data)*

- **Shopping-List Submission**: A single inbound Discord message interpreted as a list, with one or more image attachments; attributes include originating user, conversation, correlation identifier, attachment order, and processing status. Short-lived; not persisted beyond handling.
- **List Image**: A single image attachment belonging to a submission; attributes include content type, size, retrieval status, and position within the submission. Transient.
- **Recognized List Text**: The ordered text returned by the OCR provider for one or more images; attributes include line sequence and originating image order. Transient; never modified.
- **OCR Provider**: An external text-recognition service behind the provider-agnostic contract; attributes include selection identity, credential reference, model/endpoint settings, and operational status. Replaceable without changing list-handling logic.
- **OCR Request/Result**: A single recognition attempt; attributes include input image, outcome class (success / input problem / service-side failure / cancelled) and specific outcome (no-readable-text, unsupported-format, image-too-large, unreachable, unauthorized, quota-exhausted, provider-error, budget-exceeded, unretrievable), returned text (on success), and error context. Transient.
- **Provider Configuration**: The environment-derived settings that choose and configure the active OCR provider; attributes are provider selection and provider-specific settings. Not persisted in source.
- **Deferred Work Item**: A concern deliberately excluded from v1 (the `!help` command, context-aware/AI-powered guidance, duplicate-submission de-duplication); attributes are title, rationale, and a link to the tracked GitHub issue. Tracked outside the system, created as part of this feature.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For a typical single-page handwritten list, the bot posts the recognized text in the originating conversation within 30 seconds of the user sending the image in at least 90% of attempts on a nominally loaded VPS, including any waiting for the external provider.
- **SC-002**: For every successful recognition, the text posted by the bot matches the OCR provider's returned text exactly (character-for-character, line-order-preserving) in 100% of cases, excluding only mention neutralization, instruction/injection sanitization, and multi-message splitting.
- **SC-003**: 100% of simulated service-side failures (unreachable, unauthorized, quota exhausted, provider error, timeout, unretrievable attachment) produce the same single generic user-facing message with no technical detail and no crash, stuck request, or silent drop.
- **SC-004**: Switching the active OCR provider is achievable by changing configuration and adding a provider implementation that honors the existing contract, with zero edits to image-detection, ordering, or reply-posting logic; verified by running the full user-facing flow against a stub provider.
- **SC-005**: Zero recognized list text, image content, or provider credentials appear in logs across the full submit → recognize → reply lifecycle, verified by a post-run scan of log output.
- **SC-006**: When two users submit lists concurrently, both receive their own recognized text in their own conversations within the same time bound as a single submission, and neither sees the other's content, in 100% of trials.
- **SC-007**: A list longer than one platform message is delivered completely, in order and without truncation, in 100% of cases, requiring no user action beyond reading the replies.
- **SC-008**: Each input problem (no readable text, unsupported format, image above the size threshold) produces its own distinct user-facing message, and in 100% of trials users can tell an input problem apart from a service-side failure; oversized images are rejected without any OCR provider call.
- **SC-009**: The three deferred concerns (the `!help` command, context-aware/AI-powered guidance, duplicate-submission de-duplication) are each tracked by a GitHub issue created as part of delivering this feature.

## Deferred Work *(tracked as GitHub issues)*

These concerns are deliberately excluded from v1. Creating a tracked GitHub issue for each is part of delivering this feature (FR-023, SC-009).

- **`!help` command**: A command that explains how to use the bot. v1 only mentions `!help` in the hardcoded usage hint; implementing the command itself is deferred.
- **Context-aware / AI-powered guidance**: Replacing the hardcoded usage hint (and possibly the generic error and no-text messages) with context-aware, AI-generated responses. When implemented, the AI call MUST carry a system prompt that prevents prompt-injection attacks.
- **Duplicate-submission de-duplication**: Detecting that the same image was sent more than once and avoiding redundant processing/replies.

## Assumptions

- **Trigger**: Sending an image attachment in a Discord context the bot is configured to watch is what triggers OCR; a text command prefix is not required for v1. Operators can restrict or disable the contexts in which the bot processes images (FR-019). A message without an image in such a context receives the hardcoded `!help` usage hint (FR-022). If a command-style invocation is preferred later, it can be layered on without changing recognition behavior.
- **One message = one list**: All image attachments within a single message are treated as one shopping list. Correlating multiple separate messages (e.g., pages sent as distinct messages) into one list is out of scope for v1.
- **Error taxonomy**: User-facing failures are split into exactly two classes. Service-side failures (unreachable, unauthorized, quota exhausted, provider error, budget exceeded, unretrievable attachment) all share one generic message because the user is neither the creator nor the admin; input problems (no readable text, unsupported format, image too large) each get a distinct, actionable message. The specific cause is always logged for the operator.
- **Image size threshold**: The maximum accepted image size is a fixed, hardcoded value chosen at implementation (default 10 MB) and is not operator-configurable in v1. Larger images are rejected before any OCR call.
- **Initial provider**: Transkribus is the first OCR provider. Its API requires credentials and is billed on a credit/page basis per its published pricing (https://www.transkribus.org/pricing); the operator is responsible for holding an account with sufficient credits. Provider selection and credentials are treated as configuration.
- **Recognition language/model**: The feature assumes a single configured handwriting model/language appropriate to the operator's lists. Selecting between multiple languages/models per request is out of scope for v1, though the provider contract may expose model settings.
- **List fidelity over accuracy**: The feature's promise is faithful pass-through of the provider's output, not guaranteed correctness against the handwriting. Because no AI correction is allowed, OCR misreads are returned as-is; improving accuracy is a matter of provider/model choice, not post-processing.
- **Privacy**: Shopping-list images and their recognized text are personal data. They are processed transiently and not persisted; only metadata (correlation identifiers, statuses, sizes) is logged. Existing project data-privacy rules apply.
- **Multi-user isolation**: Per the project constitution, submissions are user- and conversation-scoped from day one, even if the deployment serves a single person in practice.
- **Transport**: Discord is the only user-facing surface for v1; the recognition capability is defined independently of the transport so it can be reused by other surfaces later.
- **No preprocessing**: The bot does not rotate, crop, enhance, deskew, or otherwise modify images before OCR in v1; the image is submitted as received.
- **Out of scope**: AI/LLM interpretation or structuring of lists, OCR-error correction, list storage/history, item check-off, shopping-cart integration, de-duplication of repeated submissions, a working `!help` command, and multi-message list correlation are explicitly excluded from v1 (see Deferred Work).
- **Constitution alignment**: This feature depends on the constitution's external-dependency constraint (OCR abstracted behind a local interface) and simplicity/YAGNI constraint (no AI where deterministic OCR suffices); recognition is deterministic per the chosen provider.

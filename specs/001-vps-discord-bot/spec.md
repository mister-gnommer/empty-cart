# Feature Specification: VPS-Hosted Discord Bot Skeleton

**Feature Branch**: `001-vps-discord-bot`

**Created**: 2026-07-22

**Status**: Draft

**Input**: User description: "Create a Discord bot that can run reliably on my VPS. A Discord user can send a basic command and receive a response - initially and in this spec scope it can just echo users messages. The application must have configuration through environment variables, structured logs, graceful shutdown, a health check, and documented VPS deployment. Do not implement OCR, image processing, or AI-agent behaviour yet."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Send a Command and Get an Echo Response (Priority: P1)

A registered Discord user types the bot's basic command (e.g., an `echo <text>` style invocation) in a channel the bot can see. The bot responds in the same channel with the text the user supplied (or a clearly defined echo of the user's message content). This is the minimum viable interaction and the first independently testable slice.

**Why this priority**: Without a successful round-trip between user and bot, none of the operational qualities (logging, shutdown, health) can be exercised or observed. Echo is the thinnest slice that proves the bot is wired up and reachable.

**Independent Test**: Can be fully tested by sending the echo command in a real or sandboxed Discord channel and receiving the echoed text within a short, predictable window; delivers the value of "the bot hears and replies".

**Acceptance Scenarios**:

1. **Given** the bot is running and online in a Discord server, **When** a user sends the echo command with any arbitrary text payload, **Then** the bot posts a reply in the same channel whose content is that echoed payload (i.e., the response is derived from the user's input, not a fixed or hardcoded message).
2. **Given** the bot is running, **When** a user sends the echo command with no text argument, **Then** the bot replies with a short, user-facing usage hint instead of crashing.
3. **Given** the bot is running, **When** a user sends the echo command containing text that exceeds Discord's message length limit, **Then** the bot replies with a clear user-facing error message explaining that the input is too long, rather than truncating silently or panicking.

---

### User Story 2 - Operator Runs the Bot Reliably on a VPS (Priority: P2)

A single operator deploys the bot to a personal VPS, starts it as a managed background service, and relies on it to run unattended for long periods. The operator configures it via environment variables (Discord token, log level, etc.) without editing source files. The bot stays up under normal load and, when it must stop, it stops cleanly so the service manager can restart it deterministically.

**Why this priority**: Reliability and operability are the explicit reason for this feature; an echo bot that dies silently or can't be configured would be useless on a VPS. However, it ranks below P1 because it only matters once any interaction works at all.

**Independent Test**: Can be tested by installing the bot as a managed background service on the target VPS using the platform's native process supervisor, confirming it reads its configuration from environment variables, survives a routine restart, and shuts down within a bounded time on a normal stop signal without leaving orphaned connections or unflushed logs.

**Acceptance Scenarios**:

1. **Given** the bot package is installed on the VPS and its service file is registered, **When** the operator runs the start command with all required environment variables set, **Then** the bot connects to Discord and begins responding to the echo command without manual code edits.
2. **Given** the bot is running, **When** required environment variables are missing or malformed on startup, **Then** the bot refuses to start and emits a single clear structured log entry naming the missing/malformed variable, then exits with a non-zero status.
3. **Given** the bot is running, **When** the operator issues a normal stop signal (SIGTERM) to the process, **Then** the bot finishes in-flight work within a bounded time window, closes its Discord connection cleanly, flushes buffered logs, and exits with status 0.

---

### User Story 3 - Operator Verifies the Bot Is Healthy (Priority: P3)

The operator wants a fast, side-effect-free way to confirm the bot process is alive and its internal state is healthy, both manually (during debugging) and programmatically (for a monitoring/service-manager health probe). The health check must not depend on Discord being reachable, so it can distinguish "my bot is dead" from "Discord is having an outage".

**Why this priority**: A health probe is what makes the deployment "reliable" rather than merely "running"; it lets the service manager auto-restart on real failure and lets the operator triage quickly. It's P3 because it is an operator-only quality that builds on P1/P2.

**Independent Test**: Can be tested by querying the health endpoint (or running the health CLI) while the bot is running and observing a structured "healthy" status; then by killing a critical internal subsystem (if any) and observing a "degraded/unhealthy" status without triggering a Discord round-trip.

**Acceptance Scenarios**:

1. **Given** the bot is running and its internal state is sound, **When** the operator queries the health check, **Then** a machine-readable healthy status is returned within a short bounded time.
2. **Given** the bot is running but is not yet connected to Discord (or the connection was lost), **When** the operator queries the health check, **Then** the status distinguishes "process healthy, Discord disconnected" from "process unhealthy" so the operator knows whether to restart the bot.
3. **Given** the bot process has been asked to shut down, **When** the operator queries the health check during shutdown, **Then** it returns a shutting-down status (or refuses the query in a predictable way) rather than a stale healthy status.

---

### Edge Cases

- What happens when the Discord gateway goes down mid-session while the bot is still process-healthy? The health check should reflect "process healthy, Discord disconnected"; the bot should not crash and should attempt to reconnect per Discord gateway guidance.
- What happens when the bot receives a command message that is technically valid but from a user without permission (e.g., a spam/abuse case)? Out of scope for v1: no per-user authorization model is required beyond Discord's own channel/server permissions. See Assumptions.
- What happens when two stop signals arrive in quick succession? The second should be ignored or logged idempotently; the bot must not restart mid-shutdown.
- What happens when structured logging output is unavailable (e.g., log destination is not writable at startup)? The bot should refuse to start with a clear log entry rather than silently dropping logs.
- What happens when the echo text contains Discord formatting characters (mentions, markdown)? v1 echoes the visible text content as received; no sanitization or special interpretation is in scope beyond what is needed to avoid the bot mentioning/ghost-pinging unintended users via user-supplied content (handled as a minimal safety measure, not a feature).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide a Discord command that, when sent by a user with text content, causes the bot to post a reply in the same channel returning that text content as the user saw it.
- **FR-002**: The system MUST read all runtime configuration (including the Discord token and log level) from environment variables; reading secrets or configuration from committed files is forbidden.
- **FR-003**: The system MUST refuse to start when any required environment variable is missing or malformed, emitting exactly one structured log entry that identifies the offending variable, and MUST exit with a non-zero status.
- **FR-004**: The system MUST emit structured logs (machine-parseable, with at minimum a timestamp, severity, message, and a correlation identifier for each user-initiated action) for startup, every handled user command, connection state changes, shutdown trigger, and shutdown completion.
- **FR-005**: The system MUST treat the Discord token and any other secret as never-loggable; if a secret would otherwise be logged, it MUST be redacted or omitted.
- **FR-006**: The system MUST handle SIGTERM (and SIGINT as a developer convenience) by ceasing to accept new work, completing in-flight work within a bounded shutdown budget, closing the Discord connection cleanly, flushing logs, and exiting with status 0.
- **FR-007**: The system MUST expose a health check that runs without any side effects and does not perform a Discord round-trip; it MUST distinguish at minimum between "process healthy", "process healthy but Discord not connected", and "process unhealthy/shutting down".
- **FR-008**: The system MUST persist no user data in scope v1 and MUST NOT retain echo command payloads after the command has been handled and logged (logs contain what is needed for observability per Principle III, never the raw secret content of messages beyond what is required to reconstruct the run).
- **FR-009**: The system MUST be operable by a single person on one VPS using only the target OS's native process supervisor (e.g., systemd) and the bundled deployment documentation; it MUST NOT require a cluster or managed services.
- **FR-010**: The system MUST ship a deployment document (checked into the repo) covering environment-variable configuration, installing as a managed background service, starting, stopping, viewing logs, and verifying health.
- **FR-011**: The system MUST report a clear user-facing error (in the originating channel) when the bot cannot fulfill a command due to an internal problem, rather than failing silently or crashing.
- **FR-012**: The system MUST auto-reconnect to the Discord gateway after transient connection loss without operator intervention, and MUST log each reconnect attempt with a correlation identifier.

### Key Entities *(include if feature involves data)*

- **Bot Process**: The long-running service instance; attributes include running/stopping state, time-boundable shutdown budget, and active/last-known Discord gateway state. No persisted data.
- **User Command**: A single user-initiated inbound message matching the echo command; attributes include the originating user, channel, visible text payload, and a correlation identifier. Short-lived; not persisted beyond the log record.
- **Health Status**: A machine-readable snapshot of the process's internal state; attributes include process liveness, shutdown phase, and Discord connection state. Produced on demand, not persisted.
- **Configuration**: The set of environment variables the bot consumes at startup; attributes are the variable names, required/optional flags, and validation rules. Not persisted in source.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: From the moment a user sends the echo command, the bot's reply appears in the same channel in under 2 seconds on a normally loaded VPS.
- **SC-002**: The bot, once started, runs unattended for at least 7 consecutive days with no operator intervention beyond routine OS-level maintenance, while remaining responsive to the echo command.
- **SC-003**: On receipt of a stop signal, the bot completes shutdown — including closing the Discord connection and flushing all buffered logs — within 5 seconds and with exit status 0, in at least 95% of trials.
- **SC-004**: The health check responds with a valid machine-readable status within 1 second and, when queried repeatedly every 10 seconds for 1 hour during normal operation, returns a healthy status 100% of the time.
- **SC-005**: A single operator with no prior experience of this codebase can install, configure, start, verify health, and gracefully stop the bot on the target VPS within 30 minutes using only the bundled deployment documentation.
- **SC-006**: Zero secrets (Discord token or otherwise) appear in any log entry across the full startup → echo-handling → shutdown lifecycle, as verified by a post-run scan of the log output.

## Assumptions

- Target operating environment is a single personal VPS running Linux with systemd as the process supervisor; that is the only deployment shape that must be documented for v1. Other operating systems are out of scope.
- The bot's echo functionality is the only user-facing command in v1; no authorization, per-user state, or multi-command router is required by this spec (the Constitution's "multi-user from day one" rule is honored at the module-contract level — see Module-by-Module — and does not require user-facing multi-user features in v1).
- "Echo the user's message" means returning the visible text content of the single inbound message that matched the echo command, in-band in the same channel. Interactive state, attachments, images, embeds, and reaction-based UX are out of scope for v1 and explicitly excluded by the user description.
- The operator has a Discord application/bot token already issued and has the right to invite the bot to one or more test servers; Discord account/server provisioning is not part of this feature.
- A "structured log" is one whose fields (timestamp, severity, message, correlation id, and any additional context) can be parsed unambiguously by standard tooling (e.g., JSON or another documented structured format). Free-text lines are not sufficient.
- The "bounded shutdown budget" referenced in FR-006 and SC-003 is, by default, 5 seconds; the deployment documentation must state this and explain how it maps to the service manager's timeout configuration.
- Per the project Constitution (Principle II), the user-facing transport (Discord adapter) is treated as one self-contained module with a declared contract, and the health check and configuration loader are each their own module, so they can be tested independently of Discord. The spec stays technology-agnostic about how that contract is expressed.
- Per the project Constitution language policy, implementation will use TypeScript; this is a project-level constraint recorded here for the planning phase, not an implementation detail that the spec depends on.
- The "Do not implement OCR, image processing, or AI-agent behaviour" constraint from the user description is treated as an explicit scope exclusion for v1 and is listed in Edge Cases / Out-of-Scope; any future feature of that kind will require its own spec and Constitution Check.
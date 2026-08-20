// handleEchoCommand — pure function. No I/O, no logger, no module-scoped
// mutable state. The discord adapter owns
// logging and the send call (with allowedMentions).
import type { Config, EchoResult } from '../shared/types';

export function handleEchoCommand(
  cmd: { args: string },
  config: Pick<Config, 'echoMaxLength' | 'commandPrefix' | 'echoCommandName'>,
): EchoResult {
  const args = cmd.args;

  // Empty / whitespace-only → usage-hint with the canonical normative string.
  if (args.trim().length === 0) {
    return {
      status: 'usage-hint',
      reply: `Usage: ${config.commandPrefix}${config.echoCommandName} <text>`,
    };
  }

  // Too-long → user-facing error with the canonical normative string. The
  // zero-byte-trim is NOT applied on the too-long test — args is compared
  // verbatim against the active echoMaxLength.
  if (args.length > config.echoMaxLength) {
    return {
      status: 'too-long',
      reply: `Input too long (max ${config.echoMaxLength} chars).`,
    };
  }

  // Otherwise echo args verbatim (zero-byte-trim allowed; no other
  // normalization — the payload is otherwise byte-equal to cmd.args). The
  // transportShouldNeutralizeMentions directive tells the transport adapter
  // to send with mentions neutralized (allowedMentions empty-parse) so this
  // reply can never ghost-ping — the echo core stays pure and never inspects
  // payloads.
  return {
    status: 'echoed',
    reply: args,
    transportShouldNeutralizeMentions: true,
  };
}

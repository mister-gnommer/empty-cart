// Pure reply splitter for the 2000-char transport limit. Line-boundary
// splits add nothing (chunk concatenation reconstructs the original
// byte-for-byte); a mid-line cut is made explicit with a single-character
// continuation marker on both sides — transport-added content, exempt from
// byte fidelity.

const CONTINUATION_MARKER = '…';

// 🤖 AI-start
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
// 🤖 AI-end

export function splitReply(text: string, limit = 2000): string[] {
  // 🤖 AI-start
  if (limit < 4) {
    // A continuation chunk must fit both marker sides plus one content char
    // even after backing off a surrogate pair, otherwise the mid-line path
    // cannot shrink the remainder.
    throw new RangeError('splitReply: limit must be at least 4');
  }
  // 🤖 AI-end
  if (text.length <= limit) {
    return [text];
  }
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const lastNewline = window.lastIndexOf('\n');
    if (lastNewline > 0) {
      // Prefer the LAST line boundary inside the window; a newline at window
      // position 0 does not count (it would produce an empty chunk).
      chunks.push(rest.slice(0, lastNewline + 1));
      rest = rest.slice(lastNewline + 1);
    } else {
      // 🤖 AI-start
      // Never cut between the halves of a surrogate pair (e.g. an emoji).
      const cut = isHighSurrogate(window.charCodeAt(limit - 2)) ? limit - 2 : limit - 1;
      chunks.push(`${window.slice(0, cut)}${CONTINUATION_MARKER}`);
      rest = `${CONTINUATION_MARKER}${rest.slice(cut)}`;
      // 🤖 AI-end
    }
  }
  chunks.push(rest);
  return chunks;
}

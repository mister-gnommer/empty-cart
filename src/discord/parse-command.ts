// Pure prefix-command parser: splits `<prefix><name> <args>` into a
// lowercased command name and its argument text.

export interface ParsedCommand {
  name: string;
  args: string;
}

/**
 * Parses a prefixed command from raw message text. The name ends at the first
 * whitespace and is lowercased; args are the rest with leading whitespace
 * dropped.
 * @param content raw message text
 * @param prefix configured command prefix
 * @returns the parsed command, or null when the text does not start with the prefix
 */
export function parseCommand(content: string, prefix: string): ParsedCommand | null {
  if (!content.startsWith(prefix)) {
    return null;
  }
  const afterPrefix = content.slice(prefix.length);
  const spaceIdx = afterPrefix.search(/\s/u);
  if (spaceIdx === -1) {
    return { name: afterPrefix.toLowerCase(), args: '' };
  }
  return {
    name: afterPrefix.slice(0, spaceIdx).toLowerCase(),
    args: afterPrefix.slice(spaceIdx + 1).trimStart(),
  };
}

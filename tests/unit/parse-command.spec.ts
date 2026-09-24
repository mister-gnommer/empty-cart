import { describe, expect, it } from 'vitest';
import { parseCommand } from '../../src/discord/parse-command';

describe('parseCommand', () => {
  it('returns null when the text does not start with the prefix', () => {
    expect(parseCommand('echo hi', '!')).toBeNull();
  });

  it('splits name and args at the first whitespace', () => {
    expect(parseCommand('!echo hello world', '!')).toEqual({ name: 'echo', args: 'hello world' });
  });

  it('lowercases the name but leaves args untouched', () => {
    expect(parseCommand('!ECHO Hello', '!')).toEqual({ name: 'echo', args: 'Hello' });
  });

  it('yields empty args for a bare command', () => {
    expect(parseCommand('!echo', '!')).toEqual({ name: 'echo', args: '' });
  });

  it('drops leading whitespace from args but keeps trailing whitespace', () => {
    expect(parseCommand('!echo \t  hi  ', '!')).toEqual({ name: 'echo', args: 'hi  ' });
  });

  it('treats a newline as the name terminator', () => {
    expect(parseCommand('!echo\nline', '!')).toEqual({ name: 'echo', args: 'line' });
  });

  it('supports multi-character prefixes', () => {
    expect(parseCommand('>>echo x', '>>')).toEqual({ name: 'echo', args: 'x' });
  });

  it('yields an empty name for the prefix alone', () => {
    expect(parseCommand('!', '!')).toEqual({ name: '', args: '' });
  });
});

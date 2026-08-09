import { describe, expect, it } from 'vitest';
import { handleEchoCommand } from '../../src/echo/handle-echo';
import type { Config } from '../../src/shared/types';

const baseConfig: Pick<Config, 'echoMaxLength' | 'commandPrefix' | 'echoCommandName'> = {
  echoMaxLength: 1900,
  commandPrefix: '!',
  echoCommandName: 'echo',
};

describe('handleEchoCommand', () => {
  it('returns usage-hint with canonical reply on empty args', () => {
    const result = handleEchoCommand({ args: '' }, baseConfig);
    expect(result).toEqual({
      status: 'usage-hint',
      reply: 'Usage: !echo <text>',
    });
  });

  it('returns usage-hint with canonical reply on whitespace-only args', () => {
    const result = handleEchoCommand({ args: '   \t\n  ' }, baseConfig);
    expect(result).toEqual({
      status: 'usage-hint',
      reply: 'Usage: !echo <text>',
    });
  });

  it('reflects the active config prefix/command name in the usage hint', () => {
    const result = handleEchoCommand(
      { args: '   ' },
      { ...baseConfig, commandPrefix: '?', echoCommandName: 'say' },
    );
    expect(result).toEqual({
      status: 'usage-hint',
      reply: 'Usage: ?say <text>',
    });
  });

  it('echoes args verbatim at the echoMaxLength boundary', () => {
    const text = 'a'.repeat(1900);
    const result = handleEchoCommand({ args: text }, baseConfig);
    expect(result).toEqual({
      status: 'echoed',
      reply: text,
    });
  });

  it('echoes args verbatim, preserving leading and trailing whitespace', () => {
    const text = '  padded  ';
    const result = handleEchoCommand({ args: text }, baseConfig);
    expect(result).toEqual({
      status: 'echoed',
      reply: text,
    });
  });

  it('returns too-long with canonical reply at echoMaxLength + 1', () => {
    const text = 'a'.repeat(1901);
    const result = handleEchoCommand({ args: text }, baseConfig);
    expect(result).toEqual({
      status: 'too-long',
      reply: 'Input too long (max 1900 chars).',
    });
  });

  it('reflects the active echoMaxLength in the too-long reply', () => {
    const text = 'a'.repeat(101);
    const result = handleEchoCommand({ args: text }, { ...baseConfig, echoMaxLength: 100 });
    expect(result).toEqual({
      status: 'too-long',
      reply: 'Input too long (max 100 chars).',
    });
  });

  it.each(['<@123>', '@everyone', '<@&9>', '@here', '@user', '**bold**', '||spoiler||', '>quote'])(
    'echoes mention/markdown payload %s verbatim',
    (payload) => {
      const result = handleEchoCommand({ args: payload }, baseConfig);
      expect(result).toEqual({
        status: 'echoed',
        reply: payload,
      });
    },
  );

  it('produces independent outputs for consecutive calls with different args', () => {
    const firstText = 'first payload';
    const secondText = 'second payload';
    const first = handleEchoCommand({ args: firstText }, baseConfig);
    const second = handleEchoCommand({ args: secondText }, baseConfig);
    expect(first).toEqual({
      status: 'echoed',
      reply: 'first payload',
    });
    expect(second).toEqual({
      status: 'echoed',
      reply: 'second payload',
    });
  });
});

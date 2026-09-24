import { describe, expect, it } from 'vitest';
import { LIST_MESSAGES, usageHintMessage } from '../../src/shopping-list/messages';

describe('LIST_MESSAGES', () => {
  it('serviceUnavailable is the canonical string byte-for-byte', () => {
    expect(LIST_MESSAGES.serviceUnavailable).toBe(
      'Service is not available, please try again later or contact the admin.',
    );
  });

  it('noReadableText is the canonical string byte-for-byte', () => {
    expect(LIST_MESSAGES.noReadableText).toBe(
      "I couldn't read any text — can you try a different photo?",
    );
  });

  it('unsupportedFormat is the canonical string byte-for-byte', () => {
    expect(LIST_MESSAGES.unsupportedFormat).toBe(
      'Sorry, that file format is not supported — please send a JPEG, PNG, or WEBP photo.',
    );
  });

  it('imageTooLarge is the canonical string byte-for-byte', () => {
    expect(LIST_MESSAGES.imageTooLarge).toBe(
      'That image is too large — please send a photo under 7 MB.',
    );
  });

  it('busy is the canonical string byte-for-byte', () => {
    expect(LIST_MESSAGES.busy).toBe(
      'I am still working on your previous list — please wait for it to finish before sending another.',
    );
  });

  it('is frozen', () => {
    expect(Object.isFrozen(LIST_MESSAGES)).toBe(true);
  });
});

describe('usageHintMessage', () => {
  it('returns the canonical hint naming the help command for the configured prefix', () => {
    expect(usageHintMessage('!')).toBe(
      'Send a photo of your shopping list and I will reply with the recognized text. Type !help for information on how to use the bot.',
    );
  });

  it('interpolates a custom prefix verbatim', () => {
    expect(usageHintMessage('$$')).toBe(
      'Send a photo of your shopping list and I will reply with the recognized text. Type $$help for information on how to use the bot.',
    );
  });
});

// Canonical user-facing strings for the shopping-list flow. These are
// byte-stable: replies are built ONLY from these constants (plus the usage
// hint below), and tests assert exact equality — never rephrase them without
// updating the tests. All are far below Discord's 2000-char limit and are
// never split.

type ListMessages = {
  readonly serviceUnavailable: 'Service is not available, please try again later or contact the admin.';
  readonly noReadableText: "I couldn't read any text — can you try a different photo?";
  readonly unsupportedFormat: 'Sorry, that file format is not supported — please send a JPEG, PNG, or WEBP photo.';
  readonly imageTooLarge: 'That image is too large — please send a photo under 7 MB.';
  readonly busy: 'I am still working on your previous list — please wait for it to finish before sending another.';
};

export const LIST_MESSAGES: ListMessages = Object.freeze({
  serviceUnavailable: 'Service is not available, please try again later or contact the admin.',
  noReadableText: "I couldn't read any text — can you try a different photo?",
  unsupportedFormat:
    'Sorry, that file format is not supported — please send a JPEG, PNG, or WEBP photo.',
  imageTooLarge: 'That image is too large — please send a photo under 7 MB.',
  busy: 'I am still working on your previous list — please wait for it to finish before sending another.',
});

/** Hint sent in reply to a message without an image in a processed channel. */
export function usageHintMessage(commandPrefix: string): string {
  return `Send a photo of your shopping list and I will reply with the recognized text. Type ${commandPrefix}help for information on how to use the bot.`;
}

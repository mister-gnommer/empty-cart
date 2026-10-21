import { describe, expect, it } from 'vitest';
import { SUBMISSION_BUDGET_MS } from '../../src/shopping-list/handle-list-submission';
import { att, buildHandler, okFetch, submission } from '../helpers/list-submission-env';
import { okResult } from '../helpers/stub-ocr-provider';

const PAGE_TEXT = '  Milk \n\nEggs\tx2\nżółć\n';

describe('orchestrator happy path', () => {
  it('single image: the provider gets the downloaded image, configured hints and the full budget; the reply is the page text byte-for-byte', async () => {
    const env = buildHandler({
      script: [okResult(PAGE_TEXT)],
      fetch: [okFetch('png', [1, 2, 3])],
      languageHints: ['en', 'de'],
    });
    const reply = await env.handler(submission());
    expect(reply).toEqual({ text: PAGE_TEXT });
    expect(env.provider.calls).toEqual([
      {
        bytes: new Uint8Array([1, 2, 3]),
        format: 'png',
        languageHints: ['en', 'de'],
        timeoutMs: SUBMISSION_BUDGET_MS,
      },
    ]);
  });

  it('three images: downloaded and recognized in attachment order, page texts joined by a single newline', async () => {
    const env = buildHandler({
      script: [okResult('A'), okResult('B'), okResult('C')],
      fetch: [okFetch('jpeg'), okFetch('png'), okFetch('webp')],
    });
    const reply = await env.handler(
      submission({}, [
        att({ url: 'https://cdn.test/1.jpg' }),
        att({ url: 'https://cdn.test/2.png' }),
        att({ url: 'https://cdn.test/3.webp' }),
      ]),
    );
    expect(reply.text).toBe('A\nB\nC');
    expect(env.fetchInputs.map((i) => i.url)).toEqual([
      'https://cdn.test/1.jpg',
      'https://cdn.test/2.png',
      'https://cdn.test/3.webp',
    ]);
    // Distinct formats per download prove each provider call got its own image, in order.
    expect(env.provider.calls.map((c) => c.format)).toEqual(['jpeg', 'png', 'webp']);
  });
});

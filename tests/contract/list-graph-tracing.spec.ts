// Tracing contract: whatever callbacks the handler is given see one root run
// per submission, tagged with its correlation id, with one child run per
// graph step, and the agent's model call nested under `categorize`.
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { fakeModel } from 'langchain';
import { describe, expect, it } from 'vitest';
import { createAgentCategorizer } from '../../src/categorizer/agent-categorizer';
import type { ItemCategorizer } from '../../src/categorizer/types';
import { buildHandler, okFetch, submission } from '../helpers/list-submission-env';
import { createStubCategorizer, failedAnswer, okAnswer } from '../helpers/stub-categorizer';
import { okResult } from '../helpers/stub-ocr-provider';

type RecordedRun = {
  kind: 'chain' | 'chat-model';
  name: string | undefined;
  runId: string;
  parentRunId: string | undefined;
  metadata: Record<string, unknown> | undefined;
};

/** Records every chain and chat-model run start it sees, and every chain's inputs and outputs. */
class RecordingHandler extends BaseCallbackHandler {
  name = 'recording-handler';
  readonly runs: RecordedRun[] = [];
  /** Inputs, outputs and metadata as JSON, i.e. what a tracer would upload. */
  readonly payloads: string[] = [];

  constructor() {
    // Run the hooks inline: by default LangChain fires callbacks in the
    // background, after invoke has already returned.
    super({ _awaitHandler: true });
  }

  // Parameter names follow the order LangChain actually calls with; its
  // declared signature names positions 4/7/8 runType/runName/parentRunId.
  handleChainStart(
    _chain: unknown,
    inputs: unknown,
    runId: string,
    parentRunId?: string,
    _tags?: string[],
    metadata?: Record<string, unknown>,
    _runType?: string,
    runName?: string,
  ): void {
    this.runs.push({ kind: 'chain', name: runName, runId, parentRunId, metadata });
    this.payloads.push(JSON.stringify({ inputs, metadata }));
  }

  handleChainEnd(outputs: unknown): void {
    this.payloads.push(JSON.stringify(outputs));
  }

  handleChatModelStart(
    _llm: unknown,
    _messages: unknown,
    runId: string,
    parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    _tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ): void {
    this.runs.push({ kind: 'chat-model', name: runName, runId, parentRunId, metadata });
  }
}

/**
 * Runs one submission whose photo reads "milk\napples" through the handler.
 * @param categorizer the categorizer the graph calls
 * @param callbacks what the handler passes to the graph
 */
async function submit(categorizer: ItemCategorizer, callbacks: BaseCallbackHandler[]) {
  const env = buildHandler({
    script: [okResult('milk\napples')],
    fetch: [okFetch()],
    categorizer,
    callbacks,
  });
  return env.handler(submission({ correlationId: 'corr-trace' }));
}

/**
 * The names of the direct children of the run named `parentName`.
 * @param runs recorded runs
 * @param parentName run name of the parent
 */
function childrenOf(runs: RecordedRun[], parentName: string): (string | undefined)[] {
  const parent = runs.find((r) => r.name === parentName);
  return runs.filter((r) => parent && r.parentRunId === parent.runId).map((r) => r.name);
}

describe('list run tracing', () => {
  it('a sorted run → one list-submission root tagged with the correlation id, one child per step', async () => {
    const recorder = new RecordingHandler();
    await submit(createStubCategorizer([okAnswer(['dairy-eggs', 'produce'])]), [recorder]);

    const roots = recorder.runs.filter((r) => r.parentRunId === undefined);
    expect(roots.map((r) => r.name)).toEqual(['list-submission']);
    expect(roots[0].metadata).toMatchObject({ correlationId: 'corr-trace' });
    expect(childrenOf(recorder.runs, 'list-submission')).toEqual(
      expect.arrayContaining(['recognize', 'categorize', 'sort']),
    );
  });

  it('no run holds the photo URL, which would open the photo until it expires', async () => {
    const recorder = new RecordingHandler();
    await submit(createStubCategorizer([okAnswer(['dairy-eggs', 'produce'])]), [recorder]);
    expect(recorder.payloads.length).toBeGreaterThan(0);
    expect(recorder.payloads.join('\n')).not.toContain(submission().attachments[0].url);
  });

  it('a fallback run → the unsorted step is traced instead of sort', async () => {
    const recorder = new RecordingHandler();
    await submit(createStubCategorizer([failedAnswer('error')]), [recorder]);
    const steps = childrenOf(recorder.runs, 'list-submission');
    expect(steps).toContain('unsorted');
    expect(steps).not.toContain('sort');
  });

  it('no callbacks → the run still succeeds', async () => {
    const reply = await submit(createStubCategorizer([okAnswer(['dairy-eggs', 'produce'])]), []);
    expect(reply.text).toBe('**Fruit & vegetables**\napples\n\n**Dairy & eggs**\nmilk');
  });

  it("the agent's model call is nested inside the categorize step", async () => {
    const recorder = new RecordingHandler();
    const chatModel = fakeModel().respondWithTools([
      {
        name: 'extract-1',
        args: {
          assignments: [
            { line: 1, category: 'dairy-eggs' },
            { line: 2, category: 'produce' },
          ],
        },
        id: 'call-1',
      },
    ]);
    const categorizer = await createAgentCategorizer({
      model: 'anthropic:fake',
      apiKey: 'unused',
      baseUrl: null,
      chatModel,
    });
    await submit(categorizer, [recorder]);

    const categorize = recorder.runs.find((r) => r.name === 'categorize');
    const modelRun = recorder.runs.find((r) => r.kind === 'chat-model');
    expect(categorize).toBeDefined();
    expect(modelRun).toBeDefined();
    // Walk up from the model run: the categorize step must be an ancestor.
    const byId = new Map(recorder.runs.map((r) => [r.runId, r]));
    let cursor = modelRun;
    const ancestors: (string | undefined)[] = [];
    while (cursor?.parentRunId !== undefined) {
      cursor = byId.get(cursor.parentRunId);
      ancestors.push(cursor?.name);
    }
    expect(ancestors).toContain('categorize');
    expect(ancestors.at(-1)).toBe('list-submission');
  });
});

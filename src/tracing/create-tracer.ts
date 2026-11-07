// Step tracing to LangSmith. The only module that talks to the langsmith
// client. Traces carry list text, which is why tracing is a config switch
// (on by default only for the test period, issue #16).
import type { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { LangChainTracer } from '@langchain/core/tracers/tracer_langchain';
import { Client } from 'langsmith';
import type { TracingConfig } from '../shared/types';

export type Tracer = {
  /** Callbacks to pass to a run; empty when tracing is off. */
  callbacks: BaseCallbackHandler[];
  /** Waits until traces queued so far have been sent. */
  flush(): Promise<void>;
};

/**
 * Builds the tracer for the configured mode. Passing the tracer explicitly,
 * instead of setting LANGSMITH_TRACING, keeps tracing a per-run decision and
 * avoids a second, implicit tracer.
 * @param config the tracing config; `off` gives an inert tracer
 */
export function createTracer(config: TracingConfig): Tracer {
  if (config.kind === 'off') {
    return { callbacks: [], flush: async () => undefined };
  }
  // learn: the LangSmith Client holds the API key and batches trace uploads in the background
  const client = new Client({ apiKey: config.apiKey });
  // learn: LangChainTracer is a callback handler: every run it is passed to (and every child run) is recorded and sent to the project
  const tracer = new LangChainTracer({ client, projectName: config.project });
  return {
    callbacks: [tracer],
    // learn: uploads are batched asynchronously, so pending batches must be awaited before the process exits or they are lost
    flush: () => client.awaitPendingTraceBatches(),
  };
}

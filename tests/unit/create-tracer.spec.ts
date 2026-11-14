import { LangChainTracer } from '@langchain/core/tracers/tracer_langchain';
import { describe, expect, it } from 'vitest';
import { createTracer } from '../../src/tracing/create-tracer';

describe('createTracer', () => {
  it('langsmith → one LangSmith tracer writing to the configured project', async () => {
    const tracer = createTracer({ kind: 'langsmith', apiKey: 'ls-test', project: 'my-project' });
    expect(tracer.callbacks).toHaveLength(1);
    const [handler] = tracer.callbacks;
    expect(handler).toBeInstanceOf(LangChainTracer);
    expect(handler instanceof LangChainTracer && handler.projectName).toBe('my-project');
    await expect(tracer.flush()).resolves.toBeUndefined();
  });

  it.each(['disabled', 'missing-key'] as const)('off (%s) → no callbacks', async (reason) => {
    const tracer = createTracer({ kind: 'off', reason });
    expect(tracer.callbacks).toEqual([]);
    await expect(tracer.flush()).resolves.toBeUndefined();
  });
});

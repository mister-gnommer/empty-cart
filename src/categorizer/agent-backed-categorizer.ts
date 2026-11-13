// The LangChain agent behind the categorizer interface. The only module that
// touches the model; it returns raw answers, and the caller checks them.
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createAgent, initChatModel } from 'langchain';
import type { z } from 'zod';
import { CategorizerAnswer } from './categorizer-answer-schema';
import { buildSystemPrompt, buildUserMessage } from './categorizer-prompt';
import type { CategorizeRequest, CategorizeResult, ItemCategorizer } from './types';

/**
 * Wraps the model in the tool-less agent that answers with the categorizer schema.
 * @param model the chat model the agent calls
 */
function buildAgent(model: BaseChatModel) {
  return createAgent({
    model,
    tools: [],
    systemPrompt: buildSystemPrompt(),
    responseFormat: CategorizerAnswer,
  });
}
type CategorizerAgent = ReturnType<typeof buildAgent>;

// LangChain re-asks the model after every schema failure with no limit of its
// own. With no tools or middleware, each graph step is one model call, so this
// allows three calls (two retries). Adding tools or middleware changes that
// count; the contract tests pin it. modelCallLimitMiddleware can't cap it in
// langchain 1.6.0: its fixed edge runs in parallel with the retry's jump back.
const MAX_MODEL_CALLS = 3;

/**
 * One agent run; maps every outcome to a CategorizeResult and never throws.
 * @param agent the agent built once per categorizer
 * @param request the lines to categorize and the budget signal
 */
async function categorizeWithAgent(
  agent: CategorizerAgent,
  { items, signal }: CategorizeRequest,
): Promise<CategorizeResult> {
  try {
    const result = await agent.invoke(
      { messages: [{ role: 'user', content: buildUserMessage(items) }] },
      { signal, recursionLimit: MAX_MODEL_CALLS },
    );
    const answer: z.infer<typeof CategorizerAnswer> | undefined = result.structuredResponse;
    if (answer === undefined) {
      return { status: 'failed', cause: 'invalid-answer' };
    }
    return { status: 'ok', assignments: answer.assignments };
  } catch (err) {
    // The budget signal is the only thing that aborts a call, so any
    // failure after it fired is the budget's doing, whatever was thrown.
    if (signal.aborted) {
      return { status: 'failed', cause: 'timeout' };
    }
    // By name: only src/shopping-list may import LangGraph, which defines the class.
    if (err instanceof Error && err.name === 'GraphRecursionError') {
      return { status: 'failed', cause: 'invalid-answer' };
    }
    return {
      status: 'failed',
      cause: 'error',
      // The class, not `err.name`: provider SDK errors may all share the name "Error" (Anthropic's do).
      errorName: err instanceof Error ? err.constructor.name : typeof err,
    };
  }
}

// The supported providers, and how each provider package takes a custom
// endpoint: each one names that option differently, and this is the one place
// that knows. initChatModel picks the package from the `provider:` prefix.
const ENDPOINT_OPTIONS: ReadonlyMap<string, (baseUrl: string) => Record<string, string>> = new Map([
  ['anthropic', (baseUrl: string) => ({ anthropicApiUrl: baseUrl })],
]);

/**
 * Builds the model and the agent once; each `categorize` call is one agent run.
 * Rejects a model string whose provider is not supported.
 * @param opts model string (`provider:name`), API key, optional base URL (e.g.
 *   a gateway), and a ready model that replaces initChatModel in tests
 */
export async function createAgentBackedCategorizer(opts: {
  model: string;
  apiKey: string;
  baseUrl: string | null;
  chatModel?: BaseChatModel;
}): Promise<ItemCategorizer> {
  const provider = opts.model.split(':', 1)[0];
  const endpointOptions = ENDPOINT_OPTIONS.get(provider);
  if (endpointOptions === undefined) {
    throw new Error(`unsupported model provider "${provider}"`);
  }
  const model =
    opts.chatModel ??
    (await initChatModel(opts.model, {
      apiKey: opts.apiKey,
      maxRetries: 1,
      ...(opts.baseUrl === null ? {} : endpointOptions(opts.baseUrl)),
    }));
  const agent = buildAgent(model);
  return {
    id: opts.model,
    categorize: (request) => categorizeWithAgent(agent, request),
  };
}

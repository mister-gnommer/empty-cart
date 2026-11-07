// The LangChain agent behind the categorizer interface. The only module that
// touches the model; it returns raw answers, and the caller checks them.
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createAgent, initChatModel } from 'langchain';
import { z } from 'zod';
import { CATEGORY_IDS } from '../list-sorting/category-catalog';
import { buildSystemPrompt, buildUserMessage } from './categorizer-prompt';
import { type CategorizeResult, type ItemCategorizer, MAX_CATEGORIZED_ITEMS } from './types';

// learn: responseFormat takes a zod schema; createAgent turns it into the model's structured output and validates the answer against it
const CategorizedLines = z.object({
  assignments: z
    .array(z.object({ line: z.number().int(), category: z.enum(CATEGORY_IDS) }))
    .max(MAX_CATEGORIZED_ITEMS),
});
type CategorizeAssignments = z.infer<typeof CategorizedLines>['assignments'];

/**
 * Builds the model and the agent once; each `categorize` call is one agent run.
 * @param opts model string (`provider:name`), API key, optional base URL (e.g.
 *   OpenCode's gateway), and a ready model that replaces initChatModel in tests
 */
export async function createAgentCategorizer(opts: {
  model: string;
  apiKey: string;
  baseUrl: string | null;
  chatModel?: BaseChatModel;
}): Promise<ItemCategorizer> {
  const model =
    opts.chatModel ??
    // learn: initChatModel picks the provider package from the "anthropic:" prefix, so swapping providers is a config change
    (await initChatModel(opts.model, {
      apiKey: opts.apiKey,
      temperature: 0,
      maxRetries: 1,
      // learn: anthropicApiUrl redirects the Anthropic client to an Anthropic-compatible gateway such as OpenCode
      ...(opts.baseUrl === null ? {} : { anthropicApiUrl: opts.baseUrl }),
    }));

  // learn: createAgent wraps the model in a small LangGraph loop (model → tools → model); with no tools it runs the model until it produces the structured response
  const agent = createAgent({
    model,
    tools: [],
    systemPrompt: buildSystemPrompt(),
    responseFormat: CategorizedLines,
  });

  return {
    id: opts.model,
    async categorize({ items, signal }): Promise<CategorizeResult> {
      try {
        // learn: an agent is invoked with a messages list; the system prompt is prepended for us
        const result = await agent.invoke(
          { messages: [{ role: 'user', content: buildUserMessage(items) }] },
          // learn: the abort signal travels down to the model's HTTP request
          { signal },
        );
        // learn: structuredResponse is the parsed, schema-validated answer, separate from the chat messages
        const answer: { assignments: CategorizeAssignments } | undefined =
          result.structuredResponse;
        // learn: when a structured answer fails the schema, createAgent sends the error back and lets the model retry; if it never answers validly, the run ends WITHOUT a structuredResponse instead of throwing
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
        return {
          status: 'failed',
          cause: 'error',
          errorName: err instanceof Error ? err.name : typeof err,
        };
      }
    },
  };
}

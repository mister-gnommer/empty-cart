// Operator eval: runs every sample list through the REAL agent categorizer and
// scores the share of lines that land in the expected category. Costs a few
// cents per run; never part of `npm test`. Run with `npm run eval`.
import * as ls from 'langsmith/vitest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentCategorizer } from '../src/categorizer/agent-categorizer';
import type { ItemCategorizer } from '../src/categorizer/types';
import { DEFAULT_SHOP_ORDER } from '../src/list-sorting/category-catalog';
import { checkAssignments } from '../src/list-sorting/check-assignments';
import { renderSortedList } from '../src/list-sorting/render-sorted-list';
import { sortByShopOrder } from '../src/list-sorting/sort-list';
import { SORTING_BUDGET_MS } from '../src/shopping-list/list-graph';
import { SAMPLE_LISTS } from './sample-lists';

/** Minimum line-weighted accuracy across all samples. */
const PASSING_ACCURACY = 0.9;

const model = process.env.SORTING_MODEL;
const apiKey = process.env.SORTING_API_KEY;
const baseUrl = process.env.SORTING_BASE_URL || null;

if (!model || !apiKey) {
  describe.skip('categorize sample lists: set SORTING_MODEL and SORTING_API_KEY to run', () => {
    it('needs a live model', () => undefined);
  });
} else {
  // learn: ls.describe groups the tests into one LangSmith dataset; with LANGSMITH_TRACING=true each run becomes an experiment, otherwise it runs locally only
  ls.describe('categorize sample lists', () => {
    let categorizer: ItemCategorizer;
    const totals = { correct: 0, lines: 0 };

    beforeAll(async () => {
      categorizer = await createAgentCategorizer({ model, apiKey, baseUrl });
    });

    for (const sample of SAMPLE_LISTS) {
      // learn: ls.test takes inputs and referenceOutputs; LangSmith stores them as one dataset example, so experiments can be compared line by line
      ls.test(
        sample.name,
        { inputs: { lines: sample.lines }, referenceOutputs: { categories: sample.expected } },
        async ({ inputs, referenceOutputs }) => {
          const result = await categorizer.categorize({
            items: inputs.lines,
            signal: AbortSignal.timeout(SORTING_BUDGET_MS),
          });
          const categories =
            result.status === 'ok'
              ? checkAssignments(result.assignments, inputs.lines.length)
              : null;
          const correct =
            categories === null
              ? 0
              : categories.filter((c, i) => c === referenceOutputs?.categories[i]).length;
          totals.correct += correct;
          totals.lines += inputs.lines.length;

          // learn: logOutputs records what the system produced for this example
          ls.logOutputs({ status: result.status, categories });
          // learn: logFeedback attaches a named score to the run; LangSmith charts it per experiment
          ls.logFeedback({ key: 'accuracy', score: correct / inputs.lines.length });

          if (sample.injection && categories !== null) {
            // Whatever the model did with an injected line, the reply can only
            // regroup the recognized lines: each must appear exactly once, verbatim.
            const rendered = renderSortedList(
              sortByShopOrder(inputs.lines, categories, DEFAULT_SHOP_ORDER),
            ).split('\n');
            for (const line of inputs.lines) {
              expect(rendered.filter((r) => r === line)).toHaveLength(1);
            }
          }
        },
      );
    }

    afterAll(() => {
      const accuracy = totals.lines === 0 ? 0 : totals.correct / totals.lines;
      console.log(`overall accuracy: ${accuracy.toFixed(3)} (${totals.correct}/${totals.lines})`);
      expect(accuracy).toBeGreaterThanOrEqual(PASSING_ACCURACY);
    });
  });
}

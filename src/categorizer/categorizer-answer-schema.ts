// The answer the model must return: one category id per line number. Line
// numbers, never item text: the reply text always comes from the recognized
// lines. The `.describe()` texts reach the model in the schema it receives.
import { z } from 'zod';
import { CATEGORY_IDS } from '../list-sorting/category-catalog';
import { MAX_CATEGORIZED_ITEMS } from './types';

const LineCategory = z.object({
  line: z.number().int().describe('1-based number of the list line'),
  category: z.enum(CATEGORY_IDS).describe('category id for that line'),
});

export const CategorizerAnswer = z
  .object({
    // Bounds how much untrusted output zod has to validate.
    assignments: z.array(LineCategory).max(MAX_CATEGORIZED_ITEMS),
  })
  // LangChain names the structured-output tool after the title (without one,
  // `extract-<N>` from a process-wide counter), and its agent routing spots
  // structured-output calls by the `extract-` prefix, so the title keeps it.
  .meta({ title: 'extract-categorizer-answer' });

import { it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { assertProperty, fc } from '@gotako/orca/property';
import { arbInputs, classifyInputs, relation } from './generator.mjs';
import { runStrategy } from './strategy.mjs';

it('[no-lookahead-future-independence]', async () => {
  const result = await assertProperty({
    id: 'no-lookahead-future-independence',
    seed: 20261006,
    numRuns: 1000,
    corpus: fileURLToPath(new URL('./orca/corpus/no-lookahead-future-independence.json', import.meta.url)),
    arbitrary: arbInputs(fc),
    predicate: input => relation(input, runStrategy),
    classify: classifyInputs,
  });
  expect(result.failed).toBe(false);
  expect(result.successful_runs).toBe(1000);
  expect(result.corpus.executed).toBeGreaterThanOrEqual(1);
});

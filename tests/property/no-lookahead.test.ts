import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertProperty, fc } from '../../src/property/runtime.js';
import { arbInputs, classifyInputs, relation } from '../../examples/trading/generator.mjs';
import { runStrategy, futureDependentStrategy } from '../../examples/trading/strategy.mjs';

it('seeded no-lookahead example records 1000 actual runs and domain edge categories', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-no-lookahead-'));
  try {
    const result = await assertProperty({
      id: 'no-lookahead-future-independence', seed: 20261006, numRuns: 1000,
      corpus: join(root, 'corpus.json'), arbitrary: arbInputs(fc),
      predicate: input => relation(input, runStrategy), classify: classifyInputs,
    });
    expect(result.successful_runs).toBe(1000);
    expect(result.seed).toBe(20261006);
    expect(result.skipped).toBe(0);
    expect(result.categories.gap).toBeGreaterThanOrEqual(50);
    expect(result.categories.halt).toBeGreaterThanOrEqual(50);
    expect(result.categories['zero-volume']).toBeGreaterThanOrEqual(50);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('future-data dependency is shrunk and retained as a concrete regression after generator changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-no-lookahead-mutant-'));
  const corpus = join(root, 'corpus.json');
  try {
    await expect(assertProperty({
      id: 'no-lookahead-future-independence', seed: 20261006, numRuns: 1000,
      corpus, arbitrary: arbInputs(fc), predicate: input => relation(input, futureDependentStrategy),
    })).rejects.toThrow(/counterexample/);
    const captured = JSON.parse(readFileSync(corpus, 'utf8'));
    expect(captured.cases).toHaveLength(1);
    const constant = fc.constant({ bars: Array.from({ length: 50 }, (_, i) => ({
      price: 100, volume: 100, gap: false, halted: false, time: i * 60000,
    })), k: 40, tail: [{ price: 100, volume: 100, gap: false, halted: false, time: 60000 }] });
    await expect(assertProperty({
      id: 'no-lookahead-future-independence', seed: 7, numRuns: 10, corpus,
      arbitrary: constant, predicate: input => relation(input, futureDependentStrategy),
    })).rejects.toThrow(/corpus/i);
    const fixed = await assertProperty({
      id: 'no-lookahead-future-independence', seed: 7, numRuns: 10, corpus,
      arbitrary: constant, predicate: input => relation(input, runStrategy),
    });
    expect(fixed.corpus.executed).toBe(1);
    expect(JSON.parse(readFileSync(corpus, 'utf8'))).toEqual(captured);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

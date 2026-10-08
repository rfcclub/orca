import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertProperty, fc } from '../../src/property/runtime.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-property-runtime-'));
  return { corpus: join(root, 'counterexamples.json'), clean: () => rmSync(root, { recursive: true, force: true }) };
}

it('actual seeded framework records successful evaluations, discards and categories', async () => {
  const f = fixture();
  try {
    let evaluated = 0;
    const result = await assertProperty({
      id: 'numbers-positive', seed: 451, numRuns: 100, corpus: f.corpus,
      arbitrary: fc.integer({ min: -10, max: 10 }),
      predicate: value => { fc.pre(value >= 0); evaluated++; return value >= 0; },
      classify: value => [value === 0 ? 'zero' : 'positive'],
    });
    expect(result.failed).toBe(false);
    expect(result.successful_runs).toBe(100);
    expect(result.successful_runs).toBe(evaluated);
    expect(result.skipped).toBeGreaterThan(0);
    expect(result.categories.zero + result.categories.positive).toBe(evaluated);
    expect(result.seed).toBe(451);
    expect(result.framework.name).toBe('fast-check');
    expect(result.framework.version).toBe('4.10.2');
    expect(result.replay_path).toBe(null);
    expect(result.corpus.executed).toBe(0);
  } finally { f.clean(); }
});

it('missing deterministic seed is rejected before running a property', async () => {
  const f = fixture();
  try {
    await expect(assertProperty({
      id: 'missing-seed', numRuns: 100, corpus: f.corpus,
      arbitrary: fc.integer(), predicate: () => true,
    })).rejects.toThrow(/seed/i);
  } finally { f.clean(); }
});

it('minimized concrete failure replays permanently after the generator changes', async () => {
  const f = fixture();
  try {
    await expect(assertProperty({
      id: 'regression-negative', seed: 907, numRuns: 50, corpus: f.corpus,
      arbitrary: fc.integer({ min: -100, max: -1 }), predicate: value => value >= 0,
    })).rejects.toThrow(/seed.*907.*path/i);
    const captured = JSON.parse(readFileSync(f.corpus, 'utf8'));
    expect(captured.property).toBe('regression-negative');
    expect(captured.cases).toHaveLength(1);
    expect(captured.cases[0].seed).toBe(907);
    expect(captured.cases[0].path).toEqual(expect.any(String));
    // A generator incapable of generating the old failure cannot erase it.
    await expect(assertProperty({
      id: 'regression-negative', seed: 908, numRuns: 10, corpus: f.corpus,
      arbitrary: fc.constant(100), predicate: value => value >= 0,
    })).rejects.toThrow(/corpus/i);
    const evaluated: number[] = [];
    const fixed = await assertProperty({
      id: 'regression-negative', seed: 909, numRuns: 10, corpus: f.corpus,
      arbitrary: fc.constant(100), predicate: value => { evaluated.push(value); return true; },
    });
    expect(evaluated[0]).toBeLessThan(0);
    expect(fixed.corpus.executed).toBe(1);
    expect(fixed.successful_runs).toBe(10);
    expect(JSON.parse(readFileSync(f.corpus, 'utf8'))).toEqual(captured);
  } finally { f.clean(); }
});

it('corpus encoding preserves NaN, negative zero and infinite values without JSON loss', async () => {
  const f = fixture();
  try {
    const edge = { nan: NaN, zero: -0, infinity: Infinity, quantity: 123n };
    await expect(assertProperty({
      id: 'edge-codec', seed: 15, numRuns: 1, corpus: f.corpus,
      arbitrary: fc.constant(edge), predicate: () => false,
    })).rejects.toThrow(/counterexample/i);
    let replayed = false;
    await assertProperty({
      id: 'edge-codec', seed: 16, numRuns: 1, corpus: f.corpus,
      arbitrary: fc.constant(edge), predicate: value => {
        expect(Number.isNaN(value.nan)).toBe(true);
        expect(Object.is(value.zero, -0)).toBe(true);
        expect(value.infinity).toBe(Infinity);
        expect(value.quantity).toBe(123n);
        replayed = true;
      },
    });
    expect(replayed).toBe(true);
  } finally { f.clean(); }
});

it('predicate setup/runtime exceptions remain inconclusive rather than assertion RED', async () => {
  const f = fixture();
  try {
    const error = await assertProperty({
      id: 'runtime-error', seed: 91, numRuns: 10, corpus: f.corpus,
      arbitrary: fc.integer(), predicate: () => { throw new TypeError('missing strategy helper'); },
    }).catch(error => error);
    expect(error.name).not.toBe('AssertionError');
    expect(error.message).toMatch(/inconclusive/i);
  } finally { f.clean(); }
});

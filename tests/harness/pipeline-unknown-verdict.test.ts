import { it, expect } from 'vitest'
import { runPipelineGate } from '../../src/harness/pipeline-gate.ts'

// Review on orca#36 (reviewers): a verdict that is not a known name must not fall through to SHIP.

it('unknown-code-verdict: an unrecognised code verdict holds the pipeline and names the change', () => {
  for (const verdict of ['NONSENSE', 'ESCALATE_TO_HUMANN']) {
    const alone = runPipelineGate([{ verdict: verdict as never, change: 'a' }])
    expect(alone.decision).toBe('HOLD')
    expect(alone.blocking).toEqual(['a'])
    const mixed = runPipelineGate([{ verdict: 'PASS', change: 'ok' }, { verdict: verdict as never, change: 'odd' }])
    expect(mixed.decision).toBe('HOLD')
    expect(mixed.blocking).toEqual(['odd'])
  }
})

it('unknown-plan-verdict: an unrecognised plan verdict holds the pipeline', () => {
  const held = runPipelineGate([{ verdict: 'PASS', change: 'a', plan: { verdict: 'NONSENSE' as never, required: true } }])
  expect(held.decision).toBe('HOLD')
  expect(held.blocking).toEqual(['a'])
})

it('known-verdicts: known names and the old escalation name keep their decisions', () => {
  expect(runPipelineGate([{ verdict: 'PASS', change: 'a' }]).decision).toBe('SHIP')
  expect(runPipelineGate([{ verdict: 'ESCALATE_TO_HUMAN' as never, change: 'a' }]).decision).toBe('ESCALATE_TO_REVIEWER')
  expect(runPipelineGate([{ verdict: 'PASS_WITH_WARNINGS', change: 'a', plan: { verdict: 'PASS', required: true } }]).decision).toBe('SHIP')
})

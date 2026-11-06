import { it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { normalizeGateVerdict } from '../../src/harness/types.ts'
import { runPipelineGate } from '../../src/harness/pipeline-gate.ts'
import { runGatePlan, readLatestVerdicts } from '../../src/harness/gate-plan.ts'

// An uncertain gate hands the evidence to an independent reviewer; it does not default the work to the human.
// Older seal-gate builds and stored verdict files still say ESCALATE_TO_HUMAN and are read as the new name.

const INTENT = '# Intent: demo\n\n## Success Criteria\n\n- first criterion\n\n## Intent Approval\n\nStatus: APPROVED\nApproved by: owner\nDate: 2026-11-05\n'

let dir: string
beforeEach(() => { dir = join(tmpdir(), `orca-reviewer-${Date.now()}-${Math.random().toString(36).slice(2)}`); mkdirSync(dir, { recursive: true }) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

it('reviewer-normalize: the old verdict name is read as the new one, nothing else changes', () => {
  expect(normalizeGateVerdict('ESCALATE_TO_HUMAN')).toBe('ESCALATE_TO_REVIEWER')
  expect(normalizeGateVerdict('ESCALATE_TO_REVIEWER')).toBe('ESCALATE_TO_REVIEWER')
  for (const v of ['PASS', 'PASS_WITH_WARNINGS', 'REVISE', 'BLOCK']) expect(normalizeGateVerdict(v)).toBe(v)
  expect(normalizeGateVerdict(undefined)).toBeUndefined()
  expect(normalizeGateVerdict('NONSENSE')).toBe('NONSENSE')
})

it('reviewer-pipeline: an escalation, new or old name, is a reviewer decision and a failing plan still holds', () => {
  for (const name of ['ESCALATE_TO_REVIEWER', 'ESCALATE_TO_HUMAN']) {
    const code = runPipelineGate([{ verdict: name as never, change: 'a' }])
    expect(code.decision).toBe('ESCALATE_TO_REVIEWER')
    expect(code.summary).toContain('independent reviewer')
    expect(code.summary).not.toContain('human')
    const plan = runPipelineGate([{ verdict: 'PASS', change: 'a', plan: { verdict: name as never, required: true } }])
    expect(plan.decision).toBe('HOLD')
  }
  const many = runPipelineGate(['a', 'b', 'c'].map(change => ({ verdict: 'REVISE' as const, change })))
  expect(many.decision).toBe('ESCALATE_TO_REVIEWER')
})

it('reviewer-gate-plan: a plan verdict from an older seal-gate is recorded and reported under the new name', async () => {
  writeFileSync(join(dir, 'intent.md'), INTENT)
  writeFileSync(join(dir, 'tasks.md'), '- [ ] do it')
  const result = await runGatePlan({ changeDir: dir, sealReviewFn: async () => ({ verdict: 'ESCALATE_TO_HUMAN', trust_score: 40, blocking_issues: [], next_action: 'next' }) })
  expect(result.verdict).toBe('ESCALATE_TO_REVIEWER')
  const files = readdirSync(join(dir, '.harness', 'gate-verdicts')).filter(f => f.endsWith('.json'))
  expect(JSON.parse(readFileSync(join(dir, '.harness', 'gate-verdicts', files[0]!), 'utf-8')).verdict).toBe('ESCALATE_TO_REVIEWER')
})

it('reviewer-stored: verdict files written under the old name are read as the new one', () => {
  const verdictDir = join(dir, '.harness', 'gate-verdicts')
  mkdirSync(verdictDir, { recursive: true })
  writeFileSync(join(verdictDir, '1.json'), JSON.stringify({ verdict: 'ESCALATE_TO_HUMAN', trust_score: 75 }))
  writeFileSync(join(verdictDir, '2-plan.json'), JSON.stringify({ kind: 'plan', verdict: 'ESCALATE_TO_HUMAN', trust_score: 60 }))
  const latest = readLatestVerdicts(dir)
  expect(latest.code?.verdict).toBe('ESCALATE_TO_REVIEWER')
  expect(latest.plan?.verdict).toBe('ESCALATE_TO_REVIEWER')
})

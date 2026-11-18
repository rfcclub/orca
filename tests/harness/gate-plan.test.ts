import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { createChangeFromIssue } from '../../src/issue/folder.ts'
import {
  hasApprovalRecord,
  isApprovalExemptBugIntent,
  extractLockedCriteria,
  runGatePlan,
  GatePlanError,
  readLatestVerdicts,
} from '../../src/harness/gate-plan.ts'

const APPROVED_INTENT = [
  '# Intent: demo',
  '',
  '## Success Criteria',
  '',
  '- first criterion',
  '- second criterion',
  '- third criterion',
  '',
  '## Intent Approval',
  '',
  'Status: APPROVED',
  'Approved by: owner',
  'Date: 2026-10-05',
  '',
].join('\n')

let dir: string

function sealReturning(verdict: string, trust = 90) {
  const calls: unknown[] = []
  const fn = async (input: unknown) => {
    calls.push(input)
    return { verdict, trust_score: trust, blocking_issues: [], next_action: 'next' }
  }
  return { fn, calls }
}

beforeEach(() => {
  dir = join(tmpdir(), `orca-gate-plan-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function write(rel: string, text: string) {
  const p = join(dir, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, text)
}

describe('hasApprovalRecord', () => {
  it('uses the final approval record appended by issue open, including revocation', () => {
    const issueBody = '## Intent Approval\nStatus: DRAFT\n';
    expect(hasApprovalRecord(issueBody + '\n' + APPROVED_INTENT)).toBe(true);
    expect(hasApprovalRecord(APPROVED_INTENT + '\n## Intent Approval\nStatus: DRAFT\n')).toBe(false);
  });
  it('is true only with an Intent Approval section whose status is APPROVED', () => {
    expect(hasApprovalRecord(APPROVED_INTENT)).toBe(true)
    expect(hasApprovalRecord('# Intent\n\nStatus: DRAFT\n')).toBe(false)
    expect(hasApprovalRecord('## Intent Approval\n\nStatus: DRAFT\n')).toBe(false)
  })
})

describe('extractLockedCriteria (SC-004, SC-005)', () => {
  it('returns one entry per bullet with id, text, source file and 1-based line', () => {
    const criteria = extractLockedCriteria(APPROVED_INTENT, 'intent.md')
    expect(criteria).toEqual([
      { id: 'SC-1', text: 'first criterion', source_file: 'intent.md', source_line: 5 },
      { id: 'SC-2', text: 'second criterion', source_file: 'intent.md', source_line: 6 },
      { id: 'SC-3', text: 'third criterion', source_file: 'intent.md', source_line: 7 },
    ])
  })

  it('returns an empty list when the section is missing or has no bullets', () => {
    expect(extractLockedCriteria('# Intent\n', 'intent.md')).toEqual([])
    expect(extractLockedCriteria('## Success Criteria\n\nprose only\n\n## Next\n', 'intent.md')).toEqual([])
  })
})

describe('runGatePlan refusals (SC-001, SC-002, SC-005, SC-009)', () => {
  it('SC-001: unapproved intent -> error naming approval, SEAL not invoked, no verdict file', async () => {
    write('intent.md', '# Intent\n\n## Success Criteria\n\n- a\n')
    write('plan.json', '{}')
    const seal = sealReturning('PASS')
    await expect(runGatePlan({ changeDir: dir, sealReviewFn: seal.fn })).rejects.toThrow(/approval/i)
    expect(seal.calls).toHaveLength(0)
    expect(existsSync(join(dir, '.harness', 'gate-verdicts'))).toBe(false)
  })

  it('SC-005: approved intent without bullets -> criteria cannot be locked', async () => {
    write('intent.md', '# Intent\n\n## Intent Approval\n\nStatus: APPROVED\n')
    write('plan.json', '{}')
    const seal = sealReturning('PASS')
    await expect(runGatePlan({ changeDir: dir, sealReviewFn: seal.fn })).rejects.toThrow(/cannot be locked/i)
    expect(seal.calls).toHaveLength(0)
  })

  it('SC-009: neither plan.json nor tasks.md -> names the missing plan artifact', async () => {
    write('intent.md', APPROVED_INTENT)
    const seal = sealReturning('PASS')
    await expect(runGatePlan({ changeDir: dir, sealReviewFn: seal.fn })).rejects.toThrow(/plan\.json.*tasks\.md/)
    expect(seal.calls).toHaveLength(0)
  })

  it('throws GatePlanError so the CLI can print the message', async () => {
    await expect(runGatePlan({ changeDir: dir, sealReviewFn: sealReturning('PASS').fn })).rejects.toBeInstanceOf(GatePlanError)
  })
})

describe('runGatePlan artifact choice and criteria (SC-003, SC-006, SC-007, SC-008)', () => {
  it('SC-007: plan.json is reviewed when present', async () => {
    write('intent.md', APPROVED_INTENT)
    write('plan.json', '{"tasks":[]}')
    write('tasks.md', 'should not be used')
    const seal = sealReturning('PASS')
    await runGatePlan({ changeDir: dir, sealReviewFn: seal.fn })
    const input = seal.calls[0] as { artifact_type: string; output: string }
    expect(input.artifact_type).toBe('plan_review')
    expect(input.output).toBe('{"tasks":[]}')
  })

  it('SC-008: tasks.md is reviewed when plan.json is absent', async () => {
    write('intent.md', APPROVED_INTENT)
    write('tasks.md', '- [ ] do it')
    const seal = sealReturning('PASS')
    await runGatePlan({ changeDir: dir, sealReviewFn: seal.fn })
    expect((seal.calls[0] as { output: string }).output).toBe('- [ ] do it')
  })

  it('SC-003/SC-004: locked criteria from the intent are passed to SEAL', async () => {
    write('intent.md', APPROVED_INTENT)
    write('tasks.md', 'x')
    const seal = sealReturning('PASS')
    await runGatePlan({ changeDir: dir, sealReviewFn: seal.fn })
    const ctx = (seal.calls[0] as { context: { locked_criteria: Array<{ id: string }> } }).context
    expect(ctx.locked_criteria.map(c => c.id)).toEqual(['SC-1', 'SC-2', 'SC-3'])
  })

  it('SC-006: an existing criteria file is overwritten, never read as input', async () => {
    write('intent.md', APPROVED_INTENT)
    write('tasks.md', 'x')
    write('.harness/locked-criteria.json', JSON.stringify([{ id: 'SC-1', text: 'planted by the agent' }]))
    const seal = sealReturning('PASS')
    await runGatePlan({ changeDir: dir, sealReviewFn: seal.fn })
    const ctx = (seal.calls[0] as { context: { locked_criteria: Array<{ text: string }> } }).context
    expect(ctx.locked_criteria[0].text).toBe('first criterion')
    const onDisk = JSON.parse(readFileSync(join(dir, '.harness', 'locked-criteria.json'), 'utf-8'))
    expect(onDisk[0].text).toBe('first criterion')
  })
})

describe('runGatePlan LLM wiring (SC-010, SC-011)', () => {
  it('SC-010: no --llm -> no reviewer is wired', async () => {
    write('intent.md', APPROVED_INTENT)
    write('tasks.md', 'x')
    const wired: Array<string | undefined> = []
    await runGatePlan({ changeDir: dir, sealReviewFn: sealReturning('PASS').fn, wireLlm: async p => { wired.push(p) } })
    expect(wired).toEqual([])
  })

  it('SC-011: --llm <provider> passes the provider unchanged', async () => {
    write('intent.md', APPROVED_INTENT)
    write('tasks.md', 'x')
    const wired: Array<string | undefined> = []
    await runGatePlan({ changeDir: dir, llmProvider: 'agnes', sealReviewFn: sealReturning('PASS').fn, wireLlm: async p => { wired.push(p) } })
    expect(wired).toEqual(['agnes'])
  })
})

describe('runGatePlan verdict records (SC-012..SC-017)', () => {
  for (const verdict of ['PASS', 'PASS_WITH_WARNINGS', 'BLOCK', 'REVISE', 'ESCALATE_TO_REVIEWER']) {
    it(`${verdict}: writes a plan verdict file and reports it`, async () => {
      write('intent.md', APPROVED_INTENT)
      write('tasks.md', '- [ ] do it')
      const result = await runGatePlan({ changeDir: dir, sealReviewFn: sealReturning(verdict, 77).fn })
      expect(result.verdict).toBe(verdict)
      const verdictDir = join(dir, '.harness', 'gate-verdicts')
      const files = readdirSync(verdictDir).filter(f => f.endsWith('.json'))
      expect(files).toHaveLength(1)
      const record = JSON.parse(readFileSync(join(verdictDir, files[0]), 'utf-8'))
      expect(record.kind).toBe('plan')
      expect(record.verdict).toBe(verdict)
      expect(record.trust_score).toBe(77)
      expect(record.artifact).toBe('tasks.md')
      expect(record.bound_artifact_sha256).toBe(createHash('sha256').update('- [ ] do it').digest('hex'))
    })
  }
})

describe('readLatestVerdicts (SC-017)', () => {
  it('separates the latest plan verdict from the latest code verdict', () => {
    const vdir = join(dir, '.harness', 'gate-verdicts')
    mkdirSync(vdir, { recursive: true })
    writeFileSync(join(vdir, '1000.json'), JSON.stringify({ verdict: 'PASS', trust_score: 80 }))
    writeFileSync(join(vdir, '2000-plan.json'), JSON.stringify({ kind: 'plan', verdict: 'BLOCK' }))
    writeFileSync(join(vdir, '3000.json'), JSON.stringify({ verdict: 'REVISE', trust_score: 50 }))
    writeFileSync(join(vdir, '4000-plan.json'), JSON.stringify({ kind: 'plan', verdict: 'PASS' }))
    const latest = readLatestVerdicts(dir)
    expect(latest.code?.verdict).toBe('REVISE')
    expect(latest.plan?.verdict).toBe('PASS')
  })

  it('returns nothing when there is no verdict folder', () => {
    expect(readLatestVerdicts(dir)).toEqual({})
  })
})

describe('approval-exempt bug intents (#11)', () => {
  const BUG_BODY = ['Repro steps', 'Expected', 'Actual', 'Environment']
    .map(h => `### ${h}\n\ntext for ${h}\n`).join('\n') + '\n## Success Criteria\n\n- the bug no longer reproduces\n- a regression test pins it\n'

  /** The intent exactly as the issue folder code writes it for a bug that needs no approval. */
  let seq = 0
  function generatedBugIntent(body = BUG_BODY): string {
    const out = createChangeFromIssue({ issue: { number: 7, author: 'a', labels: ['bug'], body }, repo: 'owner/repo',
      approved: false, changesDir: dir, name: `fix-it-${++seq}`, now: () => new Date('2026-10-07T12:00:00Z') })
    return readFileSync(join(out.dir, 'intent.md'), 'utf-8')
  }

  it('recognises the generated marker and nothing weaker', () => {
    const generated = generatedBugIntent()
    expect(isApprovalExemptBugIntent(generated)).toBe(true)
    expect(hasApprovalRecord(generated)).toBe(false)
    // arbitrary prose, a hand-written status, an edited marker, a missing bug preamble
    expect(isApprovalExemptBugIntent('# Intent: x\n\n## Intent Approval\n\nStatus: NOT REQUIRED (bug fix: the PR approval is the gate)\nDate: 2026-10-07\n')).toBe(false)
    expect(isApprovalExemptBugIntent(generated.replace('the PR approval is the gate)', 'trust me)'))).toBe(false)
    expect(isApprovalExemptBugIntent(generated.replace('Generated from a bug issue.', 'Written by hand.'))).toBe(false)
    expect(isApprovalExemptBugIntent(generated.replace(/^Issue: .*$/m, 'Issue: none'))).toBe(false)
    expect(isApprovalExemptBugIntent(generated.replace('Status: NOT REQUIRED', 'Status: NOT REQUIRED.'))).toBe(false)
  })

  it('does not accept the marker unless its approval section is the last, exact one', () => {
    const generated = generatedBugIntent()
    expect(isApprovalExemptBugIntent(generated + '\n## Intent Approval\n\nStatus: DRAFT\n')).toBe(false)
    expect(isApprovalExemptBugIntent(generated + 'Approved by: someone\n')).toBe(false)
    expect(isApprovalExemptBugIntent(generated + '\n## Notes\n\nmore\n')).toBe(false)
    // marker text that merely appears in the issue body is not the generated section
    const bodyForged = generatedBugIntent(BUG_BODY + '\n## Intent Approval\n\nStatus: NOT REQUIRED (bug fix: the PR approval is the gate)\nDate: 2026-01-01\n')
    expect(isApprovalExemptBugIntent(bodyForged)).toBe(true) // the generated final section still decides
    expect(isApprovalExemptBugIntent(bodyForged.replace(/Status: NOT REQUIRED[^\n]*\n\nDate: 2026-10-07\n$/, 'Status: DRAFT\n\nDate: 2026-10-07\n'))).toBe(false)
  })

  it('admits a generated approval-exempt bug intent to plan review and records how', async () => {
    write('intent.md', generatedBugIntent())
    write('tasks.md', '- [ ] write a failing regression test')
    const seal = sealReturning('PASS')
    const result = await runGatePlan({ changeDir: dir, sealReviewFn: seal.fn })
    expect(result.verdict).toBe('PASS')
    expect(result.criteria_count).toBe(2)
    expect(seal.calls).toHaveLength(1)
    const file = readdirSync(join(dir, '.harness', 'gate-verdicts'))[0]!
    expect(JSON.parse(readFileSync(join(dir, '.harness', 'gate-verdicts', file), 'utf-8')).intent_approval).toBe('bug-exempt')
  })

  it('still refuses a hand-written exempt status, an edited marker and a DRAFT, without invoking SEAL', async () => {
    const generated = generatedBugIntent()
    const forgeries = [
      '# Intent: x\n\n## Success Criteria\n\n- a\n\n## Intent Approval\n\nStatus: NOT REQUIRED (bug fix: the PR approval is the gate)\nDate: 2026-10-07\n',
      generated.replace('the PR approval is the gate)', 'because I said so)'),
      generated + '\n## Intent Approval\n\nStatus: DRAFT\n',
    ]
    for (const intent of forgeries) {
      write('intent.md', intent)
      write('tasks.md', 'x')
      const seal = sealReturning('PASS')
      await expect(runGatePlan({ changeDir: dir, sealReviewFn: seal.fn })).rejects.toThrow(/no approval record/)
      expect(seal.calls).toHaveLength(0)
    }
    expect(existsSync(join(dir, '.harness', 'gate-verdicts'))).toBe(false)
  })

  it('an exempt bug intent without success criteria still cannot lock them, and says what to add', async () => {
    write('intent.md', generatedBugIntent(['Repro steps', 'Expected', 'Actual', 'Environment'].map(h => `### ${h}\n\ntext\n`).join('\n')))
    write('tasks.md', 'x')
    const seal = sealReturning('PASS')
    await expect(runGatePlan({ changeDir: dir, sealReviewFn: seal.fn })).rejects.toThrow(/Success Criteria.*add/s)
    expect(seal.calls).toHaveLength(0)
  })

  it('an approved intent is recorded as approved', async () => {
    write('intent.md', APPROVED_INTENT)
    write('tasks.md', 'x')
    const result = await runGatePlan({ changeDir: dir, sealReviewFn: sealReturning('PASS').fn })
    expect(result.intent_approval).toBe('approved')
  })
})

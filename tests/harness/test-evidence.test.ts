import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_TEST_EVIDENCE_BYTES, selectTestEvidence } from '../../src/harness/test-evidence.ts'
import { runGateCode } from '../../src/harness/gate-code.ts'
import { writePlanJson } from '../../src/harness/plan-json.ts'
import type { EvidenceReference } from '../../src/harness/types.ts'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const rec = (command: string, exit_code: number, output: string): EvidenceReference => ({ type: 'command', command, exit_code, output })
const graphql = rec('bun test graphql', 0, '101 pass 0 fail')
const get = rec('bun test get', 0, '117 pass 0 fail')

describe('selectTestEvidence', () => {
  it('includes every test-command record, not only the first', () => {
    const { testLog, sha256, records } = selectTestEvidence([graphql, rec('bun run build', 0, 'built'), get])
    expect(testLog).toContain('101 pass 0 fail')
    expect(testLog).toContain('117 pass 0 fail')
    expect(testLog).not.toContain('built')
    expect(records.map(r => r.command)).toEqual(['bun test get', 'bun test graphql'])
    expect(sha256).toBe(sha(testLog))
  })

  it('is reorder-invariant: the same records in any order give identical bytes and hash', () => {
    const a = selectTestEvidence([graphql, get])
    const b = selectTestEvidence([get, graphql])
    expect(b.testLog).toBe(a.testLog)
    expect(b.sha256).toBe(a.sha256)
    expect(a.testLog.indexOf('bun test get')).toBeLessThan(a.testLog.indexOf('bun test graphql'))
  })

  it('keeps raw order for records with the same command', () => {
    const first = rec('bun test same', 0, 'run one')
    const second = rec('bun test same', 1, 'run two')
    const { testLog } = selectTestEvidence([first, second])
    expect(testLog.indexOf('run one')).toBeLessThan(testLog.indexOf('run two'))
    expect(selectTestEvidence([second, first]).testLog.indexOf('run two')).toBeLessThan(selectTestEvidence([second, first]).testLog.indexOf('run one'))
  })

  it('keeps a failing record visible next to a passing one, in either order', () => {
    const failing = rec('bun test zeta', 1, '3 pass 2 fail')
    for (const order of [[get, failing], [failing, get]]) {
      const { testLog } = selectTestEvidence(order)
      expect(testLog).toContain('exit_code: 1')
      expect(testLog).toContain('3 pass 2 fail')
      expect(testLog).toContain('2 records, 1 with a non-zero or missing exit code')
    }
  })

  it('treats a missing exit code and empty output as visible, not as success', () => {
    const { testLog } = selectTestEvidence([graphql, { type: 'command', command: 'bun test empty' }])
    expect(testLog).toContain('exit_code: missing')
    expect(testLog).toContain('output_bytes: 0')
    expect(testLog).toContain('2 records, 1 with a non-zero or missing exit code')
  })

  it('keeps a single record exactly as before (raw output, its hash) for historical receipts', () => {
    const one = selectTestEvidence([rec('bun run build', 0, 'built'), graphql])
    expect(one.testLog).toBe('101 pass 0 fail')
    expect(one.sha256).toBe(sha('101 pass 0 fail'))
    expect(selectTestEvidence([rec('bun test', 0, '')])).toMatchObject({ testLog: '', sha256: null })
  })

  it('gives nothing when no command record mentions test', () => {
    expect(selectTestEvidence([rec('bun run build', 0, 'built'), { type: 'file', file: 'a.ts', content: 'x' }])).toMatchObject({ testLog: '', sha256: null, records: [] })
  })

  it('refuses input above the explicit bound instead of truncating', () => {
    expect(MAX_TEST_EVIDENCE_BYTES).toBe(16 * 1024 * 1024)
    expect(() => selectTestEvidence([graphql, get], 10)).toThrow(/test_evidence_invalid \(too_large\)/)
    expect(() => selectTestEvidence([rec('bun test big', 0, 'x'.repeat(11))], 10)).toThrow(/too_large/)
    expect(selectTestEvidence([rec('bun test edge', 0, 'x'.repeat(10))], 10).testLog).toHaveLength(10)
  })

  it('refuses malformed records instead of treating them as passing', () => {
    expect(() => selectTestEvidence([graphql, { type: 'command', command: 'bun test x', exit_code: 0, output: 5 as unknown as string }])).toThrow(/malformed/)
    expect(() => selectTestEvidence([{ type: 'command', command: 'bun test x', exit_code: 'ok' as unknown as number, output: 'y' }])).toThrow(/malformed/)
  })
})

describe('runGateCode test evidence', () => {
  const roots: string[] = []
  afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })

  function project(evidence: EvidenceReference[]) {
    const root = mkdtempSync(join(tmpdir(), 'orca-test-evidence-'))
    roots.push(root)
    const change = join(root, 'openspec/changes/multi-test')
    mkdirSync(change, { recursive: true })
    writeFileSync(join(root, 'source.js'), 'export const v = 1;\n')
    writeFileSync(join(root, 'thing.test.js'), '// placeholder\n')
    execFileSync('git', ['init', '-q'], { cwd: root })
    execFileSync('git', ['add', '.'], { cwd: root })
    execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base'], { cwd: root })
    writeFileSync(join(root, 'source.js'), 'export const v = 2;\n')
    writeFileSync(join(change, 'self-check.md'),
      '# Self-Check\n\n## Claims\n- changed v\n\n## Evidence\n```json\n' + JSON.stringify(evidence) + '\n```\n')
    return { root, change }
  }

  async function gate(evidence: EvidenceReference[], withPlan = false) {
    const { root, change } = project(evidence)
    if (withPlan) {
      writePlanJson(change, { schema_version: '1.0', change_id: 'multi-test', traces_to: { target: 'intent.md', status: 'RESOLVED' },
        tasks: [{ id: 'T1', status: 'complete', behavior: 'b', acceptance: 'a', files: ['source.js'], test: 'thing.test.js', consumes: [], produces: [] }],
        escalation: { max_improvement_iterations: 6 } })
    }
    let review: { evidence: { test_log: string } } | undefined
    let probedLog: string | undefined
    const result = await runGateCode({ changeDir: change, projectRoot: root, skipStateCheck: true,
      sealReviewFn: async (input: unknown) => {
        review = input as typeof review
        return { verdict: 'PASS', trust_score: 100, blocking_issues: [], next_action: 'none' }
      },
      probeDeps: { validateWithProbe: async (_s, testLog) => { probedLog = testLog; return { issues: [], coverage: [{ criterion: 'a', pinned: true }] } },
        checkTestPinsBehavior: async () => ({ pinned: true, survivors: [] }) } })
    const dir = join(change, '.harness/gate-verdicts')
    const verdict = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]!), 'utf8'))
    return { review: review!, probedLog, result, verdict }
  }

  it('sends every test record to review, the probe and the bound hash, in canonical order', async () => {
    const forward = await gate([graphql, get], true)
    const reversed = await gate([get, graphql], true)
    for (const g of [forward, reversed]) {
      expect(g.review.evidence.test_log).toContain('101 pass 0 fail')
      expect(g.review.evidence.test_log).toContain('117 pass 0 fail')
      expect(g.probedLog).toBe(g.review.evidence.test_log)
      expect(g.verdict.evidence_bound.test_log_sha256).toBe(sha(g.review.evidence.test_log))
      expect(g.verdict.evidence_bound.test_records.map((r: { command: string }) => r.command)).toEqual(['bun test get', 'bun test graphql'])
    }
    expect(reversed.review.evidence.test_log).toBe(forward.review.evidence.test_log)
    expect(reversed.verdict.evidence_bound.test_log_sha256).toBe(forward.verdict.evidence_bound.test_log_sha256)
  })

  it('a failing second record reaches review and cannot be hidden by a passing first one', async () => {
    const g = await gate([graphql, rec('bun test zeta', 2, '1 pass 4 fail')])
    expect(g.review.evidence.test_log).toContain('1 pass 4 fail')
    expect(g.review.evidence.test_log).toContain('exit_code: 2')
  })

  it('a single historical record is still the raw output with its own hash', async () => {
    const g = await gate([rec('bun test only', 0, '12 pass 0 fail')])
    expect(g.review.evidence.test_log).toBe('12 pass 0 fail')
    expect(g.verdict.evidence_bound.test_log_sha256).toBe(sha('12 pass 0 fail'))
  })

  it('refuses malformed test evidence before any review or verdict', async () => {
    const { root, change } = project([{ type: 'command', command: 'bun test x', exit_code: 0, output: 7 as unknown as string }])
    let reviewed = false
    await expect(runGateCode({ changeDir: change, projectRoot: root, skipStateCheck: true,
      sealReviewFn: async () => { reviewed = true; return { verdict: 'PASS', trust_score: 100, blocking_issues: [], next_action: 'none' } } }))
      .rejects.toMatchObject({ code: 'test_evidence_invalid', reason: 'malformed' })
    expect(reviewed).toBe(false)
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { MAX_REVIEWED_DIFF_BYTES, boundDiagnostic, reviewedCodeDiff, reviewedCodeFiles } from '../../src/harness/code-diff.ts'
import { runGateCode } from '../../src/harness/gate-code.ts'
import { TransitionGuard } from '../../src/harness/transition-guard.ts'
import { createPhaseJson, readPhaseJson, writePhaseJson } from '../../src/harness/phase-json.ts'

const roots: string[] = []
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })

/** A committed project with an uncommitted change of known size under a change folder. */
function project(extraBytes = 0) {
  const root = mkdtempSync(join(tmpdir(), 'orca-code-diff-'))
  roots.push(root)
  const change = join(root, 'openspec/changes/big-change')
  mkdirSync(change, { recursive: true })
  writeFileSync(join(root, 'source.js'), 'export const value = 1;\n')
  writeFileSync(join(change, 'phase.json'), '{}\n')
  git(root, 'init', '-q')
  git(root, 'add', '.')
  git(root, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base')
  writeFileSync(join(root, 'source.js'), 'export const value = 2;\n' + '// padding\n'.repeat(Math.ceil(extraBytes / 11)))
  writeFileSync(join(change, 'phase.json'), '{"changed":true}\n')
  mkdirSync(join(change, '.harness'), { recursive: true })
  writeFileSync(join(change, '.harness/state.json'), '{}\n')
  writeFileSync(join(change, '.orca-verify.json'), '{}\n')
  git(root, 'add', '-A')
  return { root, change }
}

function thrown(fn: () => unknown): Record<string, unknown> {
  try { fn() } catch (e) { return e as Record<string, unknown> }
  throw new Error('expected a throw')
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('reviewedCodeDiff size contract', () => {
  it('documents a 64 MiB default ceiling', () => {
    expect(MAX_REVIEWED_DIFF_BYTES).toBe(64 * 1024 * 1024)
  })

  it('returns the complete bytes of a diff above the 1 MiB node default and below the ceiling', () => {
    const { root, change } = project(1_600_000)
    const expected = git(root, 'diff', 'HEAD', '--', '.', ':(top,exclude,literal)openspec/changes/big-change/phase.json',
      ':(top,exclude,literal)openspec/changes/big-change/.harness', ':(top,exclude,literal)openspec/changes/big-change/.orca-verify.json')
    expect(Buffer.byteLength(expected)).toBeGreaterThan(1024 * 1024)
    const diff = reviewedCodeDiff(change)
    expect(diff).toBe(expected)
    expect(createHash('sha256').update(diff).digest('hex')).toBe(createHash('sha256').update(expected).digest('hex'))
  })

  it('accepts a diff exactly at the ceiling and refuses one byte above it', () => {
    const { change } = project(2000)
    const size = Buffer.byteLength(reviewedCodeDiff(change))
    expect(reviewedCodeDiff(change, { maxBytes: size })).toHaveLength(size)
    const err = thrown(() => reviewedCodeDiff(change, { maxBytes: size - 1 }))
    expect(err.code).toBe('diff_collection_failed')
    expect(err.reason).toBe('diff_too_large')
    expect(String(err.message)).toContain(String(size - 1))
    expect((err.details as { errorCode: string }).errorCode).toBe('ENOBUFS')
  })

  it('refuses an oversized file list the same way', () => {
    const { change } = project()
    const err = thrown(() => reviewedCodeFiles(change, { maxBytes: 4 }))
    expect(err.code).toBe('diff_collection_failed')
  })

  it('refuses when git exits non-zero, keeping the raw status separate', () => {
    const { root, change } = project()
    writeFileSync(join(root, '.git/index'), 'not an index')
    const err = thrown(() => reviewedCodeDiff(change))
    expect(err.code).toBe('diff_collection_failed')
    expect(err.reason).toBe('git_failed')
    expect((err.details as { status: number }).status).not.toBe(0)
  })

  it('refuses when git is missing', () => {
    const { change } = project()
    const path = process.env.PATH
    process.env.PATH = join(change, 'no-such-bin')
    try {
      const err = thrown(() => reviewedCodeDiff(change))
      expect(err.code).toBe('diff_collection_failed')
      expect(err.reason).toBe('git_unavailable')
      expect((err.details as { errorCode: string }).errorCode).toBe('ENOENT')
    } finally {
      process.env.PATH = path
    }
  })

  it('refuses a change folder that is not inside a git project', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-code-diff-nogit-'))
    roots.push(dir)
    const err = thrown(() => reviewedCodeDiff(dir))
    expect(err.code).toBe('diff_collection_failed')
  })

  it('keeps the machine-state exclusions while binding the rest of the change', () => {
    const { change } = project()
    const diff = reviewedCodeDiff(change)
    expect(diff).toContain('source.js')
    expect(diff).not.toContain('phase.json')
    expect(diff).not.toContain('.harness')
    expect(diff).not.toContain('.orca-verify.json')
    expect(reviewedCodeFiles(change)).toEqual(['source.js'])
  })

  it('bounds stderr in a diagnosis and drops credentials in URLs', () => {
    const text = boundDiagnostic('fatal: unable to access https://user:secret@example.invalid/repo ' + 'x'.repeat(10_000))
    expect(text).not.toContain('secret')
    expect(text).toContain('https://[redacted]@example.invalid/repo')
    expect(text.length).toBeLessThan(2200)
    expect(text).toContain('truncated')
  })
})

describe('finish gate when the bound diff cannot be collected', () => {
  it('refuses to finish on an unverifiable PASS instead of skipping the binding check', () => {
    const { root, change } = project()
    createPhaseJson(change, 'big-change')
    const pj = readPhaseJson(change)
    for (const phase of Object.keys(pj.phases) as Array<keyof typeof pj.phases>) pj.phases[phase].status = 'complete'
    pj.gate_code_verdict = { verdict: 'PASS', bound_diff_sha256: createHash('sha256').update(reviewedCodeDiff(change)).digest('hex'),
      evidence_bound: { test_log_sha256: null, build_log_sha256: null } }
    writePhaseJson(change, pj)
    expect(() => new TransitionGuard(change).canEnter('finish')).not.toThrow()
    writeFileSync(join(root, '.git/index'), 'not an index')
    expect(() => new TransitionGuard(change).canEnter('finish')).toThrow(/diff_collection_failed/)
  })
})

describe('runGateCode when the diff cannot be collected', () => {
  it('fails closed with diff_collection_failed, never reviewing claims, even with bullet claims', async () => {
    const { root, change } = project(2000)
    writeFileSync(join(change, 'self-check.md'),
      '# Self-Check\n\n## Claims\n- fixed the value\n- added tests\n\n## Evidence\n```json\n[]\n```\n')
    let reviewed = false
    const size = Buffer.byteLength(reviewedCodeDiff(change))
    await expect(runGateCode({ changeDir: change, projectRoot: root, skipStateCheck: true, diffMaxBytes: size - 1,
      sealReviewFn: async () => {
        reviewed = true
        return { verdict: 'PASS', trust_score: 100, blocking_issues: [], next_action: 'none' }
      } })).rejects.toMatchObject({ code: 'diff_collection_failed', reason: 'diff_too_large' })
    expect(reviewed).toBe(false)
    expect(existsSync(join(change, '.harness/gate-verdicts'))).toBe(false)
  })

  it('reviews and binds the complete diff when it fits the ceiling', async () => {
    const { root, change } = project(2000)
    writeFileSync(join(change, 'self-check.md'),
      '# Self-Check\n\n## Claims\n- fixed the value\n\n## Evidence\n```json\n[]\n```\n')
    const expected = reviewedCodeDiff(change)
    let seen: { evidence: { diff: string } } | undefined
    const result = await runGateCode({ changeDir: change, projectRoot: root, skipStateCheck: true, diffMaxBytes: Buffer.byteLength(expected),
      sealReviewFn: async (input: unknown) => {
        seen = input as typeof seen
        return { verdict: 'PASS', trust_score: 100, blocking_issues: [], next_action: 'none' }
      } })
    expect(seen!.evidence.diff).toBe(expected)
    expect(result.bound_diff_sha256).toBe(createHash('sha256').update(expected).digest('hex'))
  })
})

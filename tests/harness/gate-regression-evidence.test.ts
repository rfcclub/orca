import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { regressionEvidence, runGateCode } from '../../src/harness/gate-code.ts'
import { hashBytes } from '../../src/verify/execution.ts'

const cli = fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url))
const modules = fileURLToPath(new URL('../../node_modules', import.meta.url))
const roots: string[] = []
const assertion = '[value-correct] computes a value'

/** A real project whose value is wrong, with RED recorded and then the fix verified. */
function fixedProject() {
  const root = mkdtempSync(join(tmpdir(), 'orca-gate-regression-'))
  roots.push(root)
  const change = join(root, 'openspec/changes/value-fix')
  mkdirSync(change, { recursive: true })
  mkdirSync(join(root, 'tests'))
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n')
  writeFileSync(join(root, '.gitignore'), 'node_modules\n')
  writeFileSync(join(root, 'source.js'), 'export const value = 2;\n')
  writeFileSync(join(root, 'other.js'), 'export const other = 1;\n')
  writeFileSync(join(root, 'tests/value.test.js'), `import {it, expect} from 'vitest';
import {value} from '../source.js';
it('${assertion}', () => expect(value).toBe(1));
`)
  writeFileSync(join(change, 'spec.md'), `# Value Specification
## Requirements
### Requirement: Value
The value MUST be correct.
#### Scenario: Correct
- **WHEN** the value is read
- **THEN** it is one
`)
  writeFileSync(join(change, '.traceability.yaml'), 'scenarios:\n  - scenario: value-correct\n    test: tests/value.test.js\n')
  writeFileSync(join(change, 'self-check.md'), '# Self-Check\n\n## Claims\n- fix: value is one\n\n## Evidence\n```json\n' +
    JSON.stringify([{ type: 'command', command: 'npm test', exit_code: 0, output: '1 pass, 0 fail' }]) + '\n```\n')
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['add', '.'], { cwd: root })
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root })
  symlinkSync(modules, join(root, 'node_modules'), 'dir')
  const red = spawnSync(process.execPath, [cli, 'record-red', 'value-fix'], { cwd: root, encoding: 'utf8' })
  if (red.status !== 0) throw new Error('record-red failed: ' + red.stdout + red.stderr)
  writeFileSync(join(root, 'source.js'), 'export const value = 1;\n')
  writeFileSync(join(root, 'other.js'), 'export const other = 2;\n')
  const green = spawnSync(process.execPath, [cli, 'verify', 'value-fix'], { cwd: root, encoding: 'utf8' })
  if (green.status !== 0) throw new Error('verify failed: ' + green.stdout + green.stderr)
  return { root, change }
}

async function gateInput(root: string, change: string) {
  let seen: { evidence: Record<string, unknown> } | undefined
  const result = await runGateCode({ changeDir: change, projectRoot: root, skipStateCheck: true,
    sealReviewFn: async (input: unknown) => {
      seen = input as typeof seen
      return { verdict: 'PASS', trust_score: 100, blocking_issues: [], next_action: 'none', advisory_notes: [] }
    } })
  return { evidence: seen!.evidence, result: result as typeof result & { reviewed_files?: string[] } }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('gate-code regression evidence', () => {
  it('receipts-passed: fresh RED and verify receipts reach Seal', async () => {
    const { root, change } = fixedProject()
    const { evidence } = await gateInput(root, change)
    const hash = hashBytes(readFileSync(join(root, 'tests/value.test.js')))
    const record = (status: string) => ({ test: 'tests/value.test.js', name: assertion, status, test_sha256: hash })
    expect(evidence.regression).toEqual({ red: [record('failed')], green: [record('passed')] })
  }, 60000)

  it('current-red: no regression evidence when the current tree fails the test', async () => {
    const { root, change } = fixedProject()
    writeFileSync(join(root, 'source.js'), 'export const value = 3; // broken after verify\n')
    const { evidence } = await gateInput(root, change)
    expect(evidence.regression).toBeUndefined()
  }, 60000)

  it('reviewed-files: the result lists the reviewed files', async () => {
    const { root, change } = fixedProject()
    const { result } = await gateInput(root, change)
    expect(result.reviewed_files).toEqual(expect.arrayContaining(['source.js', 'other.js']))
  }, 60000)
})

const git = (root: string, ...args: string[]) => execFileSync('git',
  ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, encoding: 'utf8' })

describe('gate-code regression evidence review fixes', () => {
  it('committed-fix: an earlier RED does not count for a later, unrelated change', async () => {
    const { root, change } = fixedProject()
    git(root, 'add', 'source.js', 'other.js')
    git(root, 'commit', '-qm', 'fix value')
    writeFileSync(join(root, 'other.js'), 'export const other = 3; // fix another bug\n')
    const verify = spawnSync(process.execPath, [cli, 'verify', 'value-fix'], { cwd: root, encoding: 'utf8' })
    expect(verify.status, verify.stdout + verify.stderr).toBe(0)
    const { evidence } = await gateInput(root, change)
    expect(evidence.regression).toBeUndefined()
  }, 90000)

  it('forged-red: a RED receipt made from a GREEN one gives no regression evidence', async () => {
    const { root, change } = fixedProject()
    git(root, 'add', 'source.js', 'other.js')
    git(root, 'commit', '-qm', 'fix value')
    writeFileSync(join(root, 'other.js'), 'export const other = 3;\n')
    const verify = spawnSync(process.execPath, [cli, 'verify', 'value-fix'], { cwd: root, encoding: 'utf8' })
    expect(verify.status, verify.stdout + verify.stderr).toBe(0)
    const forged = JSON.parse(readFileSync(join(change, '.orca-verify.json'), 'utf8'))
    const report = JSON.parse(forged.execution.report)
    report.success = false
    report.numFailedTests = report.numTotalTests
    report.numPassedTests = 0
    for (const file of report.testResults) {
      file.status = 'failed'
      for (const a of file.assertionResults) { a.status = 'failed'; a.failureMessages = ['AssertionError: expected 2 to be 1'] }
    }
    forged.execution.report = JSON.stringify(report)
    forged.execution.report_sha256 = hashBytes(forged.execution.report)
    forged.execution.outcome = 'red'
    forged.execution.command.exit_code = 1
    forged.execution.assertions = forged.execution.assertions.map((a: object) =>
      ({ ...a, status: 'failed', failures: ['AssertionError: expected 2 to be 1'] }))
    writeFileSync(join(change, '.orca-red.json'), JSON.stringify(forged))
    const { evidence } = await gateInput(root, change)
    expect(evidence.regression).toBeUndefined()
  }, 90000)

  it('quoted-path: reviewed files include paths Git quotes', async () => {
    const { root, change } = fixedProject()
    writeFileSync(join(root, 'đăng-nhập.js'), 'export const a = 1;\n')
    git(root, 'add', 'đăng-nhập.js')
    git(root, 'commit', '-qm', 'unicode file')
    writeFileSync(join(root, 'đăng-nhập.js'), 'export const a = 2;\n')
    const { result } = await gateInput(root, change)
    expect(result.reviewed_files).toContain('đăng-nhập.js')
  }, 90000)
})

const hasBun = (() => { try { execFileSync('bun', ['--version']); return true } catch { return false } })()

describe('gate-code regression evidence second review', () => {
  it('diff-changed: a tracked file written during replay stops the gate instead of returning a verdict', async () => {
    const { root, change } = fixedProject()
    mkdirSync(join(root, 'openspec/other'), { recursive: true })
    writeFileSync(join(root, 'openspec/other/policy.md'), 'policy v1\n')
    git(root, 'add', 'openspec/other/policy.md')
    git(root, 'commit', '-qm', 'policy')
    writeFileSync(join(root, 'tests/value.test.js'), `import {it, expect} from 'vitest';
import {writeFileSync} from 'node:fs';
import {value} from '../source.js';
it('${assertion}', () => {
  writeFileSync(new URL('../openspec/other/policy.md', import.meta.url), 'policy written by a test\\n');
  expect(value).toBe(1);
});
`)
    const outcome = await gateInput(root, change).then(() => null, (e: Error) => e)
    expect(String(outcome?.message)).toContain('changed')
  }, 90000)

  it.skipIf(!hasBun)('bun-replay: a Bun project gets regression evidence from RED at HEAD and GREEN now', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-gate-bun-'))
    roots.push(root)
    const change = join(root, 'openspec/changes/value-fix')
    mkdirSync(change, { recursive: true })
    mkdirSync(join(root, 'tests'))
    writeFileSync(join(root, 'package.json'), '{"type":"module"}\n')
    writeFileSync(join(root, '.gitignore'), 'node_modules\n')
    writeFileSync(join(root, 'source.js'), 'export const value = 2;\n')
    writeFileSync(join(root, 'tests/value.test.js'), `import {test, expect} from 'bun:test';
import {value} from '../source.js';
test('${assertion}', () => expect(value).toBe(1));
`)
    writeFileSync(join(change, 'spec.md'), '# Value Specification\n## Requirements\n### Requirement: Value\nThe value MUST be correct.\n#### Scenario: Correct\n- **WHEN** the value is read\n- **THEN** it is one\n')
    writeFileSync(join(change, '.traceability.yaml'), `scenarios:\n  - scenario: value-correct\n    test: tests/value.test.js\n    assertion: "${assertion}"\n`)
    git(root, 'init', '-q')
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'fixture')
    writeFileSync(join(root, 'openspec/config.yaml'), 'schema: spec-driven\ntdd:\n  framework: bun\n')
    symlinkSync(modules, join(root, 'node_modules'), 'dir')
    writeFileSync(join(root, 'source.js'), 'export const value = 1;\n')
    const evidence = regressionEvidence(root, change)
    expect(evidence && [evidence.red.map(r => r.status), evidence.green.map(r => r.status)]).toEqual([['failed'], ['passed']])
  }, 90000)
})

describe('gate-code regression evidence third review', () => {
  it('nested-cwd: orca gate-code run from a subdirectory still replays against the project root', () => {
    const { root, change } = fixedProject()
    const run = spawnSync(process.execPath, [cli, 'gate-code', 'value-fix', '--skip-state-check'],
      { cwd: join(root, 'tests'), encoding: 'utf8' })
    const folder = join(change, '.harness/gate-verdicts')
    const latest = readdirSync(folder).filter(n => /^\d+\.json$/.test(n)).sort().at(-1)
    expect(latest, run.stdout + run.stderr).toBeDefined()
    expect(JSON.parse(readFileSync(join(folder, latest!), 'utf8')).regression_evidence).toBe(true)
  }, 90000)
})
describe('gate-code regression evidence fourth review', () => {
  it('git-failure-recheck: aborts without verdict if the reviewed diff cannot be reread', async () => {
    const { root, change } = fixedProject()
    let moved = false
    try {
      const outcome = await runGateCode({ changeDir: change, projectRoot: root, skipStateCheck: true,
        sealReviewFn: async () => {
          renameSync(join(root, '.git'), join(root, '.git-disabled'))
          moved = true
          return { verdict: 'PASS', trust_score: 100, blocking_issues: [], next_action: 'none', advisory_notes: [] }
        } }).then(() => 'returned', () => 'rejected')
      const verdicts = join(change, '.harness/gate-verdicts')
      const recorded = existsSync(verdicts) ? readdirSync(verdicts).filter(n => /^\d+\.json$/.test(n)).length : 0
      expect(moved).toBe(true)
      expect([outcome, recorded]).toEqual(['rejected', 0])
    } finally { if (moved) renameSync(join(root, '.git-disabled'), join(root, '.git')) }
  }, 90000)

  it('git-failure-list: aborts without verdict if reviewed files cannot be enumerated', async () => {
    const { root, change } = fixedProject()
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
    const bin = join(root, 'fake-bin')
    mkdirSync(bin)
    const wrapper = join(bin, 'git')
    const marker = join(root, 'list-failure-seen')
    writeFileSync(wrapper, `#!/bin/sh\ncase " $* " in *" --name-only "*) : > "${marker}"; echo 'injected list failure' >&2; exit 71;; esac\nexec "${realGit}" "$@"\n`)
    chmodSync(wrapper, 0o755)
    const previous = process.env.PATH
    try {
      process.env.PATH = `${bin}:${previous ?? ''}`
      const outcome = await gateInput(root, change).then(() => 'returned', () => 'rejected')
      const verdicts = join(change, '.harness/gate-verdicts')
      const recorded = existsSync(verdicts) ? readdirSync(verdicts).filter(n => /^\d+\.json$/.test(n)).length : 0
      expect(existsSync(marker)).toBe(true)
      expect([outcome, recorded]).toEqual(['rejected', 0])
    } finally { process.env.PATH = previous }
  }, 90000)
})

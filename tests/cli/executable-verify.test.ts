import { afterEach, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkOutcomes } from '../../src/harness/outcomes.js';
import { hashBytes } from '../../src/verify/execution.js';

const cli = fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url));
const modules = fileURLToPath(new URL('../../node_modules', import.meta.url));
const roots: string[] = [];

function project(test: string) {
  const root = mkdtempSync(join(tmpdir(), 'orca-verify-cli-'));
  roots.push(root);
  const change = join(root, 'openspec/changes/value-fix');
  mkdirSync(change, { recursive: true });
  mkdirSync(join(root, 'tests'));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(root, '.gitignore'), 'node_modules\n');
  writeFileSync(join(root, 'source.js'), 'export const value = 1;\n');
  writeFileSync(join(root, 'tests/value.test.js'), test);
  writeFileSync(join(change, 'spec.md'), `# Value Specification
## Requirements
### Requirement: Value
The value MUST be correct.
#### Scenario: Correct
- **WHEN** the value is read
- **THEN** it is one
`);
  writeFileSync(join(change, '.traceability.yaml'), `scenarios:
  - scenario: value-correct
    test: tests/value.test.js
    status: failing
  - scenario: unrelated
    status: passing
`);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-qm', 'fixture'], { cwd: root });
  symlinkSync(modules, join(root, 'node_modules'), 'dir');
  return { root, change };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('default verify executes mapped assertions and ignores YAML status and unrelated IDs', () => {
  const { root, change } = project(`import {it, expect} from 'vitest';
import {value} from '../source.js';
it('[value-correct] computes a value', () => expect(value).toBe(1));
`);
  const run = spawnSync(process.execPath, [cli, 'verify', 'value-fix'], { cwd: root, encoding: 'utf8' });
  expect(run.status, run.stdout + run.stderr).toBe(0);
  const receipt = JSON.parse(readFileSync(join(change, '.orca-verify.json'), 'utf8'));
  expect(receipt.passed).toBe(true);
  expect(receipt.execution_verified).toBe(true);
  expect(receipt.passing).toBe(1);
  expect(receipt.total_scenarios).toBe(1);
  expect(receipt.execution.source.head).toMatch(/^[a-f0-9]{40}$/);
  expect(receipt.execution.command.exit_code).toBe(0);
}, 30000);

it('forged passing YAML with a missing required test fails verify with no execution proof and nonzero exit', () => {
  const { root, change } = project(`import {it, expect} from 'vitest';
it('[value-correct]', () => expect(1).toBe(1));`);
  rmSync(join(root, 'tests/value.test.js'));
  writeFileSync(join(change, '.traceability.yaml'), 'scenarios:\n  - scenario: value-correct\n    test: tests/value.test.js\n    status: passing\n');
  const run = spawnSync(process.execPath, [cli, 'verify', 'value-fix'], { cwd: root, encoding: 'utf8' });
  expect(run.status, run.stdout + run.stderr).not.toBe(0);
  const receipt = JSON.parse(readFileSync(join(change, '.orca-verify.json'), 'utf8'));
  expect(receipt.passed).toBe(false);
  expect(receipt.execution).toBeNull();
  expect(receipt.passing).toBe(0);
});

it.each([
  [['--base', 'HEAD', '--coverage-only']],
  [['--harness', 'tests/value.test.js']],
])('does not silently ignore an incompatible replay option set %j', flags => {
  const { root, change } = project(`import {it, expect} from 'vitest';
it('[value-correct]', () => expect(1).toBe(1));
`);
  writeFileSync(join(change, '.traceability.yaml'), 'scenarios:\n  - scenario: value-correct\n    test: tests/value.test.js\n    status: passing\n');
  const run = spawnSync(process.execPath, [cli, 'verify', 'value-fix', ...flags], { cwd: root, encoding: 'utf8' });
  expect(run.status, run.stdout + run.stderr).not.toBe(0);
}, 30000);

it('returns a failure exit for an unknown change', () => {
  const { root } = project(`import {it, expect} from 'vitest'; it('[value-correct]', () => expect(1).toBe(1));`);
  const run = spawnSync(process.execPath, [cli, 'verify', 'missing-change'], { cwd: root, encoding: 'utf8' });
  expect(run.status).not.toBe(0);
});

it('rejects an execution that rewrites its spec or mapping', () => {
  const { root, change } = project(`import {it, expect} from 'vitest';
import {writeFileSync} from 'node:fs';
it('[value-correct]', () => {
  writeFileSync('openspec/changes/value-fix/spec.md', '# No requirements');
  expect(1).toBe(1);
});
`);
  const run = spawnSync(process.execPath, [cli, 'verify', 'value-fix'], { cwd: root, encoding: 'utf8' });
  expect(run.status, run.stdout + run.stderr).not.toBe(0);
  const receipt = JSON.parse(readFileSync(join(change, '.orca-verify.json'), 'utf8'));
  expect(receipt.reasons.join(' ')).toContain('changed during execution');
}, 30000);

it('verify --base stores fail-at-base and pass-at-exact-dirty-head receipts', () => {
  const { root, change } = project(`import {it, expect} from 'vitest';
import {value} from '../source.js';
it('[value-correct]', () => expect(value).toBe(2));
`);
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  writeFileSync(join(root, 'source.js'), 'export const value = 2;\n');
  const before = execFileSync('git', ['status', '--porcelain=v1'], { cwd: root, encoding: 'utf8' });
  const run = spawnSync(process.execPath, [cli, 'verify', 'value-fix', '--base', base], { cwd: root, encoding: 'utf8' });
  expect(run.status, run.stdout + run.stderr).toBe(0);
  const receipt = JSON.parse(readFileSync(join(change, '.orca-verify.json'), 'utf8'));
  expect(receipt.replay?.passed).toBe(true);
  expect(receipt.replay.base_revision).toBe(base);
  expect(receipt.replay.base.outcome).toBe('red');
  expect(receipt.replay.head.outcome).toBe('green');
  expect(execFileSync('git', ['diff', '--', 'source.js'], { cwd: root, encoding: 'utf8' })).toContain('export const value = 2');
  expect(before).toContain(' M source.js');
}, 30000);

it('labels explicit historical coverage-only bookkeeping as non-executable', () => {
  const { root, change } = project(`import {it, expect} from 'vitest';
it('[value-correct]', () => expect(1).toBe(2));
`);
  writeFileSync(join(change, '.traceability.yaml'), `scenarios:
  - scenario: value-correct
    status: passing
  - scenario: unrelated
    status: passing
  - scenario: unrelated
    status: passing
`);
  const run = spawnSync(process.execPath, [cli, 'verify', 'value-fix', '--coverage-only'], { cwd: root, encoding: 'utf8' });
  expect(run.status, run.stdout + run.stderr).toBe(0);
  const receipt = JSON.parse(readFileSync(join(change, '.orca-verify.json'), 'utf8'));
  expect(receipt.mode).toBe('coverage-only');
  expect(receipt.execution_verified).toBe(false);
  expect(receipt.execution).toBeNull();
  expect(receipt.passing).toBe(1);
}, 30000);

it('record-red records an actual failed assertion instead of a GREEN verify receipt', () => {
  const { root, change } = project(`import {it, expect} from 'vitest';
import {value} from '../source.js';
it('[value-correct] computes a value', () => expect(value).toBe(2));
`);
  const run = spawnSync(process.execPath, [cli, 'record-red', 'value-fix'], { cwd: root, encoding: 'utf8' });
  expect(run.status, run.stdout + run.stderr).toBe(0);
  const receipt = JSON.parse(readFileSync(join(change, '.orca-red.json'), 'utf8'));
  expect(receipt.execution.outcome).toBe('red');
  expect(receipt.execution.command.exit_code).toBe(1);
  expect(receipt.execution_verified).toBe(false);
}, 30000);

it('implementation acceptance executes a fresh contract and still requires human review', async () => {
  const { root, change } = project(`import {it, expect} from 'vitest';
import {value} from '../source.js';
it('[value-correct]', () => expect(value).toBe(1));`);
  const intent = '# Intent\n## Success Criteria\n- Correct value\n## Intent Approval\nStatus: APPROVED\n';
  writeFileSync(join(change, 'intent.md'), intent);
  const run = spawnSync(process.execPath, [cli, 'verify', 'value-fix'], { cwd: root, encoding: 'utf8' });
  expect(run.status, run.stdout + run.stderr).toBe(0);
  const scope = { environment: 'fixture', revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    boundary: 'value assertion' };
  const contract = { version: 1, intent_sha256: hashBytes(intent), stages: [{
    id: 'code', outcome: 'implementation', scope, criteria: ['SC-1'], evidence: [{
      kind: 'tests', path: '.orca-verify.json', sha256: hashBytes(readFileSync(join(change, '.orca-verify.json'))), scope,
    }],
  }] };
  writeFileSync(join(change, 'tasks.md'), '```orca-outcomes\n' + JSON.stringify(contract) + '\n```\n');
  expect((await checkOutcomes(change)).stages[0].state).toBe('review-required');
  const accepted = await checkOutcomes(change, { review: async () => true });
  expect(accepted.complete).toBe(true);
  expect(accepted.stages[0].state).toBe('implementation-verified');
  const changedDuringReview = await checkOutcomes(change, { review: async () => {
    writeFileSync(join(root, 'source.js'), 'export const value = 2;\n');
    return true;
  } });
  expect(changedDuringReview.complete).toBe(false);
  writeFileSync(join(root, 'source.js'), 'export const value = 2;\n');
  const stale = await checkOutcomes(change, { review: async () => true });
  expect(stale.complete).toBe(false);
  expect(stale.stages[0].reasons.join(' ')).toContain('stale');
}, 30000);

it('archives a freshly executed change with absent optional metadata', () => {
  const { root } = project(`import {it, expect} from 'vitest';
it('[value-correct]', () => expect(1).toBe(1));`);
  const verified = spawnSync(process.execPath, [cli, 'verify', 'value-fix'], { cwd: root, encoding: 'utf8' });
  expect(verified.status, verified.stdout + verified.stderr).toBe(0);
  const archived = spawnSync(process.execPath, [cli, 'archive', 'value-fix'], { cwd: root, encoding: 'utf8' });
  expect(archived.status, archived.stdout + archived.stderr).toBe(0);
}, 30000);

it('archive reruns assertions instead of accepting a previously passing reporter', () => {
  const { root, change } = project(`import {it, expect} from 'vitest';
it('[value-correct]', () => expect(process.env.ORCA_FIXTURE_FAIL ?? 'no').toBe('no'));`);
  const verified = spawnSync(process.execPath, [cli, 'verify', 'value-fix'], { cwd: root, encoding: 'utf8' });
  expect(verified.status).toBe(0);
  const archived = spawnSync(process.execPath, [cli, 'archive', 'value-fix'], { cwd: root, encoding: 'utf8',
    env: { ...process.env, ORCA_FIXTURE_FAIL: 'yes' } });
  expect(archived.status, archived.stdout + archived.stderr).not.toBe(0);
  expect(readFileSync(join(change, 'spec.md'), 'utf8')).toContain('Requirement: Value');
}, 30000);

it.each(['legacy', 'coverage-only', 'selection', 'spec', 'mapping', 'report'])(
  'archive rejects altered or historical verification evidence: %s', defect => {
    const { root, change } = project(`import {it, expect} from 'vitest';
it('[value-correct]', () => expect(1).toBe(1));`);
    const verified = spawnSync(process.execPath, [cli, 'verify', 'value-fix'], { cwd: root, encoding: 'utf8' });
    expect(verified.status).toBe(0);
    const path = join(change, '.orca-verify.json');
    const receipt = JSON.parse(readFileSync(path, 'utf8'));
    if (defect === 'legacy') writeFileSync(path, '{"passed":true}');
    else if (defect === 'coverage-only') { receipt.mode = 'coverage-only'; writeFileSync(path, JSON.stringify(receipt)); }
    else if (defect === 'selection') { receipt.execution.selection[0].id = 'unrelated'; writeFileSync(path, JSON.stringify(receipt)); }
    else if (defect === 'spec') writeFileSync(join(change, 'spec.md'), '# Missing requirements');
    else if (defect === 'mapping') writeFileSync(join(change, '.traceability.yaml'), 'scenarios: []');
    else { receipt.execution.report = '{}'; writeFileSync(path, JSON.stringify(receipt)); }
    const archived = spawnSync(process.execPath, [cli, 'archive', 'value-fix'], { cwd: root, encoding: 'utf8' });
    expect(archived.status, archived.stdout + archived.stderr).not.toBe(0);
  }, 30000);

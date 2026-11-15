import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hasBun = (() => { try { execFileSync('bun', ['--version']); return true; } catch { return false; } })();
const modules = fileURLToPath(new URL('../../node_modules', import.meta.url));
const roots: string[] = [];

function project(files: Record<string, string>, framework: string | null = 'bun'): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-bun-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(root, '.gitignore'), 'node_modules\n');
  writeFileSync(join(root, 'source.js'), 'export const value = 1;\n');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const git = (args: string[]) => execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root });
  git(['init', '-q']);
  git(['add', '.']);
  git(['commit', '-qm', 'fixture']);
  if (framework) {
    mkdirSync(join(root, 'openspec'));
    writeFileSync(join(root, 'openspec/config.yaml'), `schema: spec-driven\ntdd:\n  framework: ${framework}\n`);
  }
  return root;
}

const bunTest = (body: string) => `import {test, expect, describe} from 'bun:test';
import {value} from '../source.js';
${body}
`;
const value = 'tests/value.test.js';
const execution = () => import('../../src/verify/execution.js');
const run = async (root: string, selection: { id: string; test: string; assertion?: string; property?: unknown }[]) =>
  (await execution()).executeTests(root, selection as never);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('runner choice', () => {
  it('[BUN-002] keeps the Vitest runner when tdd.framework is vitest', async () => {
    const root = project({ [value]: `import {it, expect} from 'vitest';
import {value} from '../source.js';
it('[value-correct] computes a value', () => expect(value).toBe(1));
` }, 'vitest');
    symlinkSync(modules, join(root, 'node_modules'), 'dir');
    const receipt = await run(root, [{ id: 'value-correct', test: value }]);
    expect(receipt.outcome, JSON.stringify(receipt.reasons)).toBe('green');
    expect((receipt.runner as { framework?: string }).framework).toBeUndefined();
  }, 30000);

  it('[BUN-002] reads only tdd.framework, so an unset placeholder elsewhere in config does not break Vitest', async () => {
    const root = project({ [value]: `import {it, expect} from 'vitest';
import {value} from '../source.js';
it('[value-correct] computes a value', () => expect(value).toBe(1));
` }, null);
    mkdirSync(join(root, 'openspec'));
    writeFileSync(join(root, 'openspec/config.yaml'), 'schema: spec-driven\ndrafting:\n  provider: ${ORCA_TEST_UNSET_PROVIDER}\n');
    symlinkSync(modules, join(root, 'node_modules'), 'dir');
    const receipt = await run(root, [{ id: 'value-correct', test: value }]);
    expect(receipt.outcome, JSON.stringify(receipt.reasons)).toBe('green');
  }, 30000);

  it.each(['jest', 'pytest', 'xunit', 'custom'])('[BUN-003] refuses tdd.framework %s before running anything', async framework => {
    const root = project({ [value]: bunTest(`test('[value-correct] v', () => expect(value).toBe(1));`) }, framework);
    await expect(run(root, [{ id: 'value-correct', test: value }])).rejects.toThrow(/unsupported/);
  });
});

describe.skipIf(!hasBun)('bun runner', () => {
  it('[BUN-001] runs a passing bun:test assertion to GREEN through Bun', async () => {
    const root = project({ [value]: bunTest(`test('[value-correct] v', () => expect(value).toBe(1));`) });
    const receipt = await run(root, [{ id: 'value-correct', test: value }]);
    expect(receipt.outcome, JSON.stringify({ reasons: receipt.reasons, stderr: receipt.command.stderr })).toBe('green');
    expect((receipt.runner as { framework?: string }).framework).toBe('bun');
    expect(receipt.command.exit_code).toBe(0);
  }, 30000);

  it('[BUN-001] reads the JUnit <properties> Bun writes under GitHub Actions', async () => {
    const root = project({ [value]: bunTest(`test('[value-correct] v', () => expect(value).toBe(1));`) });
    const ci = { GITHUB_ACTIONS: 'true', GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'x/y', GITHUB_RUN_ID: '1', GITHUB_SHA: 'abc' };
    const saved = Object.fromEntries(Object.keys(ci).map(k => [k, process.env[k]]));
    Object.assign(process.env, ci);
    try {
      const receipt = await run(root, [{ id: 'value-correct', test: value }]);
      expect(receipt.outcome, JSON.stringify(receipt.reasons)).toBe('green');
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  }, 30000);

  it('[BUN-001] runs only the selected file, not every path containing its name', async () => {
    const root = project({
      [value]: bunTest(`test('[value-correct] v', () => expect(value).toBe(1));`),
      'other/tests/value.test.js': `import {test, expect} from 'bun:test';\ntest('[elsewhere] fails', () => expect(1).toBe(2));\n`,
    });
    const receipt = await run(root, [{ id: 'value-correct', test: value }]);
    expect(receipt.outcome, JSON.stringify(receipt.reasons)).toBe('green');
  }, 30000);

  it('[BUN-004] binds the bun binary, the test bytes and the source', async () => {
    const root = project({ [value]: bunTest(`test('[value-correct] v', () => expect(value).toBe(1));`) });
    const receipt = await run(root, [{ id: 'value-correct', test: value }]);
    expect(receipt.runner.entry.startsWith('/')).toBe(true);
    expect(receipt.runner.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.runner.version).toBe(execFileSync(receipt.runner.entry, ['--version'], { encoding: 'utf8' }).trim());
    expect(receipt.tests[value]).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.source.head).toMatch(/^[a-f0-9]{40}$/);
    expect(receipt.report_sha256).toMatch(/^[a-f0-9]{64}$/);
  }, 30000);

  it.each([
    ['toBe', `test('[value-correct] v', () => expect(value).toBe(2));`],
    ['not', `test('[value-correct] v', () => expect(value).not.toBe(1));`],
    ['resolves', `test('[value-correct] v', async () => { await expect(Promise.resolve(value)).resolves.toBe(2); });`],
  ])('[BUN-005] records genuine RED for a failing expect (%s)', async (_name, body) => {
    const root = project({ [value]: bunTest(body) });
    const receipt = await run(root, [{ id: 'value-correct', test: value }]);
    expect(receipt.outcome, JSON.stringify({ reasons: receipt.reasons, stderr: receipt.command.stderr })).toBe('red');
    expect(receipt.command.exit_code).toBe(1);
    expect(receipt.assertions[0].failures[0]).toMatch(/^AssertionError\b/);
  }, 30000);

  it.each([
    ['type error', `test('[value-correct] v', () => { throw new TypeError('boom'); });`],
    ['rejected promise', `test('[value-correct] v', async () => { await Promise.reject(new Error('x')); });`],
    ['throw after a passing expect', `test('[value-correct] v', () => { expect(value).toBe(1); throw new TypeError('boom'); });`],
  ])('[BUN-006] leaves a non-assertion failure (%s) inconclusive', async (_name, body) => {
    const root = project({ [value]: bunTest(body) });
    const receipt = await run(root, [{ id: 'value-correct', test: value }]);
    expect(receipt.outcome, JSON.stringify(receipt.reasons)).toBe('inconclusive');
    expect((receipt.runner as { framework?: string }).framework).toBe('bun');
    expect(receipt.assertions[0]?.status).toBe('failed');
    expect(receipt.assertions[0]?.failures.join('\n')).not.toMatch(/^AssertionError/);
    expect(receipt.reasons.join('\n')).toContain('did not establish GREEN or assertion-failure RED');
  }, 30000);

  it('[BUN-007] leaves a test file that fails to load inconclusive', async () => {
    const root = project({ [value]: `import './missing.js';\n${bunTest(`test('[value-correct] v', () => expect(value).toBe(1));`)}` });
    const receipt = await run(root, [{ id: 'value-correct', test: value }]);
    expect(receipt.outcome, JSON.stringify(receipt.reasons)).toBe('inconclusive');
    expect((receipt.runner as { framework?: string }).framework).toBe('bun');
    expect(receipt.reasons.join('\n')).toMatch(/Expected exactly one executed assertion|unhandled error|Missing or invalid Bun report/);
  }, 30000);

  it.each([
    ['unrelated', `test('unrelated', () => expect(value).toBe(1));`],
    ['ambiguous', `test('[value-correct] a', () => expect(value).toBe(1)); test('[value-correct] b', () => expect(value).toBe(1));`],
    ['skipped', `test.skip('[value-correct] v', () => expect(value).toBe(1));`],
    ['todo', `test.todo('[value-correct] v');`],
  ])('[BUN-008] leaves a %s selection inconclusive', async (_name, body) => {
    const root = project({ [value]: bunTest(body) });
    const receipt = await run(root, [{ id: 'value-correct', test: value }]);
    expect(receipt.outcome, JSON.stringify(receipt.reasons)).toBe('inconclusive');
    expect((receipt.runner as { framework?: string }).framework).toBe('bun');
    expect(receipt.reasons.join('\n')).toMatch(/Expected exactly one executed assertion|did not establish GREEN/);
  }, 30000);

  it('[BUN-009] does not accept a passing test that ran no expect', async () => {
    const root = project({ [value]: bunTest(`test('[value-correct] empty', () => {});`) });
    const receipt = await run(root, [{ id: 'value-correct', test: value }]);
    expect(receipt.outcome).toBe('inconclusive');
    expect(receipt.reasons.join('\n')).toContain('assertion');
  }, 30000);

  it('[BUN-010] cannot reuse one executed test for two ids', async () => {
    const root = project({ [value]: bunTest(`test('[first][second] one', () => expect(value).toBe(1));`) });
    const receipt = await run(root, [{ id: 'first', test: value }, { id: 'second', test: `./${value}` }]);
    expect(receipt.outcome).toBe('inconclusive');
    expect(receipt.reasons.join('\n')).toContain('reused');
  }, 30000);

  it('[BUN-011] matches an exact nested describe name', async () => {
    const root = project({ [value]: bunTest(`describe('outer', () => { describe('inner', () => { test('[deep] d', () => expect(value).toBe(1)); }); });
test('[deep] top', () => expect(value).toBe(1));`) });
    const receipt = await run(root, [{ id: 'deep', test: value, assertion: 'outer > inner > [deep] d' }]);
    expect(receipt.outcome, JSON.stringify(receipt.reasons)).toBe('green');
    expect(receipt.assertions[0].name).toBe('outer > inner > [deep] d');
  }, 30000);

  it('[BUN-012] re-validates untouched Bun GREEN and RED receipts', async () => {
    const { validateExecutionReceipt } = await execution();
    const green = project({ [value]: bunTest(`test('[value-correct] v', () => expect(value).toBe(1));`) });
    const red = project({ [value]: bunTest(`test('[value-correct] v', () => expect(value).toBe(2));`) });
    const g = await run(green, [{ id: 'value-correct', test: value }]);
    const r = await run(red, [{ id: 'value-correct', test: value }]);
    expect(g.outcome).toBe('green');
    expect(r.outcome).toBe('red');
    expect(validateExecutionReceipt(green, g)).toBe(true);
    expect(validateExecutionReceipt(red, r)).toBe(true);
  }, 60000);

  it('[BUN-013] rejects a tampered Bun receipt', async () => {
    const { hashBytes, validateExecutionReceipt } = await execution();
    const root = project({ [value]: bunTest(`test('[value-correct] v', () => expect(value).toBe(2));`) });
    const receipt = await run(root, [{ id: 'value-correct', test: value }]);
    expect(receipt.outcome).toBe('red');
    const report = JSON.parse(receipt.report);
    report.stderr = report.stderr.split(report.mark).join('');
    const forged = JSON.stringify(report);
    expect(validateExecutionReceipt(root, { ...receipt, report: forged })).toBe(false);
    expect(validateExecutionReceipt(root, { ...receipt, report: forged, report_sha256: hashBytes(forged) })).toBe(false);
    expect(validateExecutionReceipt(root, { ...receipt, assertions: [{ ...receipt.assertions[0], status: 'passed' }] })).toBe(false);
  }, 30000);

  it('[BUN-014] leaves a run that changes its inputs inconclusive', async () => {
    const root = project({ [value]: `import {test, expect} from 'bun:test';
import {writeFileSync} from 'node:fs';
test('[value-correct] v', () => { expect(1).toBe(1); writeFileSync('source.js', 'export const value = 2;\\n'); });
` });
    const receipt = await run(root, [{ id: 'value-correct', test: value }]);
    expect(receipt.outcome, JSON.stringify(receipt.reasons)).toBe('inconclusive');
    expect((receipt.runner as { framework?: string }).framework).toBe('bun');
    expect(receipt.reasons.join('\n')).toContain('Execution inputs changed');
  }, 30000);

  it('[BUN-015] refuses a property selection on Bun', async () => {
    const root = project({ [value]: bunTest(`test('[value-correct] v', () => expect(value).toBe(1));`) });
    await expect(run(root, [{ id: 'value-correct', test: value, property: { name: 'p' } }])).rejects.toThrow(/property/);
  });

  // Modified by gate-code-evidence: Bun replay is supported, and the base still never falls back to
  // Vitest; the fixture's tdd.framework config is uncommitted, so only the overlay makes the base Bun.
  it.skipIf(!hasBun)('[BUN-016] --base replay on Bun runs base and head under Bun, never Vitest', async () => {
    const root = project({ [value]: bunTest(`test('[value-correct] v', () => expect(value).toBe(1));`) });
    const { replayTests } = await import('../../src/verify/replay.js');
    symlinkSync(modules, join(root, 'node_modules'), 'dir');
    const replay = replayTests(root, 'HEAD', [{ id: 'value-correct', test: value }]);
    expect([replay.base.runner.framework, replay.head.runner.framework]).toEqual(['bun', 'bun']);
  }, 30000);
});

describe.skipIf(!hasBun)('plan-json on bun', () => {
  it('[BUN-017] plan-json start records Bun RED and complete records Bun GREEN', async () => {
    const { spawnSync } = await import('node:child_process');
    const { readFileSync } = await import('node:fs');
    const cli = fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url));
    const root = project({
      [value]: bunTest(`test('[TASK-1] value is two', () => expect(value).toBe(2));`),
      'openspec/changes/value/plan.json': JSON.stringify({
        schema_version: '1.0', change_id: 'value',
        traces_to: { target: 'intent.md', status: 'RESOLVED' },
        tasks: [{ id: 'TASK-1', status: 'pending', behavior: 'value is two', acceptance: 'equals two',
          files: ['source.js'], test: value, consumes: [], produces: [] }],
        escalation: { max_improvement_iterations: 6 },
      }),
    }, null);
    writeFileSync(join(root, 'openspec/config.yaml'), 'schema: spec-driven\ntdd:\n  framework: bun\n');
    const cmd = (action: string) => spawnSync(process.execPath, [cli, 'plan-json', action, 'value', 'TASK-1'], { cwd: root, encoding: 'utf8' });
    const task = () => JSON.parse(readFileSync(join(root, 'openspec/changes/value/plan.json'), 'utf8')).tasks[0];
    const started = cmd('start');
    expect(started.status, started.stdout + started.stderr).toBe(0);
    expect(task().red.outcome).toBe('red');
    expect(task().red.runner.framework).toBe('bun');
    writeFileSync(join(root, 'source.js'), 'export const value = 2;\n');
    const completed = cmd('complete');
    expect(completed.status, completed.stdout + completed.stderr).toBe(0);
    expect(task().status).toBe('complete');
    expect(task().green.outcome).toBe('green');
  }, 60000);
});

describe.skipIf(!hasBun)('verify on bun', () => {
  it('[BUN-018] orca verify writes an executable Bun receipt that checkChangeEvidence accepts', async () => {
    const { spawnSync } = await import('node:child_process');
    const { readFileSync } = await import('node:fs');
    const { checkChangeEvidence } = await import('../../src/verify/change.js');
    const cli = fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url));
    const root = project({
      [value]: bunTest(`test('[value-correct] computes a value', () => expect(value).toBe(1));`),
      'openspec/changes/value-change/spec.md': `# Value Specification
## Requirements
### Requirement: Value
The value MUST be correct.
#### Scenario: Correct
- **WHEN** the value is read
- **THEN** it is one
`,
      'openspec/changes/value-change/.traceability.yaml': `scenarios:\n  - scenario: value-correct\n    test: ${value}\n`,
    }, null);
    writeFileSync(join(root, 'openspec/config.yaml'), 'schema: spec-driven\ntdd:\n  framework: bun\n');
    const change = join(root, 'openspec/changes/value-change');
    const verified = spawnSync(process.execPath, [cli, 'verify', 'value-change'], { cwd: root, encoding: 'utf8' });
    expect(verified.status, verified.stdout + verified.stderr).toBe(0);
    const receipt = JSON.parse(readFileSync(join(change, '.orca-verify.json'), 'utf8'));
    expect(receipt.execution_verified).toBe(true);
    expect(receipt.execution.runner.framework).toBe('bun');
    const checked = checkChangeEvidence(root, change, 'value-change');
    expect(checked, JSON.stringify(checked.reasons)).toEqual({ valid: true, reasons: [] });
  }, 60000);
});

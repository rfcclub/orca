import { afterEach, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const cli = fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url));
const modules = fileURLToPath(new URL('../../node_modules', import.meta.url));
const roots: string[] = [];
function fixture(expected = 2) {
  const root = mkdtempSync(join(tmpdir(), 'orca-task-evidence-'));
  roots.push(root);
  const change = join(root, 'openspec/changes/value');
  mkdirSync(change, { recursive: true });
  mkdirSync(join(root, 'tests'));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, '.gitignore'), 'node_modules\n');
  writeFileSync(join(root, 'source.js'), 'export const value = 1;\n');
  writeFileSync(join(root, 'tests/value.test.js'), `import {it,expect} from 'vitest';
import {value} from '../source.js';
it('[TASK-1]', () => expect(value).toBe(${expected}));`);
  writeFileSync(join(change, 'plan.json'), JSON.stringify({
    schema_version: '1.0', change_id: 'value',
    traces_to: { target: 'intent.md', status: 'RESOLVED' },
    tasks: [{ id: 'TASK-1', status: 'pending', behavior: 'value is two', acceptance: 'equals two',
      files: ['source.js'], test: 'tests/value.test.js', consumes: [], produces: [] }],
    escalation: { max_improvement_iterations: 6 },
  }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'base'], { cwd: root });
  symlinkSync(modules, join(root, 'node_modules'), 'dir');
  const run = (action: string, args: string[] = []) => spawnSync(process.execPath,
    [cli, 'plan-json', action, 'value', 'TASK-1', ...args], { cwd: root, encoding: 'utf8' });
  const task = () => JSON.parse(readFileSync(join(change, 'plan.json'), 'utf8')).tasks[0];
  return { root, change, run, task };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('start requires real assertion RED and leaves already-green tasks pending', () => {
  const { run, task } = fixture(1);
  const result = run('start');
  expect(result.status, result.stdout + result.stderr).not.toBe(0);
  expect(task().status).toBe('pending');
}, 30000);

it('completes only the unchanged task test after real RED then GREEN', () => {
  const { root, run, task } = fixture();
  const started = run('start');
  expect(started.status, started.stdout + started.stderr).toBe(0);
  expect(task().red.outcome).toBe('red');
  writeFileSync(join(root, 'source.js'), 'export const value = 2;\n');
  const completed = run('complete');
  expect(completed.status, completed.stdout + completed.stderr).toBe(0);
  expect(task().status).toBe('complete');
  expect(task().green.outcome).toBe('green');
  expect(task().produces.every((p: { sha256: string }) => /^[a-f0-9]{64}$/.test(p.sha256))).toBe(true);
}, 30000);

it('rejects a RED label when its reporter actually says GREEN', () => {
  const { root, change, run, task } = fixture();
  expect(run('start').status).toBe(0);
  writeFileSync(join(root, 'source.js'), 'export const value = 2;\n');
  expect(run('complete').status).toBe(0);
  const planPath = join(change, 'plan.json');
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const green = plan.tasks[0].green;
  plan.tasks[0].status = 'in_progress';
  plan.tasks[0].red = { ...green, outcome: 'red', report_sha256: createHash('sha256').update(green.report).digest('hex') };
  writeFileSync(planPath, JSON.stringify(plan));
  const result = run('complete');
  expect(result.status, result.stdout + result.stderr).not.toBe(0);
  expect(task().status).toBe('in_progress');
}, 30000);

it('rejects shell success, absent RED and test replacement after RED', () => {
  const { root, run, task } = fixture();
  expect(run('complete', ['--test-cmd', 'true']).status).not.toBe(0);
  expect(run('complete').status).not.toBe(0);
  expect(run('start').status).toBe(0);
  writeFileSync(join(root, 'tests/value.test.js'), `import {it,expect} from 'vitest';
it('[TASK-1]', () => expect(1).toBe(1));`);
  expect(run('complete').status).not.toBe(0);
  expect(task().status).toBe('in_progress');
}, 30000);

it('does not treat an import error as task RED', () => {
  const { root, run, task } = fixture();
  writeFileSync(join(root, 'tests/value.test.js'), `import './missing.js';
import {it,expect} from 'vitest'; it('[TASK-1]', () => expect(1).toBe(2));`);
  expect(run('start').status).not.toBe(0);
  expect(task().status).toBe('pending');
}, 30000);

import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { executeTests } from '../../src/verify/execution.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const modulePath = '../../dist/loop/worker.js';
it('the integrated Pilotfish fixture resolves from the pinned development dependency', () => {
  expect(() => require.resolve('@gotako/pilotfish')).not.toThrow();
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-loop-worker-'));
  const dir = join(root, 'orca/changes/toy');
  mkdirSync(dir, { recursive: true }); mkdirSync(join(root, 'tests'));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, '.gitignore'), 'node_modules\n');
  writeFileSync(join(root, 'source.js'), 'export const value=1;');
  writeFileSync(join(root, 'tests/value.test.js'), "import{it,expect}from'vitest';import{value}from'../source.js';it('[T1]',()=>expect(value).toBe(2));");
  execFileSync('git', ['init', '-q', '-b', 'work/toy'], { cwd: root }); execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=f', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'base'], { cwd: root });
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
  const task = { id: 'T1', status: 'in_progress', behavior: 'value equals 2', acceptance: 'value equals 2',
    files: ['source.js'], test: 'tests/value.test.js', assertion: '[T1]', consumes: [], produces: [],
    red: executeTests(root, [{ id: 'T1', test: 'tests/value.test.js', assertion: '[T1]' }]) };
  writeFileSync(join(dir, 'plan.json'), JSON.stringify({ schema_version: '1.0', change_id: 'toy',
    traces_to: { target: 'INTENT', status: 'RESOLVED' }, tasks: [task], escalation: { max_improvement_iterations: 2 } }));
  const driver = join(root, 'driver.cjs');
  writeFileSync(driver, `const fs=require('fs'),input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if(process.argv[3]!=='1000')throw Error('token cap missing');
if(input.files['source.js']!=='export const value=1;')throw Error('task source missing');
console.log(JSON.stringify({files:{'source.js':'export const value=2;'}}));`);
  const config = { pilotfishModule: require.resolve('@gotako/pilotfish'), roles: { apply: 'fixture' },
    driver: { command: process.execPath, args: [driver, '{promptFile}', '{maxTokens}'], env: [] } };
  return { root, dir, task, config, clean: () => rmSync(root, { recursive: true, force: true }) };
}

it('real Pilotfish worker fixes a RED task through the bounded driver and direct GREEN runner', async () => {
  const f = fixture();
  try {
    const api = await import(modulePath).catch(() => null);
    expect(api?.runPilotfishAttempt).toBeTypeOf('function');
    expect(f.task.red.outcome).toBe('red');
    const result = await api!.runPilotfishAttempt({ root: f.root, changeDir: f.dir, taskId: 'T1',
      config: f.config, remainingMs: 10000, maxTokens: 1000 });
    expect(result.status).toBe('complete');
    expect(readFileSync(join(f.root, 'source.js'), 'utf8')).toBe('export const value=2;');
    expect(result.execution.outcome).toBe('green');
    expect(result.execution.tests).toEqual(f.task.red.tests);
  } finally { f.clean(); }
}, 30000);

it.each(['../outside.js', 'tests/value.test.js', 'orca/changes/toy/plan.json', 'other.js'])('worker refuses undeclared or protected %s model output', async path => {
  const f = fixture();
  try {
    const api = await import(modulePath).catch(() => null);
    expect(api?.guardModelFiles).toBeTypeOf('function');
    expect(() => api!.guardModelFiles(f.root, f.task, { files: { [path]: 'bad' } })).toThrow(/path|file|declared|protected/i);
    expect(readFileSync(join(f.root, 'source.js'), 'utf8')).toBe('export const value=1;');
  } finally { f.clean(); }
});

it('worker rejects symlinked declared source and unsupported driver token-cap contract', async () => {
  const f = fixture(), outside = mkdtempSync(join(tmpdir(), 'orca-loop-worker-outside-'));
  try {
    const api = await import(modulePath).catch(() => null);
    expect(api?.guardModelFiles).toBeTypeOf('function');
    writeFileSync(join(outside, 'source.js'), 'keep');
    rmSync(join(f.root, 'source.js')); symlinkSync(join(outside, 'source.js'), join(f.root, 'source.js'));
    expect(() => api!.guardModelFiles(f.root, f.task, { files: { 'source.js': 'bad' } })).toThrow(/symlink/i);
    expect(readFileSync(join(outside, 'source.js'), 'utf8')).toBe('keep');
    expect(() => api!.validateLoopConfig({ ...f.config, driver: { ...f.config.driver, args: ['no-cap'] } })).toThrow(/maxTokens|cap/i);
  } finally { f.clean(); rmSync(outside, { recursive: true, force: true }); }
});

it('branch drift during the driver call refuses writes on the default branch', async () => {
  const f = fixture();
  try {
    const api = await import(modulePath);
    const driver = join(f.root, 'driver.cjs');
    writeFileSync(driver, readFileSync(driver, 'utf8') + `\nrequire('child_process').execFileSync('git',['branch','-m','master'],{cwd:${JSON.stringify(f.root)}});`);
    await expect(api.runPilotfishAttempt({ root: f.root, changeDir: f.dir, taskId: 'T1',
      config: f.config, remainingMs: 10000, maxTokens: 1000 })).rejects.toThrow(/branch/i);
    expect(readFileSync(join(f.root, 'source.js'), 'utf8')).toBe('export const value=1;');
  } finally { f.clean(); }
}, 30000);

it('an orphaned worker refuses a model call when its recorded parent is gone', async () => {
  const f = fixture();
  try {
    const api = await import(modulePath);
    await expect(api.runPilotfishAttempt({ root: f.root, changeDir: f.dir, taskId: 'T1',
      config: f.config, remainingMs: 10000, maxTokens: 1000,
      parentOwner: { pid: 99999999, started: 'missing' } })).rejects.toThrow(/parent|owner/i);
    expect(readFileSync(join(f.root, 'source.js'), 'utf8')).toBe('export const value=1;');
  } finally { f.clean(); }
}, 30000);

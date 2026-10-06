import { it, expect } from 'vitest';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const cli = process.env.ORCA_TEST_CLI ?? fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url));
const gateModule = '../../dist/harness/gate-plan.js';
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-loop-cli-')), dir = join(root, 'orca/changes/toy');
  mkdirSync(join(dir, 'specs/toy'), { recursive: true }); mkdirSync(join(root, 'tests'));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, '.gitignore'), 'node_modules\n');
  for (const [name, id, n] of [['a', 'T1', 2], ['b', 'T2', 3]]) {
    writeFileSync(join(root, `${name}.js`), 'export const value=0;');
    writeFileSync(join(root, `tests/${name}.test.js`), `import{it,expect}from'vitest';import{value}from'../${name}.js';it('[${id}]',()=>expect(value).toBe(${n}));`);
  }
  execFileSync('git', ['init', '-q', '-b', 'work/toy'], { cwd: root }); execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=f', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'base'], { cwd: root });
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
  writeFileSync(join(dir, 'intent.md'), '# Intent\n\n## Success Criteria\n- SC-1 Complete both required values\n\n## Intent Approval\nStatus: APPROVED\n');
  const plan = { schema_version: '1.0', change_id: 'toy', traces_to: { target: 'INTENT', status: 'RESOLVED' },
    tasks: [['a', 'T1', 2], ['b', 'T2', 3]].map(([a, id, n]) => ({ id, status: 'pending',
      behavior: `SC-1 ${a} value equals ${n}`, acceptance: `${a} value equals ${n}`, files: [`${a}.js`],
      test: `tests/${a}.test.js`, assertion: `[${id}]`, consumes: [], produces: [] })),
    escalation: { max_improvement_iterations: 2 } };
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
  writeFileSync(join(dir, 'specs/toy/spec.md'), `## ADDED Requirements\n\n### Requirement: A\nA MUST return its required value.\n\n#### Scenario: Value\n- **WHEN** a runs\n- **THEN** a value equals 2\n\n### Requirement: B\nB MUST return its required value.\n\n#### Scenario: Value\n- **WHEN** b runs\n- **THEN** b value equals 3\n`);
  writeFileSync(join(dir, '.traceability.yaml'), 'scenarios:\n  - scenario: a-value\n    test: tests/a.test.js\n    assertion: "[T1]"\n  - scenario: b-value\n    test: tests/b.test.js\n    assertion: "[T2]"\n');
  writeFileSync(join(dir, 'self-check.md'), 'Human-authored review; preserve this file.\n');
  const driver = join(root, 'driver.cjs');
  writeFileSync(driver, `const fs=require('fs'),p=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const t=p.call.task,n=t.id==='T1'?2:3;
console.log(JSON.stringify({files:{[t.files[0]]:'export const value='+n+';'}}));`);
  const configPath = join(root, 'loop.config.json');
  writeFileSync(configPath, JSON.stringify({ pilotfishModule: require.resolve('@gotako/pilotfish'),
    roles: { apply: 'fixture' }, driver: { command: process.execPath, args: [driver, '{promptFile}', '{maxTokens}'], env: [] } }));
  const gate = await import(gateModule);
  expect((await gate.runGatePlan({ changeDir: dir })).verdict).toBe('PASS');
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', timeout: 60000 });
  return { root, dir, configPath, run, clean: () => rmSync(root, { recursive: true, force: true }) };
}

it('loop CLI completes two actual RED/Pilotfish/GREEN tasks and fresh verification without GitHub', async () => {
  const f = await fixture();
  try {
    const result = f.run(['loop', 'toy', '--config', f.configPath]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const state = JSON.parse(readFileSync(join(f.dir, '.harness/loop-state.json'), 'utf8'));
    expect(state.status).toBe('complete');
    const plan = JSON.parse(readFileSync(join(f.dir, 'plan.json'), 'utf8'));
    expect(plan.tasks.map((t: any) => [t.status, t.red.outcome, t.green.outcome])).toEqual([
      ['complete', 'red', 'green'], ['complete', 'red', 'green'],
    ]);
    expect(JSON.parse(readFileSync(join(f.dir, '.orca-verify.json'), 'utf8')).execution_verified).toBe(true);
    expect(readFileSync(join(f.dir, 'self-check.md'), 'utf8')).toBe('Human-authored review; preserve this file.\n');
    writeFileSync(join(f.root, 'a.js'), readFileSync(join(f.root, 'a.js'), 'utf8') + '\n// Unreviewed edit that keeps tests green\n');
    const stale = f.run(['loop', 'toy', '--config', f.configPath]);
    expect(stale.status, stale.stdout + stale.stderr).toBe(2);
    expect(stale.stdout).toMatch(/stale.*gate|stale PASS/i);
  } finally { f.clean(); }
}, 60000);

it('loop CLI stops after task quota and resumes the remaining task', async () => {
  const f = await fixture();
  try {
    const args = ['loop', 'toy', '--config', f.configPath, '--max-tasks', '1'];
    const first = f.run(args);
    expect(first.status, first.stdout + first.stderr).toBe(2);
    expect(first.stdout).toContain('Task budget exhausted');
    const before = JSON.parse(readFileSync(join(f.dir, 'plan.json'), 'utf8')).tasks[0].green.report_sha256;
    const second = f.run(args);
    expect(second.status, second.stdout + second.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(f.dir, 'plan.json'), 'utf8')).tasks[0].green.report_sha256).toBe(before);
  } finally { f.clean(); }
}, 60000);

it('local ready polling consumes a ready marker and runs the same bounded controller', async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.dir, '.harness/loop-ready.json'), '{"version":1,"ready":true}');
    const result = f.run(['loop-watch', '--once', '--config', f.configPath]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(f.dir, '.harness/loop-state.json'), 'utf8')).status).toBe('complete');
    expect(existsSync(join(f.dir, '.harness/loop-ready.json'))).toBe(false);
    expect(existsSync(join(f.dir, '.harness/loop-ready.consumed.json'))).toBe(true);
  } finally { f.clean(); }
}, 60000);

it('loop preserves enabled phase enforcement while task gates nest inside apply', async () => {
  const f = await fixture();
  try {
    const modulePath = '../../dist/harness/phase-json.js';
    const phases = await import(modulePath);
    const p = phases.createPhaseJson(f.dir, 'toy');
    for (const phase of p.lifecycle.slice(0, p.lifecycle.indexOf('apply'))) p.phases[phase].status = 'complete';
    phases.writePhaseJson(f.dir, p);
    execFileSync('git', ['add', '--', join(f.dir, 'phase.json')], { cwd: f.root });
    execFileSync('git', ['-c', 'user.name=f', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'track phase state'], { cwd: f.root });
    const result = f.run(['loop', 'toy', '--config', f.configPath]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const after = phases.readPhaseJson(f.dir);
    expect(after.phases.apply.status).toBe('complete');
    expect(after.phases['gate-code'].status).toBe('complete');
    expect(after.phases.verify.status).toBe('complete');
    expect(result.stdout + result.stderr).not.toContain('--skip-state-check');
    const guardModule = '../../dist/harness/transition-guard.js';
    const { TransitionGuard } = await import(guardModule);
    expect(() => new TransitionGuard(f.dir).canEnter('finish')).not.toThrow();
    writeFileSync(join(f.root, 'a.js'), 'export const value=999;');
    expect(() => new TransitionGuard(f.dir).canEnter('finish')).toThrow(/stale PASS/);
  } finally { f.clean(); }
}, 60000);

it('newly created source is staged before recording GREEN so its gate binding remains current', async () => {
  const f = await fixture();
  try {
    const path = join(f.dir, 'plan.json'), plan = JSON.parse(readFileSync(path, 'utf8'));
    plan.tasks[0].files = ['created.js'];
    writeFileSync(path, JSON.stringify(plan, null, 2) + '\n');
    writeFileSync(join(f.root, 'tests/a.test.js'), `import{it,expect}from'vitest';import{existsSync,readFileSync}from'node:fs';it('[T1]',()=>{expect(existsSync('created.js')).toBe(true);expect(readFileSync('created.js','utf8')).toBe('export const value=2;')});`);
    const gate = await import(gateModule); expect((await gate.runGatePlan({ changeDir: f.dir })).verdict).toBe('PASS');
    const result = f.run(['loop', 'toy', '--config', f.configPath]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { f.clean(); }
}, 60000);

it('changing driver configuration stops the loop before a second model call', async () => {
  const f = await fixture();
  try {
    const driver = join(f.root, 'driver.cjs');
    writeFileSync(driver, readFileSync(driver, 'utf8') + `\nconst config=${JSON.stringify(f.configPath)};fs.writeFileSync(config,fs.readFileSync(config,'utf8')+'\\n');`);
    const result = f.run(['loop', 'toy', '--config', f.configPath]);
    expect(result.status, result.stdout + result.stderr).toBe(2);
    expect(result.stdout).toMatch(/configuration.*changed/i);
    expect(JSON.parse(readFileSync(join(f.dir, 'plan.json'), 'utf8')).tasks[1].status).toBe('pending');
  } finally { f.clean(); }
}, 60000);

it('killing the controller after task one prevents orphan writes and resumes only task two', async () => {
  const f = await fixture();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const marker = join(f.root, 'second-attempt.started');
    const driver = join(f.root, 'driver.cjs');
    const original = readFileSync(driver, 'utf8');
    writeFileSync(driver, original.replace("console.log(JSON.stringify", `
if(t.id==='T2'){fs.writeFileSync(${JSON.stringify(marker)},'started');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2000);}
console.log(JSON.stringify`));
    child = spawn(process.execPath, [cli, 'loop', 'toy', '--config', f.configPath], {
      cwd: f.root, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.resume(); child.stderr!.resume();
    const deadline = Date.now() + 30000;
    while (!existsSync(marker) && Date.now() < deadline && child.exitCode === null) {
      await new Promise(done => setTimeout(done, 25));
    }
    expect(existsSync(marker)).toBe(true);
    const before = JSON.parse(readFileSync(join(f.dir, 'plan.json'), 'utf8')).tasks[0].green.report_sha256;
    const closed = new Promise<void>(done => child!.once('close', () => done()));
    child.kill('SIGKILL');
    await closed;
    await new Promise(done => setTimeout(done, 2500));
    expect(readFileSync(join(f.root, 'b.js'), 'utf8')).toBe('export const value=0;');
    const resumed = f.run(['loop', 'toy', '--config', f.configPath]);
    expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
    const plan = JSON.parse(readFileSync(join(f.dir, 'plan.json'), 'utf8'));
    expect(plan.tasks[0].green.report_sha256).toBe(before);
    expect(JSON.parse(readFileSync(join(f.dir, '.harness/loop-state.json'), 'utf8')).attempts).toEqual({ T1: 1, T2: 2 });
  } finally { child?.kill('SIGKILL'); f.clean(); }
}, 60000);

it('unsupported driver configuration returns a bounded handoff without starting a task', async () => {
  const f = await fixture();
  try {
    const config = JSON.parse(readFileSync(f.configPath, 'utf8'));
    config.driver.args = ['{promptFile}'];
    writeFileSync(f.configPath, JSON.stringify(config));
    const result = f.run(['loop', 'toy', '--config', f.configPath]);
    expect(result.status, result.stdout + result.stderr).toBe(2);
    const handoff = JSON.parse(result.stdout);
    expect(handoff.reason).toMatch(/maxTokens|cap/i);
    expect(handoff.next_command).toContain('--config');
    expect(JSON.parse(readFileSync(join(f.dir, 'plan.json'), 'utf8')).tasks.every((t: any) => t.status === 'pending')).toBe(true);
  } finally { f.clean(); }
}, 60000);

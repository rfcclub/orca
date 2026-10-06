import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const modulePath = '../../dist/loop/controller.js';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-loop-controller-'));
  const dir = join(root, 'orca/changes/toy');
  mkdirSync(join(dir, '.harness/gate-verdicts'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'work/toy'], { cwd: root });
  writeFileSync(join(root, 'source.js'), 'export const value=0;');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=f', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'base'], { cwd: root });
  writeFileSync(join(dir, 'intent.md'), '# Intent\n\n## Success Criteria\n- Complete two tasks\n\n## Intent Approval\nStatus: APPROVED\n');
  const plan = { schema_version: '1.0', change_id: 'toy', traces_to: { target: 'INTENT', status: 'RESOLVED' },
    tasks: ['T1', 'T2'].map(id => ({ id, status: 'pending', behavior: 'required value', acceptance: 'required value',
      files: ['source.js'], test: `tests/${id}.test.js`, consumes: [], produces: [] })),
    escalation: { max_improvement_iterations: 2 } };
  const save = () => writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
  save();
  writeFileSync(join(dir, '.harness/gate-verdicts/1-plan.json'), JSON.stringify({ kind: 'plan', verdict: 'PASS',
    artifact: 'plan.json', bound_artifact_sha256: hash(readFileSync(join(dir, 'plan.json'), 'utf8')) }));
  const calls: string[] = [];
  const deps = {
    start: async (id: string) => { calls.push('start:' + id); plan.tasks.find(t => t.id === id)!.status = 'in_progress'; save(); },
    attempt: async (id: string) => { calls.push('attempt:' + id); return { status: 'complete' }; },
    complete: async (id: string) => { calls.push('complete:' + id); plan.tasks.find(t => t.id === id)!.status = 'complete'; save(); },
    gate: async (id: string) => { calls.push('gate:' + id); return 'PASS'; },
    verify: async () => { calls.push('verify'); return true; },
  };
  const options = { root, changeDir: dir, name: 'toy', budgets: {
    maxTasks: 2, maxAttempts: 2, wallMs: 30000, tokenBudget: 4000, maxTokensPerAttempt: 1000,
  } };
  return { root, dir, plan, save, options, deps, calls, clean: () => rmSync(root, { recursive: true, force: true }) };
}

it('one bounded loop completes two tasks and verifies after each required gate', async () => {
  const f = fixture();
  try {
    const api = await import(modulePath).catch(() => null);
    expect(api?.runLoop).toBeTypeOf('function');
    const result = await api!.runLoop(f.options, f.deps);
    expect(result.status).toBe('complete');
    expect(f.calls).toEqual(['start:T1', 'attempt:T1', 'complete:T1', 'gate:T1',
      'start:T2', 'attempt:T2', 'complete:T2', 'gate:T2', 'verify']);
    expect(result.state.tokens_reserved).toBe(2000);
  } finally { f.clean(); }
});

it.each(['BLOCK', 'REVISE', 'ESCALATE_TO_HUMAN'])('adverse %s gate stops before task two and resume retries only the unfinished gate', async verdict => {
  const f = fixture();
  try {
    const api = await import(modulePath).catch(() => null);
    expect(api?.runLoop).toBeTypeOf('function');
    const stopped = await api!.runLoop(f.options, { ...f.deps, gate: async () => verdict });
    expect(stopped.status).toBe('stopped');
    expect(stopped.reason).toContain(verdict);
    expect(stopped.next_command).toBe('orca loop toy');
    expect(f.calls).not.toContain('start:T2');
    f.calls.length = 0;
    const resumed = await api!.runLoop(f.options, f.deps);
    expect(resumed.status).toBe('complete');
    expect(f.calls).toEqual(['gate:T1', 'start:T2', 'attempt:T2', 'complete:T2', 'gate:T2', 'verify']);
  } finally { f.clean(); }
});

it('resume handoff preserves the exact operator configuration and budget arguments', async () => {
  const f = fixture();
  try {
    const api = await import(modulePath);
    f.options.budgets.maxTasks = 1;
    const resumeCommand = "orca loop toy --config '/tmp/operator config.json' --max-tasks 1";
    const result = await api.runLoop({ ...f.options, resumeCommand }, f.deps);
    expect(result.next_command).toBe(resumeCommand);
  } finally { f.clean(); }
});

it('unapproved intent or stale plan refuses every model attempt', async () => {
  const f = fixture();
  try {
    const api = await import(modulePath).catch(() => null);
    expect(api?.runLoop).toBeTypeOf('function');
    const p = join(f.dir, 'intent.md');
    const intent = readFileSync(p, 'utf8');
    writeFileSync(p, intent.replace('APPROVED', 'DRAFT'));
    expect((await api!.runLoop(f.options, f.deps)).reason).toMatch(/approval|approved/i);
    expect(f.calls).toEqual([]);
    writeFileSync(p, intent);
    f.plan.tasks[0].behavior = 'changed requirement'; f.save();
    expect((await api!.runLoop(f.options, f.deps)).reason).toMatch(/plan|stale/i);
    expect(f.calls).toEqual([]);
  } finally { f.clean(); }
});

it('attempt and token reservations survive exhausted-run resume', async () => {
  const f = fixture();
  try {
    const api = await import(modulePath).catch(() => null);
    expect(api?.runLoop).toBeTypeOf('function');
    const failed = { ...f.deps, attempt: async (id: string) => { f.calls.push('attempt:' + id); return { status: 'escalate', reason: 'test still failing' }; } };
    const first = await api!.runLoop(f.options, failed);
    expect(first.status).toBe('stopped');
    expect(first.reason).toMatch(/attempt|escalat/i);
    expect(first.state.attempts.T1).toBe(2);
    const count = f.calls.length;
    expect((await api!.runLoop(f.options, failed)).status).toBe('stopped');
    expect(f.calls.length).toBe(count);
    expect(first.next_command).toContain('hammerhead-debug');
  } finally { f.clean(); }
});

it('task quota yields a resumable handoff and cannot skip a completed gate', async () => {
  const f = fixture();
  try {
    const api = await import(modulePath).catch(() => null);
    expect(api?.runLoop).toBeTypeOf('function');
    f.options.budgets.maxTasks = 1;
    const first = await api!.runLoop(f.options, f.deps);
    expect(first.reason).toMatch(/task.*budget/i);
    f.calls.length = 0;
    expect((await api!.runLoop(f.options, f.deps)).status).toBe('complete');
    expect(f.calls).toEqual(['start:T2', 'attempt:T2', 'complete:T2', 'gate:T2', 'verify']);
  } finally { f.clean(); }
});

it('default branch refuses execution and approval drift stops between tasks', async () => {
  const f = fixture();
  try {
    const api = await import(modulePath).catch(() => null);
    expect(api?.runLoop).toBeTypeOf('function');
    execFileSync('git', ['branch', '-m', 'master'], { cwd: f.root });
    expect((await api!.runLoop(f.options, f.deps)).reason).toMatch(/branch/i);
    expect(f.calls).toEqual([]);
    execFileSync('git', ['branch', '-m', 'work/toy'], { cwd: f.root });
    const stopped = await api!.runLoop(f.options, { ...f.deps, gate: async () => {
      writeFileSync(join(f.dir, 'intent.md'), readFileSync(join(f.dir, 'intent.md'), 'utf8') + '\nChanged scope\n');
      return 'PASS';
    } });
    expect(stopped.reason).toMatch(/intent|approval/i);
    expect(f.calls).not.toContain('start:T2');
  } finally { f.clean(); }
});

it('insufficient token reservation refuses model call and final verification cannot be declared complete', async () => {
  const f = fixture();
  try {
    const api = await import(modulePath).catch(() => null);
    expect(api?.runLoop).toBeTypeOf('function');
    f.options.budgets.tokenBudget = 500;
    const stopped = await api!.runLoop(f.options, f.deps);
    expect(stopped.reason).toMatch(/token.*budget/i);
    expect(f.calls).not.toContain('attempt:T1');
  } finally { f.clean(); }
  const g = fixture();
  try {
    const api = await import(modulePath);
    const stopped = await api.runLoop(g.options, { ...g.deps, verify: async () => false });
    expect(stopped.status).toBe('stopped');
    expect(stopped.reason).toMatch(/verif/i);
  } finally { g.clean(); }
});

it('one project lock rejects a concurrent invocation while a model attempt is running', async () => {
  const f = fixture();
  let release!: () => void;
  const wait = new Promise<void>(r => { release = r; });
  let entered!: () => void;
  const active = new Promise<void>(r => { entered = r; });
  try {
    const api = await import(modulePath);
    const first = api.runLoop(f.options, { ...f.deps, attempt: async () => {
      entered(); await wait; return { status: 'complete' };
    } });
    await active;
    const second = await api.runLoop(f.options, f.deps);
    release();
    expect(second.reason).toMatch(/lock|owner|already running/i);
    expect((await first).status).toBe('complete');
  } finally { release(); f.clean(); }
});

it('malformed saved budgets cannot create extra token or attempt capacity', async () => {
  const f = fixture();
  try {
    const api = await import(modulePath);
    f.options.budgets.maxTasks = 1;
    await api.runLoop(f.options, f.deps);
    const path = join(f.dir, '.harness/loop-state.json');
    const state = JSON.parse(readFileSync(path, 'utf8'));
    state.tokens_reserved = -100000;
    writeFileSync(path, JSON.stringify(state));
    f.calls.length = 0;
    expect((await api.runLoop(f.options, f.deps)).status).toBe('stopped');
    expect(f.calls).toEqual([]);
  } finally { f.clean(); }
});

it('symlinked harness cannot redirect loop state outside the project', async () => {
  const f = fixture(), outside = mkdtempSync(join(tmpdir(), 'orca-loop-outside-'));
  try {
    const api = await import(modulePath);
    rmSync(join(f.dir, '.harness'), { recursive: true });
    symlinkSync(outside, join(f.dir, '.harness'), 'dir');
    expect((await api.runLoop(f.options, f.deps)).reason).toMatch(/symlink|path/i);
    expect(f.calls).toEqual([]);
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(outside)).toEqual([]);
  } finally { f.clean(); rmSync(outside, { recursive: true, force: true }); }
});

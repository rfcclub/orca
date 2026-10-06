import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { hasApprovalRecord } from '../harness/gate-plan.js';
import { readPlanJson } from '../harness/plan-json.js';
import { hashBytes } from '../verify/execution.js';
import { safePath, acquireProjectLock } from './process.js';

const budgetsSchema = z.object({ maxTasks: z.number().int().positive(), maxAttempts: z.number().int().positive(),
  wallMs: z.number().int().positive(), tokenBudget: z.number().int().positive(), maxTokensPerAttempt: z.number().int().positive() });
export type LoopBudgets = z.infer<typeof budgetsSchema>;
export interface LoopOptions { root: string; changeDir: string; name: string; budgets: LoopBudgets; configHash?: string; resumeCommand?: string }
export interface LoopDeps {
  admission?: () => void;
  start: (id: string) => Promise<void>;
  attempt: (id: string, remainingMs: number, maxTokens: number) => Promise<{ status: string; reason?: string }>;
  complete: (id: string) => Promise<void>;
  gate: (id: string) => Promise<string>;
  verify: () => Promise<boolean>;
}
export interface LoopState {
  version: 1; intent_sha256: string; plan_contract_sha256: string; initial_plan_sha256: string;
  plan_verdict_sha256: string; config_sha256: string; branch: string;
  attempts: Record<string, number>; tokens_reserved: number;
  stages: Record<string, 'apply' | 'complete' | 'gate' | 'done'>;
  status: 'running' | 'complete' | 'stopped'; reason?: string; next_command?: string;
}
export interface LoopResult { status: 'complete' | 'stopped'; reason?: string; next_command?: string; state?: LoopState }
const stateSchema = z.object({
  version: z.literal(1), intent_sha256: z.string(), plan_contract_sha256: z.string(), initial_plan_sha256: z.string(),
  plan_verdict_sha256: z.string(), config_sha256: z.string(), branch: z.string(),
  attempts: z.record(z.string(), z.number().int().nonnegative()), tokens_reserved: z.number().int().nonnegative(),
  stages: z.record(z.string(), z.enum(['apply', 'complete', 'gate', 'done'])),
  status: z.enum(['running', 'complete', 'stopped']), reason: z.string().optional(), next_command: z.string().optional(),
});

function planContract(dir: string): string {
  const p = readPlanJson(dir);
  return hashBytes(JSON.stringify({ change_id: p.change_id, traces_to: p.traces_to, escalation: p.escalation,
    tasks: p.tasks.map(t => ({ id: t.id, behavior: t.behavior, acceptance: t.acceptance, test: t.test,
      assertion: t.assertion, files: t.files, consumes: t.consumes })) }));
}
function planVerdict(dir: string): { hash: string; bound: string } {
  const folder = join(dir, '.harness/gate-verdicts');
  const files = readdirSync(folder).filter(f => f.endsWith('-plan.json')).sort();
  if (!files.length) throw new Error('Passing plan verdict required');
  const text = readFileSync(join(folder, files.at(-1)!), 'utf8');
  const verdict = JSON.parse(text);
  if (!['PASS', 'PASS_WITH_WARNINGS'].includes(verdict.verdict) || verdict.artifact !== 'plan.json') {
    throw new Error('Passing plan.json verdict required');
  }
  return { hash: hashBytes(text), bound: verdict.bound_artifact_sha256 };
}
function branch(root: string): string {
  const name = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  let remoteDefault = '';
  try { remoteDefault = execFileSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().replace(/^origin\//, ''); } catch { /* no remote */ }
  if (!name || ['main', 'master', 'trunk', remoteDefault].includes(name)) throw new Error('Loop requires a work branch');
  return name;
}
function atomic(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, path);
}

/** Drive one approved plan; adapters supply actual execution, never model-written completion flags. */
export async function runLoop(opts: LoopOptions, deps: LoopDeps): Promise<LoopResult> {
  const startTime = Date.now();
  let state: LoopState | undefined;
  let release: (() => void) | undefined;
  let writable = false;
  const dir = resolve(opts.changeDir), root = resolve(opts.root);
  const harness = join(dir, '.harness'), stateFile = join(harness, 'loop-state.json');
  const command = opts.resumeCommand ?? `orca loop ${opts.name}`;
  const event = (kind: string, detail: unknown) => appendFileSync(safePath(root, join(harness, 'loop-events.jsonl')),
    JSON.stringify({ timestamp: new Date().toISOString(), kind, detail }) + '\n');
  const save = () => { if (state) atomic(safePath(root, stateFile), state); };
  const stop = (reason: string, next = command): LoopResult => {
    if (state) { state.status = 'stopped'; state.reason = reason; state.next_command = next; save(); }
    atomic(safePath(root, join(harness, 'loop-handoff.json')), { status: 'stopped', reason, next_command: next });
    event('stopped', { reason, next_command: next });
    return { status: 'stopped', reason, next_command: next, state };
  };
  try {
    if (!dir.startsWith(root + sep) || !/^[a-z0-9][a-z0-9-]*$/.test(opts.name)) throw new Error('Invalid project/change path');
    safePath(root, harness);
    safePath(root, join(dir, 'intent.md')); safePath(root, join(dir, 'plan.json'));
    safePath(root, stateFile);
    release = acquireProjectLock(root);
    mkdirSync(harness, { recursive: true });
    writable = true;
    const budget = budgetsSchema.parse(opts.budgets);
    const currentBranch = branch(root);
    const intent = readFileSync(join(dir, 'intent.md'), 'utf8');
    if (!hasApprovalRecord(intent)) throw new Error('Approved intent approval required');
    const verdict = planVerdict(dir);
    const configHash = hashBytes(JSON.stringify([budget, opts.configHash ?? '']));
    const contractHash = planContract(dir);
    if (existsSync(stateFile)) state = stateSchema.parse(JSON.parse(readFileSync(stateFile, 'utf8')));
    else {
      const initialHash = hashBytes(readFileSync(join(dir, 'plan.json')));
      if (verdict.bound !== initialHash) throw new Error('Stale plan verdict');
      state = { version: 1, intent_sha256: hashBytes(intent), plan_contract_sha256: contractHash,
        initial_plan_sha256: initialHash, plan_verdict_sha256: verdict.hash, config_sha256: configHash,
        branch: currentBranch, attempts: {}, tokens_reserved: 0, stages: {}, status: 'running' };
      save();
    }
    if (!state) throw new Error('Invalid loop state');
    if (state.tokens_reserved !== Object.values(state.attempts).reduce((sum, n) => sum + n, 0) * budget.maxTokensPerAttempt) {
      throw new Error('Saved token reservations disagree with spent attempts');
    }
    const check = () => {
      deps.admission?.();
      if (!state || state.version !== 1 || state.config_sha256 !== configHash || state.branch !== branch(root)) throw new Error('Loop configuration or branch changed');
      const currentIntent = readFileSync(join(dir, 'intent.md'), 'utf8');
      if (!hasApprovalRecord(currentIntent) || hashBytes(currentIntent) !== state.intent_sha256) throw new Error('Intent approval changed during loop');
      if (planContract(dir) !== state.plan_contract_sha256 || planVerdict(dir).hash !== state.plan_verdict_sha256) throw new Error('Approved plan changed during loop');
      if (Date.now() - startTime >= budget.wallMs) throw new Error('Wall-clock budget exhausted');
    };
    let count = 0;
    state.status = 'running'; save();
    for (;;) {
      check();
      const plan = readPlanJson(dir);
      if (!plan.tasks.length || new Set(plan.tasks.map(t => t.id)).size !== plan.tasks.length) throw new Error('Plan needs unique nonempty tasks');
      const task = plan.tasks.find(t => state!.stages[t.id] !== 'done');
      if (!task) {
        if (plan.tasks.some(t => t.status !== 'complete')) throw new Error('Completed loop state disagrees with plan');
        if (!await deps.verify()) return stop('Final executable verification failed', `orca verify ${opts.name}`);
        check(); state.status = 'complete'; delete state.reason; delete state.next_command; save(); event('complete', {});
        return { status: 'complete', state };
      }
      if (count >= budget.maxTasks) return stop('Task budget exhausted');
      if (task.status === 'complete' && !state.stages[task.id]) state.stages[task.id] = 'gate';
      if (!state.stages[task.id]) {
        await deps.start(task.id); check();
        state.stages[task.id] = 'apply'; save(); event('red', { task: task.id });
      }
      if (state.stages[task.id] === 'apply') {
        const limit = Math.min(budget.maxAttempts, plan.escalation.max_improvement_iterations);
        while (state.stages[task.id] === 'apply') {
          check();
          if ((state.attempts[task.id] ?? 0) >= limit) return stop('Attempt budget exhausted',
            `hammerhead-debug open --symptom "${task.id}: test still failing" --repro "orca verify ${opts.name}" --dir "${dir}"`);
          if (state.tokens_reserved + budget.maxTokensPerAttempt > budget.tokenBudget) return stop('Token reservation budget exhausted');
          state.attempts[task.id] = (state.attempts[task.id] ?? 0) + 1;
          state.tokens_reserved += budget.maxTokensPerAttempt; save(); event('attempt', { task: task.id, attempt: state.attempts[task.id] });
          const result = await deps.attempt(task.id, budget.wallMs - (Date.now() - startTime), budget.maxTokensPerAttempt);
          check();
          if (result.status === 'complete') { state.stages[task.id] = 'complete'; save(); }
          else if (result.status !== 'escalate') return stop(result.reason ?? 'Pilotfish attempt invalid');
        }
      }
      if (state.stages[task.id] === 'complete') {
        if (readPlanJson(dir).tasks.find(t => t.id === task.id)?.status !== 'complete') await deps.complete(task.id);
        check(); state.stages[task.id] = 'gate'; save(); event('green', { task: task.id });
      }
      if (state.stages[task.id] === 'gate') {
        const result = await deps.gate(task.id);
        check(); event('gate', { task: task.id, verdict: result });
        if (!['PASS', 'PASS_WITH_WARNINGS'].includes(result)) return stop(`Code gate ${result}`);
        state.stages[task.id] = 'done'; save();
      }
      count++;
    }
  } catch (error) {
    if (!writable) return { status: 'stopped', reason: (error as Error).message, next_command: command };
    return stop((error as Error).message);
  } finally {
    if (release) release();
  }
}

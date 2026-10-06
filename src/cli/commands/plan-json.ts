import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { readDebugLoopJson } from '@gotako/hammerhead-debug';
import { getChangeDir, changeExists, getProjectRoot } from '../utils.js';
import { createPlanJson, readPlanJson, writePlanJson, findProducerTask } from '../../harness/plan-json.js';
import { PlanGuard } from '../../harness/plan-guard.js';
import { TransitionGuard } from '../../harness/transition-guard.js';
import { sha256File, recordPhaseComplete, readPhaseJson } from '../../harness/phase-json.js';
import type { PlanTask, TaskArtifact, ArtifactRef } from '../../harness/types.js';
import { executeTests, hashBytes, selectedFile, validateExecutionReceipt } from '../../verify/execution.js';

function flag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx === -1 ? undefined : args[idx + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

function requireChangeDir(name: string): string {
  if (!changeExists(name)) {
    console.error(`✗  Change "${name}" not found. Run "orca intent ${name}" first.`);
    process.exit(1);
  }
  return getChangeDir(name);
}

function requireTask(taskId: string, tasks: PlanTask[]): PlanTask {
  const task = tasks.find(t => t.id === taskId);
  if (!task) {
    console.error(`✗  Task "${taskId}" not found in plan.json`);
    process.exit(1);
  }
  return task!;
}

export async function cmdPlanJson(action: string, name: string | undefined, args: string[]): Promise<void> {
  if (!name) {
    console.error('Usage: orca plan-json <init|add|start|red|complete|finish|show> <name> [options]');
    process.exit(1);
  }

  switch (action) {
    case 'init':
      cmdInit(name, args);
      break;
    case 'add':
      cmdAdd(name, args);
      break;
    case 'start':
    case 'red':
      cmdStart(name, args[0], args.slice(1));
      break;
    case 'complete':
      cmdComplete(name, args[0], args.slice(1));
      break;
    case 'finish':
      cmdFinish(name, args);
      break;
    case 'show':
      cmdShow(name);
      break;
    default:
      console.error(`Unknown plan-json action: ${action}`);
      console.error('Usage: orca plan-json <init|add|start|red|complete|finish|show> <name> [options]');
      process.exit(1);
  }
}

function cmdInit(name: string, args: string[]): void {
  const changeDir = requireChangeDir(name);
  const planPath = join(changeDir, 'plan.json');
  if (existsSync(planPath)) {
    console.error(`✗  plan.json already exists at ${planPath}`);
    process.exit(1);
  }

  const trace = flag(args, 'trace');
  const resolvedBy = flag(args, 'resolved-by');
  if (!trace || !resolvedBy) {
    console.error('Usage: orca plan-json init <name> --trace <INTENT-ID> --resolved-by <name>');
    process.exit(1);
  }

  const plan = createPlanJson(changeDir, name, trace);
  plan.traces_to = { target: trace, status: 'RESOLVED', resolved_by: resolvedBy, resolved_at: new Date().toISOString() };
  writePlanJson(changeDir, plan);

  console.log(`✓  Created plan.json for "${name}" — traces to ${trace} (resolved by ${resolvedBy})`);
  console.log(`  Next: orca plan-json add ${name} --id TASK-1 --behavior "..." --acceptance "..." --files a.ts --test tests/a.test.ts`);
}

function cmdAdd(name: string, args: string[]): void {
  const changeDir = requireChangeDir(name);
  const plan = readPlanJson(changeDir);

  const id = flag(args, 'id');
  const behavior = flag(args, 'behavior');
  const acceptance = flag(args, 'acceptance');
  const filesArg = flag(args, 'files');
  const test = flag(args, 'test');
  const assertion = flag(args, 'assertion');
  const consumesArg = flag(args, 'consumes');

  if (!id || !behavior || !acceptance || !filesArg || !test) {
    console.error('Usage: orca plan-json add <name> --id <id> --behavior "..." --acceptance "..." --files a.ts,b.ts --test tests/a.test.ts [--consumes path1,path2]');
    process.exit(1);
  }

  if (plan.tasks.some(t => t.id === id)) {
    console.error(`✗  Task "${id}" already exists in plan.json`);
    process.exit(1);
  }

  const files = filesArg.split(',').map(s => s.trim()).filter(Boolean);
  if (files.length > 2) {
    console.error(`✗  ${id}: task touches >2 files — split it before adding`);
    process.exit(1);
  }

  const consumes: TaskArtifact[] = [];
  if (consumesArg) {
    for (const path of consumesArg.split(',').map(s => s.trim()).filter(Boolean)) {
      const producer = findProducerTask(plan, path);
      if (!producer || producer.status !== 'complete') {
        console.error(`✗  No completed task produces "${path}" yet — add and complete that task first`);
        process.exit(1);
      }
      const art = producer.produces.find(a => a.path === path)!;
      consumes.push({ path, sha256: art.sha256 });
    }
  }

  const task: PlanTask = { id, status: 'pending', behavior, acceptance, files, test, consumes, produces: [] };
  if (assertion) task.assertion = assertion;
  plan.tasks.push(task);
  writePlanJson(changeDir, plan);
  console.log(`✓  Added task "${id}" to plan.json`);
}

function cmdStart(name: string, taskId: string | undefined, args: string[]): void {
  const changeDir = requireChangeDir(name);
  if (!taskId) {
    console.error('Usage: orca plan-json start <name> <task-id> [--skip-state-check]');
    process.exit(1);
  }
  const plan = readPlanJson(changeDir);
  const task = requireTask(taskId, plan.tasks);

  // plan.json's tasks live INSIDE phase.json's `apply` cell — `branch` (the
  // phase immediately before `apply` in LIFECYCLE) must be complete first.
  // Degrades gracefully (warns, does not block) when phase.json isn't in use.
  try {
    new TransitionGuard(changeDir).canEnter('apply', hasFlag(args, 'skip-state-check'));
  } catch (e) {
    console.error(`✗  ${(e as Error).message}`);
    process.exit(1);
  }

  const guard = new PlanGuard(changeDir);
  try {
    guard.canStartTask(task, plan);
  } catch (e) {
    console.error(`✗  ${(e as Error).message}`);
    process.exit(1);
  }

  if (task.status !== 'pending') {
    console.error(`✗  ${task.id}: start requires a pending task`);
    process.exit(1);
  }
  const red = executeTests(getProjectRoot(), [{ id: task.id, test: task.test, assertion: task.assertion }]);
  if (red.outcome !== 'red') {
    console.error(`✗  ${task.id}: genuine assertion RED required (${red.outcome}). ${red.reasons.join('; ')}`);
    process.exit(1);
  }
  task.red = red;
  task.status = 'in_progress';
  writePlanJson(changeDir, plan);
  console.log(`✓  Task "${taskId}" started`);
  console.log(`  behavior:   ${task.behavior}`);
  console.log(`  acceptance: ${task.acceptance}`);
  console.log(`  files:      ${task.files.join(', ')}`);
  console.log(`  test:       ${task.test}`);
}

function cmdComplete(name: string, taskId: string | undefined, args: string[]): void {
  const changeDir = requireChangeDir(name);
  if (!taskId) {
    console.error('Usage: orca plan-json complete <name> <task-id> [--debug-session <id> --debug-cycle <id> --root-cause "..."] [--escalated]');
    process.exit(1);
  }
  const plan = readPlanJson(changeDir);
  const task = requireTask(taskId, plan.tasks);

  if (hasFlag(args, 'test-cmd')) {
    console.error('✗  --test-cmd is unsupported: Orca executes task.test directly');
    process.exit(1);
  }
  const root = getProjectRoot();
  if (task.status !== 'in_progress' || task.red?.outcome !== 'red' ||
      !validateExecutionReceipt(root, task.red) ||
      task.red.report_sha256 !== hashBytes(task.red.report) ||
      task.red.tests[task.test] !== hashBytes(readFileSync(selectedFile(root, task.test))) ||
      JSON.stringify(task.red.selection) !== JSON.stringify([{ id: task.id, test: task.test, ...(task.assertion ? { assertion: task.assertion } : {}) }])) {
    console.error(`✗  ${task.id}: genuine RED with the unchanged task test is required`);
    process.exit(1);
  }
  const green = executeTests(root, [{ id: task.id, test: task.test, assertion: task.assertion }]);
  const gatePassed = green.outcome === 'green' && green.runner.sha256 === task.red.runner.sha256 &&
    green.runner.version === task.red.runner.version;

  const debugSession = flag(args, 'debug-session');
  if (debugSession) {
    const debugCycle = flag(args, 'debug-cycle');
    const rootCause = flag(args, 'root-cause');
    if (!debugCycle || !rootCause) {
      console.error('✗  --debug-session requires --debug-cycle and --root-cause');
      process.exit(1);
    }
    let refutedCycles = 0;
    try {
      const session = readDebugLoopJson(changeDir, debugSession);
      refutedCycles = session.cycles.filter(c => c.status === 'refuted').length;
    } catch {
      // guard below will reject an unresolvable session with a clear message
    }
    task.debug_ref = {
      session: debugSession,
      resolved_by_cycle: debugCycle,
      root_cause: rootCause,
      cost: { refuted_cycles: refutedCycles, escalated: hasFlag(args, 'escalated') },
    };
  }

  const guard = new PlanGuard(changeDir);
  try {
    guard.canCompleteTask(task, gatePassed);
  } catch (e) {
    console.error(`✗  ${(e as Error).message}`);
    process.exit(1);
  }

  task.status = 'complete';
  task.green = green;
  const producedPaths = [...new Set([...task.files, task.test])];
  task.produces = producedPaths.map(path => {
    const filePath = selectedFile(root, path);
    return { path, sha256: sha256File(filePath) };
  });
  writePlanJson(changeDir, plan);
  console.log(`✓  Task "${taskId}" complete — gate green, ${task.produces.length} artifact(s) hashed`);
}

function cmdFinish(name: string, _args: string[]): void {
  const changeDir = requireChangeDir(name);
  const plan = readPlanJson(changeDir);

  if (plan.tasks.length === 0) {
    console.error('✗  plan.json has no tasks — nothing to finish');
    process.exit(1);
  }
  const incomplete = plan.tasks.filter(t => t.status !== 'complete');
  if (incomplete.length > 0) {
    console.error(`✗  ${incomplete.length} task(s) not complete yet: ${incomplete.map(t => t.id).join(', ')}`);
    process.exit(1);
  }

  let pj;
  try {
    pj = readPhaseJson(changeDir);
  } catch {
    console.log(`✓  All ${plan.tasks.length} task(s) complete (phase.json not in use — nothing to record)`);
    return;
  }
  void pj;

  const seen = new Set<string>();
  const produced: ArtifactRef[] = [];
  for (const task of plan.tasks) {
    for (const art of task.produces) {
      if (!art.sha256 || seen.has(art.path)) continue;
      seen.add(art.path);
      produced.push({ path: art.path, sha256: art.sha256 });
    }
  }

  recordPhaseComplete(changeDir, 'apply', [], produced, { type: 'tool', marker: 'plan.json:all_tasks_complete' });
  console.log(`✓  All ${plan.tasks.length} task(s) complete — phase.json "apply" phase closed`);
  console.log(`  Next: orca gate-code ${name}`);
}

function cmdShow(name: string): void {
  const changeDir = requireChangeDir(name);
  const plan = readPlanJson(changeDir);

  console.log(`plan.json — ${plan.change_id}`);
  console.log(`traces_to: ${plan.traces_to.target} [${plan.traces_to.status}]`);
  console.log('');
  for (const task of plan.tasks) {
    console.log(`${task.id}  [${task.status}]`);
    console.log(`  behavior:   ${task.behavior}`);
    console.log(`  acceptance: ${task.acceptance}`);
    console.log(`  files:      ${task.files.join(', ')}`);
    if (task.debug_ref) {
      console.log(`  debug_ref:  ${task.debug_ref.session} (cycle ${task.debug_ref.resolved_by_cycle}) — ${task.debug_ref.root_cause}`);
    }
    console.log('');
  }
}

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getProjectRoot, getChangeDir, listChanges } from '../utils.js';
import { runLoop, type LoopBudgets } from '../../loop/controller.js';
import { runBounded, safePath, processIdentity } from '../../loop/process.js';
import { validateLoopConfig, requireTaskRed } from '../../loop/worker.js';
import { readPlanJson } from '../../harness/plan-json.js';
import { hashBytes } from '../../verify/execution.js';
import { recordPhaseComplete } from '../../harness/phase-json.js';
import { requireFreshLoopGate } from '../../loop/gate-worker.js';

function flag(args: string[], key: string): string | undefined {
  const i = args.indexOf(key);
  if (i === -1) return undefined;
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${key} requires a value`);
  return args[i + 1];
}
function integer(args: string[], key: string, fallback: number): number {
  const value = flag(args, key);
  return z.number().int().positive().parse(value ? Number(value) : fallback);
}
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
export async function cmdLoop(name: string, args: string[]): Promise<void> {
  const root = getProjectRoot(), dir = getChangeDir(name);
  let configPath = resolve(root, 'loop.config.json');
  let configBytes: Buffer, config: ReturnType<typeof validateLoopConfig>, budgets: LoopBudgets;
  try {
    configPath = resolve(root, flag(args, '--config') ?? 'loop.config.json');
    configBytes = readFileSync(configPath);
    config = validateLoopConfig(JSON.parse(configBytes.toString('utf8')));
    budgets = { maxTasks: integer(args, '--max-tasks', 4), maxAttempts: integer(args, '--max-attempts', 3),
      wallMs: integer(args, '--wall-ms', 120000), tokenBudget: integer(args, '--token-budget', 12000),
      maxTokensPerAttempt: integer(args, '--max-tokens', 2000) };
  } catch (error) {
    console.log(JSON.stringify({ status: 'stopped', reason: `Fix loop configuration: ${(error as Error).message}`,
      next_command: ['orca', 'loop', quote(name), '--config', quote(configPath)].join(' ') }, null, 2));
    process.exitCode = 2;
    return;
  }
  const began = Date.now();
  const remaining = () => budgets.wallMs - (Date.now() - began);
  const env = Object.fromEntries(config.driver.env.filter(n => process.env[n] !== undefined).map(n => [n, process.env[n]!]));
  const selfCli = fileURLToPath(new URL('../index.js', import.meta.url));
  const worker = fileURLToPath(new URL('../../loop/worker.js', import.meta.url));
  const gateWorker = fileURLToPath(new URL('../../loop/gate-worker.js', import.meta.url));
  const receipts = join(dir, '.harness/loop-commands');
  const invoke = async (command: string, commandArgs: string[], label: string) => {
    mkdirSync(safePath(root, receipts), { recursive: true });
    const receipt = await runBounded({ command, args: commandArgs, cwd: root, timeoutMs: remaining(), env });
    writeFileSync(safePath(root, join(receipts, `${Date.now()}-${label}-${randomUUID()}.json`)),
      JSON.stringify({ command, args: commandArgs, ...receipt }, null, 2));
    if (receipt.exit_code !== 0) throw new Error(receipt.timed_out ? 'Wall-clock budget exhausted' :
      receipt.output_exceeded ? 'Command output exceeded cap' : `${label} failed: ${receipt.stderr || receipt.stdout}`);
    return receipt;
  };
  const orca = (a: string[], label: string) => invoke(process.execPath, [selfCli, ...a], label);
  const runWorker = async (path: string, input: unknown, label: string) => {
    const inputPath = safePath(root, join(dir, `.harness/loop-${label}-input.json`));
    writeFileSync(inputPath, JSON.stringify(input, null, 2), { mode: 0o600 });
    const r = await invoke(process.execPath, [path, inputPath], label);
    return JSON.parse(r.stdout);
  };
  const resumeCommand = ['orca', 'loop', quote(name), '--config', quote(configPath),
    '--max-tasks', String(budgets.maxTasks), '--max-attempts', String(budgets.maxAttempts),
    '--wall-ms', String(budgets.wallMs), '--token-budget', String(budgets.tokenBudget),
    '--max-tokens', String(budgets.maxTokensPerAttempt)].join(' ');
  const result = await runLoop({ root, changeDir: dir, name, budgets, configHash: hashBytes(configBytes), resumeCommand }, {
    admission: () => {
      if (hashBytes(readFileSync(configPath)) !== hashBytes(configBytes)) throw new Error('Driver configuration changed during loop');
    },
    start: async id => {
      const task = readPlanJson(dir).tasks.find(t => t.id === id)!;
      if (task.status === 'in_progress') requireTaskRed(root, task);
      else await orca(['plan-json', 'start', name, id], 'red');
    },
    attempt: async (id, remainingMs, maxTokens) => runWorker(worker,
      { root, changeDir: dir, taskId: id, config, remainingMs, maxTokens,
        parentOwner: { pid: process.pid, started: processIdentity(process.pid) } }, 'attempt'),
    complete: async id => {
      const task = readPlanJson(dir).tasks.find(t => t.id === id)!;
      await invoke('git', ['add', '--', ...task.files, task.test], 'stage');
      await orca(['plan-json', 'complete', name, id], 'green');
    },
    gate: async id => {
      const plan = readPlanJson(dir), task = plan.tasks.find(t => t.id === id)!;
      const green = task.green!;
      const allComplete = plan.tasks.every(t => t.status === 'complete');
      // Include newly created production/test files in the exact diff seen by Seal.
      await invoke('git', ['add', '--', ...task.files, task.test], 'stage');
      if (allComplete) await orca(['plan-json', 'finish', name], 'finish-apply');
      const selfCheckPath = safePath(root, join(dir, '.harness/loop-self-check.md'));
      const titles = JSON.parse(green.report).testResults.flatMap((t: any) => t.assertionResults)
        .map((a: any) => `${a.status}: ${a.fullName}`);
      const evidence = [{ type: 'command', command: [green.command.executable, ...green.command.args].join(' '),
        exit_code: green.command.exit_code, output: `Actual ${green.outcome}. Reporter sha256 ${green.report_sha256}. ${titles.join('; ')}` }];
      writeFileSync(selfCheckPath, `# Self-Check\n\n## Claims\n- ${task.id}: ${task.acceptance}\n\n## Evidence\n\`\`\`json\n${JSON.stringify(evidence, null, 2)}\n\`\`\`\n\n## Known Limitations\n- LLM semantic review is not enabled by the controller.\n\n## Unresolved Assumptions\n- The operator configured a driver-enforced token cap.\n`);
      const gate = await runWorker(gateWorker, { root, changeDir: dir, selfCheckPath, ...(allComplete ? {} : { taskId: id }) }, 'gate');
      return gate.verdict;
    },
    verify: async () => {
      requireFreshLoopGate(root, dir);
      await orca(['verify', name], 'verify');
      const verifyPath = safePath(root, join(dir, '.orca-verify.json'));
      try { recordPhaseComplete(dir, 'verify', [], [{ path: '.orca-verify.json', sha256: hashBytes(readFileSync(verifyPath)) }],
        { type: 'tool', marker: 'loop:executable-verify-passed' }); }
      catch (e) { if (!(e as Error).message.includes('phase.json not found')) throw e; }
      requireFreshLoopGate(root, dir);
      return true;
    },
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'complete') process.exitCode = 2;
}

export async function cmdLoopWatch(args: string[]): Promise<void> {
  const root = getProjectRoot();
  const polls = args.includes('--once') ? 1 : integer(args, '--max-polls', 12);
  const interval = integer(args, '--interval-ms', 5000);
  const maxChanges = integer(args, '--max-changes', 1);
  let count = 0;
  for (let poll = 0; poll < polls && count < maxChanges; poll++) {
    for (const name of listChanges()) {
      const ready = safePath(root, join(getChangeDir(name), '.harness/loop-ready.json'));
      if (!existsSync(ready)) continue;
      const value = z.object({ version: z.literal(1), ready: z.literal(true) }).strict().parse(JSON.parse(readFileSync(ready, 'utf8')));
      void value;
      renameSync(ready, safePath(root, ready.replace(/\.json$/, '.consumed.json')));
      await cmdLoop(name, args);
      count++;
      if (count >= maxChanges) break;
    }
    if (poll + 1 < polls && count < maxChanges) await new Promise(done => setTimeout(done, interval));
  }
  console.log(JSON.stringify({ polled: true, admitted: count }));
}

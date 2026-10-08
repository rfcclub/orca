import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { execFileSync } from 'node:child_process';
import type { PlanTask } from '../harness/types.js';
import { readPlanJson } from '../harness/plan-json.js';
import { executeTests, validateExecutionReceipt, selectedFile, hashBytes, type ExecutionReceipt } from '../verify/execution.js';
import { runBounded, safePath, processIdentity } from './process.js';

const configSchema = z.object({
  pilotfishModule: z.string().min(1), roles: z.record(z.string(), z.string().min(1)),
  driver: z.object({ command: z.string().min(1), args: z.array(z.string()),
    env: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).default([]) }).strict(),
}).strict();
export type LoopConfig = z.infer<typeof configSchema>;
export function validateLoopConfig(input: unknown): LoopConfig {
  const config = configSchema.parse(input);
  if (!isAbsolute(config.pilotfishModule) || !existsSync(config.pilotfishModule)) throw new Error('Installed Pilotfish module path required');
  if (!config.roles.apply) throw new Error('Pilotfish apply role required');
  if (!config.driver.args.some(s => s.includes('{promptFile}')) ||
      !config.driver.args.some(s => s.includes('{maxTokens}'))) throw new Error('Driver needs promptFile and maxTokens cap argv');
  return config;
}
const protectedPath = /(^|\/)(tests?|__tests__|node_modules|dist|openspec|orca|loomkit|graphify-out|\.git)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(package(?:-lock)?\.json|.*lock.*|(?:vitest|vite|tsconfig).*|\.gitignore|.*loop.*config.*|\.env.*|.*\.(pem|key))$/i;
export function guardModelFiles(root: string, task: PlanTask, result: unknown): Record<string, string> {
  const files = z.object({ files: z.record(z.string(), z.string()) }).strict().parse(result).files;
  if (task.files.length > 2 || !task.files.length) throw new Error('Task must declare one or two production files');
  for (const path of task.files) {
    if (isAbsolute(path) || path === task.test || protectedPath.test(path)) throw new Error('Protected production file path');
    safePath(root, resolve(root, path));
  }
  for (const path of Object.keys(files)) {
    if (!task.files.includes(path) || isAbsolute(path) || path === task.test || protectedPath.test(path)) {
      throw new Error('Model file path is undeclared or protected');
    }
    safePath(root, resolve(root, path));
  }
  return files;
}
export function requireTaskRed(root: string, task: PlanTask): void {
  const selection = [{ id: task.id, test: task.test, ...(task.assertion ? { assertion: task.assertion } : {}) }];
  if (task.status !== 'in_progress' || task.red?.outcome !== 'red' || !validateExecutionReceipt(root, task.red) ||
      task.red.tests[task.test] !== hashBytes(readFileSync(selectedFile(root, task.test))) ||
      JSON.stringify(task.red.selection) !== JSON.stringify(selection)) throw new Error('Unchanged genuine task RED required');
}
export interface AttemptInput {
  root: string; changeDir: string; taskId: string; config: LoopConfig; remainingMs: number; maxTokens: number;
  parentOwner?: { pid: number; started: string };
}
export async function runPilotfishAttempt(input: AttemptInput): Promise<{ status: string; reason?: string; execution?: ExecutionReceipt }> {
  const config = validateLoopConfig(input.config);
  const checkOwner = () => {
    if (!input.parentOwner) return;
    const owner = z.object({ pid: z.number().int().positive(), started: z.string().min(1) }).parse(input.parentOwner);
    try {
      process.kill(owner.pid, 0);
      if (processIdentity(owner.pid) !== owner.started) throw new Error('Parent identity changed');
    } catch { throw new Error('Parent loop owner is gone; worker cannot write'); }
  };
  checkOwner();
  if (!Number.isSafeInteger(input.maxTokens) || input.maxTokens <= 0) throw new Error('Positive token cap required');
  const task = readPlanJson(input.changeDir).tasks.find(t => t.id === input.taskId);
  if (!task) throw new Error('Unknown Pilotfish task');
  const currentBranch = () => execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: input.root, encoding: 'utf8' }).trim();
  const branch = currentBranch();
  if (['main', 'master', 'trunk'].includes(branch)) throw new Error('Pilotfish attempt requires a work branch');
  requireTaskRed(input.root, task);
  guardModelFiles(input.root, task, { files: {} });
  const selection = [{ id: task.id, test: task.test, ...(task.assertion ? { assertion: task.assertion } : {}) }];
  const started = Date.now();
  let execution = executeTests(input.root, selection);
  if (execution.runner.sha256 !== task.red!.runner.sha256 || execution.runner.version !== task.red!.runner.version) {
    throw new Error('Task runner changed since RED');
  }
  // A model may have finished its write just before interruption. Establish
  // current GREEN directly and avoid repeating that write on resume.
  if (execution.outcome === 'green') return { status: 'complete', execution };
  if (execution.outcome !== 'red') throw new Error('Task execution is inconclusive before model attempt');
  const pilotfish = await import(pathToFileURL(config.pilotfishModule).href);
  if (typeof pilotfish.runTask !== 'function') throw new Error('Pilotfish module has no runTask');
  const scratch = mkdtempSync(join(tmpdir(), 'orca-loop-model-'));
  try {
    const result = await pilotfish.runTask({
      changeDir: input.changeDir, projectRoot: input.root, taskId: task.id,
      config: { roles: config.roles }, maxIterationsOverride: 1,
      modelCaller: async (call: unknown) => {
        checkOwner();
        const files: Record<string, string> = {};
        for (const path of [...task.files, task.test]) {
          const file = safePath(input.root, resolve(input.root, path));
          if (existsSync(file)) files[path] = readFileSync(file, 'utf8');
        }
        const prompt = join(scratch, 'prompt.json');
        const modelCall = z.object({ role: z.string(), model: z.string(), attempt: z.number() }).passthrough().parse(call);
        const taskContext = { id: task.id, behavior: task.behavior, acceptance: task.acceptance, files: task.files, test: task.test };
        writeFileSync(prompt, JSON.stringify({ call: { role: modelCall.role, model: modelCall.model, attempt: modelCall.attempt,
          task: taskContext, previousError: execution.assertions.flatMap(a => a.failures).join('\n').slice(0, 4000) },
          files, maxTokens: input.maxTokens }, null, 2), { mode: 0o600 });
        const args = config.driver.args.map(a => a.replaceAll('{promptFile}', prompt)
          .replaceAll('{maxTokens}', String(input.maxTokens)).replaceAll('{model}', config.roles.apply));
        const env = Object.fromEntries(config.driver.env.filter(n => process.env[n] !== undefined).map(n => [n, process.env[n]!]));
        const receipt = await runBounded({ command: config.driver.command, args, cwd: scratch,
          env, timeoutMs: input.remainingMs - (Date.now() - started) });
        if (receipt.exit_code !== 0) throw new Error(receipt.timed_out ? 'Model wall-clock budget exhausted' :
          receipt.output_exceeded ? 'Model output exceeded cap' : `Model driver exited ${receipt.exit_code}`);
        if (currentBranch() !== branch) throw new Error('Branch changed before model file writes');
        checkOwner();
        return { files: guardModelFiles(input.root, task, JSON.parse(receipt.stdout)) };
      },
      testRunner: async () => {
        execution = executeTests(input.root, selection);
        return { passed: execution.outcome === 'green', output: JSON.stringify(execution) };
      },
    });
    return { ...result, execution };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPilotfishAttempt(JSON.parse(readFileSync(process.argv[2], 'utf8')))
    .then(result => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch(error => { console.error(`Pilotfish worker failed: ${(error as Error).message}`); process.exitCode = 1; });
}

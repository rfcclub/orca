import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { propertyEvidence, type PropertyContract } from '../property/evidence.js';

export interface TestSelection { id: string; test: string; assertion?: string; property?: PropertyContract }
export interface SourceBinding { head: string; diff_sha256: string; tree_sha256: string }
export interface ExecutionReceipt {
  version: 1;
  outcome: 'green' | 'red' | 'inconclusive';
  source: SourceBinding;
  tests: Record<string, string>;
  runner: { entry: string; sha256: string; version: string; node_version: string };
  selection: TestSelection[];
  command: { executable: string; args: string[]; exit_code: number | null; stdout: string; stderr: string };
  report: string;
  report_sha256: string;
  property_report?: string;
  property_report_sha256?: string;
  property_invocation?: string;
  assertions: { id: string; test: string; name: string; status: string; failures: string[] }[];
  reasons: string[];
  started_at: string;
  finished_at: string;
}

export const hashBytes = (bytes: string | Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');

const excluded = ['node_modules', 'dist', 'graphify-out', 'openspec', 'orca', 'loomkit', '.git'];

/** Workflow metadata is bound by its contract separately, never treated as code. */
export function sourceBinding(root: string): SourceBinding {
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const head = git(['rev-parse', 'HEAD']).trim();
  const diff = git(['diff', '--binary', 'HEAD', '--', '.', ...excluded.map(p => `:!${p}`)]);
  const paths = [...new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))]
    .filter(p => !excluded.includes(p.split('/')[0])).sort();
  const files = paths.map(path => {
    const file = resolve(root, path);
    return [path, existsSync(file) && statSync(file).isFile()
      ? `${statSync(file).mode}:${hashBytes(readFileSync(file))}` : 'absent'];
  });
  return { head, diff_sha256: hashBytes(diff), tree_sha256: hashBytes(JSON.stringify(files)) };
}

export function selectedFile(root: string, path: string): string {
  if (isAbsolute(path)) throw new Error(`Test path must be relative: ${path}`);
  const base = realpathSync(root);
  const file = realpathSync(resolve(base, path));
  const rel = relative(base, file);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel) || !statSync(file).isFile()) {
    throw new Error(`Test path escapes project or is not a file: ${path}`);
  }
  return file;
}

const assertionSchema = z.object({
  fullName: z.string(), status: z.enum(['passed', 'failed', 'pending', 'skipped', 'todo', 'disabled']),
  failureMessages: z.array(z.string()),
});
const reportSchema = z.object({
  success: z.boolean(), numTotalTests: z.number().int().positive(),
  numPassedTests: z.number().int().nonnegative(), numFailedTests: z.number().int().nonnegative(),
  numPendingTests: z.number().int().nonnegative(), numTodoTests: z.number().int().nonnegative().optional(),
  testResults: z.array(z.object({ name: z.string(), assertionResults: z.array(assertionSchema), status: z.string(), message: z.string() })),
});
function reportEvidence(root: string, selection: TestSelection[], report: string, exitCode: number | null):
  Pick<ExecutionReceipt, 'assertions' | 'reasons' | 'outcome'> {
  const reasons: string[] = [];
  const assertions: ExecutionReceipt['assertions'] = [];
  let green = false;
  let red = false;
  try {
    const data = reportSchema.parse(JSON.parse(report));
    const all = data.testResults.flatMap(s => s.assertionResults);
    if (all.length !== data.numTotalTests || all.filter(a => a.status === 'passed').length !== data.numPassedTests ||
        all.filter(a => a.status === 'failed').length !== data.numFailedTests) {
      reasons.push('Reporter assertion totals are inconsistent');
    }
    for (const selected of selection) {
      const suites = data.testResults.filter(s => realpathSync(resolve(root, s.name)) === selectedFile(root, selected.test));
      const matches = suites.flatMap(s => s.assertionResults)
        .filter(a => selected.assertion ? a.fullName === selected.assertion : a.fullName.includes(`[${selected.id}]`));
      if (matches.length !== 1) reasons.push(`Expected exactly one executed assertion for ${selected.id}; found ${matches.length}`);
      else assertions.push({ id: selected.id, test: selected.test, name: matches[0].fullName,
        status: matches[0].status, failures: matches[0].failureMessages });
    }
    if (new Set(assertions.map(a => `${selectedFile(root, a.test)}\0${a.name}`)).size !== assertions.length) {
      reasons.push('An executed assertion was reused for multiple required IDs');
    }
    green = data.success && exitCode === 0 && data.numFailedTests === 0 &&
      assertions.length === selection.length && assertions.every(a => a.status === 'passed');
    const failed = assertions.filter(a => a.status === 'failed');
    red = !data.success && exitCode === 1 && assertions.length === selection.length &&
      assertions.every(a => a.status === 'passed' || a.status === 'failed') &&
      failed.length > 0 && failed.length === data.numFailedTests &&
      failed.every(a => a.failures.length > 0 && a.failures.every(f => /^AssertionError\b/.test(f)));
    if (!green && !red) reasons.push('Required assertions did not establish GREEN or assertion-failure RED');
  } catch (error) {
    reasons.push(`Missing or invalid Vitest reporter: ${(error as Error).message}`);
  }
  return { assertions, reasons, outcome: reasons.length === 0 ? green ? 'green' : red ? 'red' : 'inconclusive' : 'inconclusive' };
}

export function validateExecutionReceipt(root: string, receipt: ExecutionReceipt): boolean {
  try {
    if (receipt.version !== 1 || receipt.report_sha256 !== hashBytes(receipt.report) || receipt.reasons.length) return false;
    const evidence = reportEvidence(root, receipt.selection, receipt.report, receipt.command.exit_code);
    if (receipt.selection.some(s => s.property) &&
        (receipt.property_report_sha256 !== hashBytes(receipt.property_report ?? '') ||
         propertyEvidence(root, receipt.selection, receipt.property_report ?? '', receipt.property_invocation, receipt.outcome).length)) return false;
    return evidence.outcome === receipt.outcome && evidence.outcome !== 'inconclusive' &&
      JSON.stringify(evidence.assertions) === JSON.stringify(receipt.assertions);
  } catch { return false; }
}

/** Invoke the local runner directly; selection and status never come from a shell command. */
export function executeTests(root: string, selection: TestSelection[]): ExecutionReceipt {
  if (selection.length === 0 || new Set(selection.map(s => s.id)).size !== selection.length) {
    throw new Error('Execution needs unique required assertion IDs');
  }
  const tests = Object.fromEntries(selection.map(s => [s.test, hashBytes(readFileSync(selectedFile(root, s.test)))]));
  const packagePath = createRequire(join(resolve(root), 'package.json')).resolve('vitest/package.json');
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  const entry = realpathSync(join(dirname(packagePath), 'vitest.mjs'));
  const runner = { entry, sha256: hashBytes(readFileSync(entry)), version: packageJson.version as string, node_version: process.version };
  const source = sourceBinding(root);
  const temp = mkdtempSync(join(tmpdir(), 'orca-vitest-'));
  const output = join(temp, 'report.json');
  const propertyInvocation = randomUUID();
  const args = [entry, 'run', ...new Set(selection.map(s => s.test)), '--root', resolve(root),
    '--reporter=json', `--outputFile=${output}`, '--maxWorkers=1', '--no-file-parallelism',
    '--expect.requireAssertions'];
  const started_at = new Date().toISOString();
  try {
    const run = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, CI: 'true',
        ORCA_PROPERTY_RUN_ID: selection.some(s => s.property) ? propertyInvocation : undefined,
        ORCA_PROPERTY_RECEIPT_DIR: selection.some(s => s.property) ? temp : undefined } });
    const report = existsSync(output) ? readFileSync(output, 'utf8') : '';
    const reasons: string[] = [];
    if (run.error) reasons.push(`Runner failed: ${run.error.message}`);
    const evidence = reportEvidence(root, selection, report, run.status);
    const { assertions } = evidence;
    reasons.push(...evidence.reasons);
    const propertyReport = JSON.stringify(readdirSync(temp).filter(p => p !== 'report.json' && p.endsWith('.json')).sort()
      .map(p => JSON.parse(readFileSync(join(temp, p), 'utf8'))));
    reasons.push(...propertyEvidence(root, selection, propertyReport, propertyInvocation, evidence.outcome));
    if (JSON.stringify(sourceBinding(root)) !== JSON.stringify(source) ||
        selection.some(s => hashBytes(readFileSync(selectedFile(root, s.test))) !== tests[s.test]) ||
        hashBytes(readFileSync(entry)) !== runner.sha256) reasons.push('Execution inputs changed while the runner was running');
    return { version: 1, outcome: reasons.length === 0 ? evidence.outcome : 'inconclusive',
      source, tests, runner, selection, command: { executable: process.execPath, args, exit_code: run.status,
        stdout: run.stdout ?? '', stderr: run.stderr ?? '' }, report, report_sha256: hashBytes(report),
      property_report: propertyReport, property_report_sha256: hashBytes(propertyReport), property_invocation: propertyInvocation,
      assertions, reasons, started_at, finished_at: new Date().toISOString() };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

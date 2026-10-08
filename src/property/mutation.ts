import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { executeTests, hashBytes, selectedFile, sourceBinding, validateExecutionReceipt,
  type ExecutionReceipt, type TestSelection } from '../verify/execution.js';
import { verifyOperatorSignature } from '../harness/local-review.js';
import { corpusPath } from './corpus-path.js';

const mutationSchema = z.object({
  version: z.literal(1), id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/), rationale: z.string().min(1),
  changes: z.array(z.object({ path: z.string().min(1), before_sha256: z.string().regex(/^[a-f0-9]{64}$/), after: z.string() })),
});
export type Mutation = z.infer<typeof mutationSchema>;
export function mutationDigest(input: unknown): string {
  return hashBytes(JSON.stringify(mutationSchema.parse(input)));
}
export interface MutationReceipt {
  version: 1;
  status: 'killed' | 'survived' | 'equivalent' | 'invalid' | 'unavailable';
  mutation: Mutation | null;
  mutation_sha256: string | null;
  selection: TestSelection[];
  baseline: ExecutionReceipt | null;
  mutant: ExecutionReceipt | null;
  reasons: string[];
  equivalence?: { reviewer: string; rationale: string; signature: string; digest: string };
}

/** Apply edits only to an owned snapshot of the actual current caller source. */
export function probeMutation(root: string, selection: TestSelection[], input?: unknown): MutationReceipt {
  const receipt: MutationReceipt = { version: 1, status: 'unavailable', mutation: null,
    mutation_sha256: null, selection, baseline: null, mutant: null, reasons: [] };
  let temporary: string | undefined;
  try {
    if (!input) { receipt.reasons.push('No applicable mutation supplied'); return receipt; }
    const mutation = mutationSchema.parse(input);
    receipt.mutation = mutation;
    receipt.mutation_sha256 = mutationDigest(mutation);
    if (!mutation.changes.length) { receipt.reasons.push('No applicable mutation supplied'); return receipt; }
    if (new Set(mutation.changes.map(c => c.path)).size !== mutation.changes.length) throw new Error('Duplicate mutation target');
    const testFiles = new Set(selection.flatMap(s => [s.test, ...(s.property?.generators ?? [])])
      .map(path => selectedFile(root, path)));
    for (const edit of mutation.changes) {
      const file = selectedFile(root, edit.path);
      if (testFiles.has(file) || /(^|\/)(tests?|__tests__|node_modules|dist|openspec|orca|loomkit|graphify-out|\.git)(\/|$)/.test(edit.path) ||
          /\.(test|spec)\.[cm]?[jt]s$/.test(edit.path) || /(^|\/)(package(?:-lock)?\.json|.*lock.*|(?:vitest|vite|tsconfig).*|\.gitignore)$/.test(edit.path)) {
        throw new Error('Mutation cannot change tests, generators, dependencies or harness metadata');
      }
      if (hashBytes(readFileSync(file)) !== edit.before_sha256) throw new Error('Stale mutation source hash');
      if (edit.before_sha256 === hashBytes(edit.after)) {
        receipt.reasons.push('Mutation does not change source bytes'); return receipt;
      }
    }
    receipt.baseline = executeTests(root, selection);
    if (receipt.baseline.outcome !== 'green') throw new Error('Baseline did not establish GREEN');
    const paths = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
    temporary = mkdtempSync(join(tmpdir(), 'orca-mutation-'));
    const checkout = join(temporary, 'project');
    mkdirSync(checkout);
    for (const path of new Set(paths)) {
      if (['node_modules', 'dist', 'graphify-out', 'openspec', 'orca', 'loomkit', '.git'].includes(path.split('/')[0])) continue;
      const from = resolve(root, path);
      if (!existsSync(from)) continue;
      if (lstatSync(from).isSymbolicLink() || !lstatSync(from).isFile()) throw new Error(`Unsupported snapshot source: ${path}`);
      const to = join(checkout, path);
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, readFileSync(from));
      chmodSync(to, lstatSync(from).mode);
    }
    for (const selected of selection) {
      if (!selected.property) continue;
      const from = corpusPath(root, selected.property.corpus);
      if (existsSync(from)) {
        const to = corpusPath(checkout, selected.property.corpus);
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, readFileSync(from));
      }
    }
    symlinkSync(resolve(root, 'node_modules'), join(checkout, 'node_modules'), 'dir');
    const git = (args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args],
      { cwd: checkout, stdio: 'pipe' });
    git(['init', '-q']); git(['add', '.']);
    git(['-c', 'user.name=Orca probe', '-c', 'user.email=probe@orca.invalid', 'commit', '-qm', 'current source snapshot']);
    for (const edit of mutation.changes) {
      const file = selectedFile(checkout, edit.path);
      if (hashBytes(readFileSync(file)) !== edit.before_sha256) throw new Error('Snapshot differs from pinned mutation source');
      writeFileSync(file, edit.after);
    }
    receipt.mutant = executeTests(checkout, selection);
    if (JSON.stringify(sourceBinding(root)) !== JSON.stringify(receipt.baseline.source)) throw new Error('Caller changed during mutation probe');
    if (JSON.stringify(receipt.baseline.tests) !== JSON.stringify(receipt.mutant.tests) ||
        receipt.baseline.runner.sha256 !== receipt.mutant.runner.sha256 ||
        receipt.baseline.runner.version !== receipt.mutant.runner.version) throw new Error('Mutation changed test or runner identity');
    receipt.status = receipt.mutant.outcome === 'red' ? 'killed' :
      receipt.mutant.outcome === 'green' ? 'survived' : 'invalid';
    if (receipt.status === 'invalid') receipt.reasons.push(...receipt.mutant.reasons);
  } catch (error) {
    receipt.status = 'invalid'; receipt.reasons.push((error as Error).message);
  } finally {
    if (temporary) {
      try { rmSync(temporary, { recursive: true, force: true }); }
      catch (error) { receipt.status = 'invalid'; receipt.reasons.push(`Probe cleanup failed: ${(error as Error).message}`); }
    }
  }
  return receipt;
}

export function equivalenceDigest(receipt: MutationReceipt, rationale: string): string {
  if (receipt.status !== 'survived' || !receipt.baseline || !receipt.mutant || !rationale.trim()) {
    throw new Error('Equivalence review requires an actual surviving probe and rationale');
  }
  if (hashBytes(JSON.stringify(receipt.mutation)) !== receipt.mutation_sha256) throw new Error('Mutation digest changed');
  return hashBytes(JSON.stringify(['orca-property-equivalence/v1', receipt.mutation_sha256,
    receipt.baseline.source, receipt.baseline.tests, receipt.baseline.runner,
    receipt.baseline.report_sha256, receipt.mutant.report_sha256,
    receipt.selection, rationale]));
}

/** Surviving tests cannot establish equivalence; require separate human authority. */
export function applyEquivalenceReview(root: string, receipt: MutationReceipt,
  review: { reviewer: string; rationale: string; signature: string }, reviewersFile?: string): MutationReceipt {
  const digest = equivalenceDigest(receipt, review.rationale);
  if (!verifyOperatorSignature(root, 'orca-property-equivalence/v1', digest,
    review.reviewer, review.signature, reviewersFile)) throw new Error('Invalid equivalence review signature');
  if (!receipt.baseline || !validateExecutionReceipt(root, receipt.baseline) ||
      JSON.stringify(sourceBinding(root)) !== JSON.stringify(receipt.baseline.source)) throw new Error('Stale equivalence review evidence');
  const rerun = probeMutation(root, receipt.selection, receipt.mutation);
  if (rerun.status !== 'survived' || JSON.stringify(rerun.baseline?.runner) !== JSON.stringify(receipt.baseline.runner)) {
    throw new Error('Current mutation or runner no longer establishes the reviewed surviving probe');
  }
  return { ...receipt, status: 'equivalent', equivalence: { ...review, digest } };
}

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { executeTests, hashBytes, selectedFile, sourceBinding, type ExecutionReceipt, type TestSelection } from './execution.js';

export interface ReplayReceipt {
  version: 1;
  passed: boolean;
  base_revision: string;
  base: ExecutionReceipt;
  head: ExecutionReceipt;
  setup: { kind: 'current-dependency-link'; dependency_root: string; lockfiles: Record<string, string | null>; harness: Record<string, string> };
  reasons: string[];
}

function overlayFile(checkout: string, path: string, bytes: Buffer): void {
  const base = realpathSync(checkout);
  const destination = resolve(base, path);
  const rel = relative(base, destination);
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error(`Unsafe replay overlay: ${path}`);
  for (let current = destination; current !== base; current = dirname(current)) {
    let link = false;
    try { link = lstatSync(current).isSymbolicLink(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (link) throw new Error(`Replay overlay follows a base symlink: ${path}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, bytes);
}

/** Base is isolated; the actual caller tree (including dirty source) is executed directly. */
export function replayTests(root: string, base: string, selection: TestSelection[], harnessPaths: string[] = []): ReplayReceipt {
  root = realpathSync(root);
  const git = (args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const revision = git(['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]).trim();
  const tests = selection.map(s => ({ path: relative(root, selectedFile(root, s.test)), bytes: readFileSync(selectedFile(root, s.test)) }));
  const baseSelection = selection.map((s, index) => ({ ...s, test: tests[index].path }));
  const harness = [...new Set(harnessPaths)].map(path => {
    const file = selectedFile(root, path);
    const canonical = relative(root, file);
    if (!/^(tests|test|__tests__)\//.test(canonical) &&
        !/^(vitest|vite)\.config\.[cm]?[jt]s$/.test(canonical) &&
        !/^tsconfig(?:\.[\w-]+)?\.json$/.test(canonical)) throw new Error(`Replay harness must be test-only: ${path}`);
    return { path: canonical, bytes: readFileSync(file) };
  });
  const dependency_root = realpathSync(join(root, 'node_modules'));
  const lockfiles = Object.fromEntries(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']
    .map(path => [path, existsSync(join(root, path)) ? hashBytes(readFileSync(join(root, path))) : null]));
  const head = executeTests(root, selection);
  const temporary = mkdtempSync(join(tmpdir(), 'orca-replay-'));
  const checkout = join(temporary, 'base');
  let added = false;
  let receipt: ReplayReceipt | null = null;
  try {
    git(['worktree', 'add', '--detach', checkout, revision]);
    added = true;
    for (const test of [...tests, ...harness]) {
      overlayFile(checkout, test.path, test.bytes);
    }
    rmSync(join(checkout, 'node_modules'), { recursive: true, force: true });
    symlinkSync(dependency_root, join(checkout, 'node_modules'), 'dir');
    const baseline = executeTests(checkout, baseSelection);
    const reasons: string[] = [];
    if (head.outcome !== 'green') reasons.push('Current source did not establish GREEN');
    if (baseline.outcome !== 'red') reasons.push('Base did not establish assertion-failure RED; setup failure is inconclusive');
    if (selection.some((s, index) => baseline.tests[baseSelection[index].test] !== head.tests[s.test])) reasons.push('Base/head regression test bytes differ');
    if (baseline.runner.sha256 !== head.runner.sha256 || baseline.runner.version !== head.runner.version) reasons.push('Base/head runner differs');
    if (JSON.stringify(sourceBinding(root)) !== JSON.stringify(head.source)) reasons.push('Caller source changed during replay');
    if (harness.some(h => hashBytes(readFileSync(selectedFile(root, h.path))) !== hashBytes(h.bytes))) reasons.push('Harness changed during replay');
    receipt = { version: 1, passed: reasons.length === 0, base_revision: revision, base: baseline, head,
      setup: { kind: 'current-dependency-link', dependency_root, lockfiles,
        harness: Object.fromEntries(harness.map(h => [h.path, hashBytes(h.bytes)])) }, reasons };
    return receipt;
  } finally {
    if (added) {
      try {
        git(['worktree', 'remove', '--force', checkout]);
        rmSync(temporary, { recursive: true, force: true });
      } catch (error) {
        if (!receipt) throw error;
        receipt.passed = false;
        receipt.reasons.push(`Temporary checkout cleanup failed: ${(error as Error).message}`);
      }
    } else rmSync(temporary, { recursive: true, force: true });
  }
}

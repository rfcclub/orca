import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const roots: string[] = [];
const modules = fileURLToPath(new URL('../../node_modules', import.meta.url));

function project() {
  const root = mkdtempSync(join(tmpdir(), 'orca-replay-'));
  roots.push(root);
  mkdirSync(join(root, 'tests'));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(root, '.gitignore'), 'node_modules\n');
  writeFileSync(join(root, 'source.js'), 'export const value = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-qm', 'base'], { cwd: root });
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  symlinkSync(modules, join(root, 'node_modules'), 'dir');
  writeFileSync(join(root, 'tests/value.test.js'), `import {it, expect} from 'vitest';
import {value} from '../source.js';
it('[value-correct]', () => expect(value).toBe(2));
`);
  writeFileSync(join(root, 'source.js'), 'export const value = 2;\n');
  return { root, base };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('replays identical new regression bytes at pinned base and exact dirty current source', async () => {
  const { root, base } = project();
  const before = execFileSync('git', ['status', '--porcelain=v1'], { cwd: root, encoding: 'utf8' });
  const worktrees = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8' });
  const replayPath = '../../src/verify/replay.js';
  const api = await import(replayPath).catch(() => null);
  expect(api?.replayTests).toBeTypeOf('function');
  const receipt = api!.replayTests(root, base, [{ id: 'value-correct', test: 'tests/value.test.js' }]);
  expect(receipt.passed, JSON.stringify(receipt.reasons)).toBe(true);
  expect(receipt.base_revision).toBe(base);
  expect(receipt.base.outcome).toBe('red');
  expect(receipt.head.outcome).toBe('green');
  expect(receipt.base.tests).toEqual(receipt.head.tests);
  expect(receipt.setup.kind).toBe('current-dependency-link');
  expect(execFileSync('git', ['status', '--porcelain=v1'], { cwd: root, encoding: 'utf8' })).toBe(before);
  expect(execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8' })).toBe(worktrees);
}, 30000);

it('records missing base harness imports as inconclusive and supports explicit test-only overlays', async () => {
  const { root, base } = project();
  writeFileSync(join(root, 'tests/harness.js'), 'export const expected = 2;\n');
  writeFileSync(join(root, 'tests/value.test.js'), `import {it, expect} from 'vitest';
import {value} from '../source.js';
import {expected} from './harness.js';
it('[value-correct]', () => expect(value).toBe(expected));
`);
  const { replayTests } = await import('../../src/verify/replay.js');
  const unknown = replayTests(root, base, [{ id: 'value-correct', test: 'tests/value.test.js' }]);
  expect(unknown.passed).toBe(false);
  expect(unknown.base.outcome).toBe('inconclusive');
  const receipt = replayTests(root, base, [{ id: 'value-correct', test: 'tests/value.test.js' }], ['tests/harness.js']);
  expect(receipt.passed, JSON.stringify(receipt.reasons)).toBe(true);
  expect(receipt.setup.harness['tests/harness.js']).toMatch(/^[a-f0-9]{64}$/);
}, 30000);

it('cannot create an external file through a dangling base test symlink', async () => {
  const { root } = project();
  const external = mkdtempSync(join(tmpdir(), 'orca-replay-external-'));
  roots.push(external);
  const sentinel = join(external, 'absent.test.js');
  const regression = readFileSync(join(root, 'tests/value.test.js'));
  rmSync(join(root, 'tests/value.test.js'));
  symlinkSync(sentinel, join(root, 'tests/value.test.js'));
  execFileSync('git', ['add', 'tests'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-qm', 'base dangling symlink'], { cwd: root });
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  rmSync(join(root, 'tests/value.test.js'));
  writeFileSync(join(root, 'tests/value.test.js'), regression);
  const { replayTests } = await import('../../src/verify/replay.js');
  try { replayTests(root, base, [{ id: 'value-correct', test: 'tests/value.test.js' }]); } catch {}
  expect(existsSync(sentinel)).toBe(false);
}, 30000);

it('cannot overwrite an external file through a symlink in the base checkout', async () => {
  const { root } = project();
  const external = mkdtempSync(join(tmpdir(), 'orca-replay-external-'));
  roots.push(external);
  const sentinel = join(external, 'value.test.js');
  writeFileSync(sentinel, 'external contents must survive\n');
  const regression = readFileSync(join(root, 'tests/value.test.js'));
  rmSync(join(root, 'tests'), { recursive: true });
  symlinkSync(external, join(root, 'tests'), 'dir');
  execFileSync('git', ['add', 'tests'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-qm', 'base symlink'], { cwd: root });
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  rmSync(join(root, 'tests'));
  mkdirSync(join(root, 'tests'));
  writeFileSync(join(root, 'tests/value.test.js'), regression);
  const { replayTests } = await import('../../src/verify/replay.js');
  try { replayTests(root, base, [{ id: 'value-correct', test: 'tests/value.test.js' }]); } catch {}
  expect(readFileSync(sentinel, 'utf8')).toBe('external contents must survive\n');
}, 30000);

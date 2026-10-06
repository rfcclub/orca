import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const roots: string[] = [];
const modules = fileURLToPath(new URL('../../node_modules', import.meta.url));

export function fixture(test: string): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-execution-'));
  roots.push(root);
  mkdirSync(join(root, 'tests'));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(root, '.gitignore'), 'node_modules\n');
  writeFileSync(join(root, 'source.js'), 'export const value = 1;\n');
  writeFileSync(join(root, 'tests/value.test.js'), test);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
    'add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-qm', 'fixture'], { cwd: root });
  symlinkSync(modules, join(root, 'node_modules'), 'dir');
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('runs a required assertion and binds genuine GREEN to source, test and runner bytes', async () => {
  const root = fixture(`import {it, expect} from 'vitest';
import {value} from '../source.js';
it('[value-correct] computes a value', () => expect(value).toBe(1));
`);
  const executionPath = '../../src/verify/execution.js';
  const api = await import(executionPath).catch(() => null);
  expect(api?.executeTests).toBeTypeOf('function');
  const receipt = api!.executeTests(root, [{ id: 'value-correct', test: 'tests/value.test.js' }]);
  expect(receipt.outcome, JSON.stringify({ reasons: receipt.reasons, stderr: receipt.command.stderr })).toBe('green');
  expect(receipt.command.exit_code).toBe(0);
  expect(receipt.source.head).toMatch(/^[a-f0-9]{40}$/);
  expect(receipt.source.tree_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(receipt.tests['tests/value.test.js']).toMatch(/^[a-f0-9]{64}$/);
  expect(receipt.runner.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(receipt.report_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(receipt.assertions.map(a => a.id)).toEqual(['value-correct']);
}, 30000);

it('does not accept a named but empty test as assertion execution', async () => {
  const root = fixture(`import {it} from 'vitest';
it('[value-correct] empty body', () => {});
`);
  const { executeTests } = await import('../../src/verify/execution.js');
  const receipt = executeTests(root, [{ id: 'value-correct', test: 'tests/value.test.js' }]);
  expect(receipt.outcome).toBe('inconclusive');
  expect(receipt.reasons.join('\n')).toContain('assertion');
}, 30000);

it.each(['tests/value.test.js', './tests/value.test.js'])('cannot reuse one executed assertion through %s for two IDs', async alias => {
  const root = fixture(`import {it, expect} from 'vitest';
it('[first][second] one assertion', () => expect(1).toBe(1));
`);
  const { executeTests } = await import('../../src/verify/execution.js');
  const receipt = executeTests(root, [
    { id: 'first', test: 'tests/value.test.js' },
    { id: 'second', test: alias },
  ]);
  expect(receipt.outcome).toBe('inconclusive');
  expect(receipt.reasons.join('\n')).toContain('reused');
}, 30000);

it.each([
  ['skipped', `import {it,expect} from 'vitest'; it.skip('[value-correct]', () => expect(1).toBe(1));`],
  ['unrelated', `import {it,expect} from 'vitest'; it('unrelated', () => expect(1).toBe(1));`],
  ['ambiguous', `import {it,expect} from 'vitest'; it('[value-correct] first', () => expect(1).toBe(1)); it('[value-correct] second', () => expect(1).toBe(1));`],
  ['import failure', `import './missing.js'; import {it,expect} from 'vitest'; it('[value-correct]', () => expect(1).toBe(1));`],
  ['runtime error', `import {it} from 'vitest'; it('[value-correct]', () => { throw new Error('broken setup'); });`],
  ['input mutation', `import {it,expect} from 'vitest'; import {writeFileSync} from 'node:fs'; it('[value-correct]', () => { expect(1).toBe(1); writeFileSync('source.js', 'export const value=2;'); });`],
])('leaves %s execution inconclusive', async (_name, test) => {
  const root = fixture(test);
  const { executeTests } = await import('../../src/verify/execution.js');
  const receipt = executeTests(root, [{ id: 'value-correct', test: 'tests/value.test.js' }]);
  expect(receipt.outcome, JSON.stringify(receipt.reasons)).toBe('inconclusive');
}, 30000);

it('records genuine RED only when the mapped assertion actually fails', async () => {
  const root = fixture(`import {it, expect} from 'vitest';
import {value} from '../source.js';
it('[value-correct] computes a value', () => expect(value).toBe(2));
`);
  const { executeTests } = await import('../../src/verify/execution.js');
  const receipt = executeTests(root, [{ id: 'value-correct', test: 'tests/value.test.js' }]);
  expect(receipt.outcome, JSON.stringify(receipt.reasons)).toBe('red');
  expect(receipt.command.exit_code).not.toBe(0);
  expect(receipt.assertions[0].failures.join('\n')).toContain('AssertionError');
}, 30000);

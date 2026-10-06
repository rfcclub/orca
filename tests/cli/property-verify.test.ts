import { expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const cli = process.env.ORCA_TEST_CLI ?? fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url));
const helper = fileURLToPath(new URL('../../dist/property/runtime.js', import.meta.url));
function fixture(body: string, clauses = '', mapped = true) {
  const root = mkdtempSync(join(tmpdir(), 'orca-property-cli-'));
  const dir = join(root, 'openspec/changes/demo');
  mkdirSync(join(dir, 'specs/demo'), { recursive: true });
  mkdirSync(join(root, 'tests'));
  writeFileSync(join(root, 'package.json'), '{"name":"fixture","type":"module"}');
  writeFileSync(join(root, '.gitignore'), 'node_modules\n');
  writeFileSync(join(dir, 'specs/demo/spec.md'), `## ADDED Requirements
### Requirement: Arithmetic
The result MUST be correct.
#### Property: identity
- **FOR ALL** value: integer
- **THEN** identity equals its input
- **RUNS** 100
${clauses}`);
  writeFileSync(join(dir, '.traceability.yaml'), JSON.stringify({ scenarios: [{
    scenario: 'arithmetic-identity', test: 'tests/property.test.js',
    ...(mapped ? { generators: ['tests/property.test.js'], corpus: 'orca/corpus/arithmetic-identity.json' } : {}),
    status: 'passing',
  }] }));
  writeFileSync(join(root, 'tests/property.test.js'), `import {it,expect} from 'vitest';
import {assertProperty,fc} from ${JSON.stringify(helper)};
it('[arithmetic-identity]', async () => { ${body} });`);
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root });
  const run = () => spawnSync(process.execPath, [cli, 'verify', 'demo'], { cwd: root, encoding: 'utf8' });
  return { root, dir, run, clean: () => rmSync(root, { recursive: true, force: true }) };
}
const successful = `const r=await assertProperty({id:'arithmetic-identity',seed:123,numRuns:100,
corpus:'orca/corpus/arithmetic-identity.json',arbitrary:fc.integer(),predicate:n=>n===n});
expect(r.failed).toBe(false);`;

it('Property executable file workflow consumes actual seeded framework receipts', () => {
  const f = fixture(successful);
  try {
    const bin = join(f.root, 'bin'); mkdirSync(bin);
    const marker = join(f.root, 'gh-called');
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf called > '${marker}'\nexit 99\n`, { mode: 0o755 });
    symlinkSync('/usr/bin/git', join(bin, 'git'));
    const block = join(f.root, 'no-network.cjs');
    writeFileSync(block, `const deny=()=>{throw Error('Network forbidden')};global.fetch=deny;
for(const name of ['node:http','node:https']){const m=require(name);m.request=deny;m.get=deny;}
require('node:net').connect=deny;require('node:net').createConnection=deny;`);
    const env = { ...process.env, PATH: bin, NODE_OPTIONS: `--require=${block}` };
    const result = spawnSync(process.execPath, [cli, 'verify', 'demo'], { cwd: f.root, env, encoding: 'utf8' });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const receipt = JSON.parse(readFileSync(join(f.dir, '.orca-verify.json'), 'utf8'));
    expect(receipt.passed).toBe(true);
    const runs = JSON.parse(receipt.execution.property_report);
    expect(runs).toHaveLength(1);
    expect(runs[0].successful_runs).toBe(100);
    expect(runs[0].seed).toBe(123);
    expect(runs[0].invocation).toBe(receipt.execution.property_invocation);
    const archive = spawnSync(process.execPath, [cli, 'archive', 'demo'], { cwd: f.root, env, encoding: 'utf8' });
    expect(archive.status, archive.stdout + archive.stderr).toBe(0);
    expect(readFileSync(join(f.root, 'openspec/specs/demo/spec.md'), 'utf8')).toContain('#### Property: identity');
    expect(existsSync(marker)).toBe(false);
  } finally { f.clean(); }
});

it.each([
  ['under-run', successful.replace('numRuns:100', 'numRuns:10'), '', 'completed runs'],
  ['missing receipt/seed', 'expect(true).toBe(true);', '', 'property receipt'],
  ['excessive discards', successful.replace('predicate:n=>n===n', 'predicate:n=>{fc.pre(n>0);return true;}'), '- **DISCARDS** <= 0%\n', 'discard'],
  ['unmet category', successful, '- **COVERAGE** gap >= 5%\n', 'category'],
])('Property verification rejects %s despite a green enclosing assertion', (_name, body, clauses, reason) => {
  const f = fixture(body, clauses);
  try {
    const result = f.run();
    expect(result.status).not.toBe(0);
    const receipt = JSON.parse(readFileSync(join(f.dir, '.orca-verify.json'), 'utf8'));
    expect(receipt.execution_verified).toBe(false);
    expect(JSON.stringify(receipt)).toContain(reason);
    expect(receipt.execution.assertions[0].status).toBe('passed');
  } finally { f.clean(); }
});

it('Property mapping requires generator source binding rather than agent counts', () => {
  const f = fixture(successful, '', false);
  try {
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/generator/i);
  } finally { f.clean(); }
});

it('Property corpus replay cannot be omitted by choosing a different empty corpus', () => {
  const f = fixture(successful.replace('orca/corpus/arithmetic-identity.json', 'orca/corpus/empty.json'));
  try {
    mkdirSync(join(f.root, 'orca/corpus'), { recursive: true });
    writeFileSync(join(f.root, 'orca/corpus/arithmetic-identity.json'), JSON.stringify({
      version: 1, property: 'arithmetic-identity', cases: [{
        input: { type: 'number', value: '-1' }, seed: 99, path: '0', framework: '4.10.2',
      }],
    }));
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(f.dir, '.orca-verify.json'), 'utf8')).toContain('corpus replay');
  } finally { f.clean(); }
});

it('Property corpus path cannot follow a symlink even when its file is absent', () => {
  const f = fixture(successful);
  try {
    mkdirSync(join(f.root, 'orca'), { recursive: true });
    mkdirSync(join(f.root, 'outside'));
    symlinkSync(join(f.root, 'outside'), join(f.root, 'orca/corpus'), 'dir');
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/symlink/i);
  } finally { f.clean(); }
});

it('Property base/head replay uses identical concrete corpus and generator bytes', () => {
  const f = fixture(`const {identity}=await import('../source.js');
const r=await assertProperty({id:'arithmetic-identity',seed:123,numRuns:100,
corpus:'orca/corpus/arithmetic-identity.json',arbitrary:fc.integer(),predicate:n=>identity(n)===n});
expect(r.failed).toBe(false);`);
  try {
    writeFileSync(join(f.root, 'source.js'), 'export const identity=n=>n+1;\n');
    execFileSync('git', ['add', 'source.js'], { cwd: f.root });
    execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'bug'], { cwd: f.root });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.root, encoding: 'utf8' }).trim();
    writeFileSync(join(f.root, 'source.js'), 'export const identity=n=>n;\n');
    mkdirSync(join(f.root, 'orca/corpus'), { recursive: true });
    writeFileSync(join(f.root, 'orca/corpus/arithmetic-identity.json'), JSON.stringify({
      version: 1, property: 'arithmetic-identity', cases: [{
        input: { type: 'number', value: '-1' }, seed: 99, path: '0', framework: '4.10.2',
      }],
    }));
    const result = spawnSync(process.execPath, [cli, 'verify', 'demo', '--base', base], { cwd: f.root, encoding: 'utf8' });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const receipt = JSON.parse(readFileSync(join(f.dir, '.orca-verify.json'), 'utf8'));
    const head = JSON.parse(receipt.replay.head.property_report)[0];
    const baseline = JSON.parse(receipt.replay.base.property_report)[0];
    expect(baseline.corpus.before_sha256).toBe(head.corpus.before_sha256);
    expect(baseline.corpus.cases).toBe(1);
    expect(baseline.corpus.failed).toBe(true);
    expect(baseline.seed).toBe(99);
  } finally { f.clean(); }
}, 30000);

it('Property probe CLI persists an actual surviving receipt without declaring PASS', () => {
  const f = fixture(successful);
  try {
    const source = 'export const unused=1;\n';
    writeFileSync(join(f.root, 'source.js'), source);
    const mutation = join(f.root, 'mutation.json');
    writeFileSync(mutation, JSON.stringify({ version: 1, id: 'unused-value', rationale: 'Exercise an uncovered source value',
      changes: [{ path: 'source.js', before_sha256: createHash('sha256').update(source).digest('hex'), after: 'export const unused=2;\n' }] }));
    const result = spawnSync(process.execPath, [cli, 'property-probe', 'demo', '--property', 'arithmetic-identity', '--mutation', mutation],
      { cwd: f.root, encoding: 'utf8' });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.status).toBe('survived');
    expect(receipt.baseline.outcome).toBe('green');
    expect(receipt.mutant.outcome).toBe('green');
    expect(readFileSync(join(f.dir, '.harness/property-probes/unused-value.json'), 'utf8')).toContain('"status": "survived"');
  } finally { f.clean(); }
}, 30000);

import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const modulePath = '../../dist/property/mutation.js';
const helper = fileURLToPath(new URL('../../dist/property/runtime.js', import.meta.url));
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
it('mutation input digest uses schema order consistently for CLI review', async () => {
  const api = await import(modulePath).catch(() => null);
  expect(api?.mutationDigest).toBeTypeOf('function');
  const input = { changes: [{ after: 'new', before_sha256: hash('old'), path: 'source.js' }],
    rationale: 'Required value', id: 'same-input', version: 1 };
  expect(api!.mutationDigest(input)).toBe(api!.mutationDigest({
    version: 1, id: input.id, rationale: input.rationale,
    changes: [{ path: 'source.js', before_sha256: hash('old'), after: 'new' }],
  }));
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-property-mutation-'));
  mkdirSync(join(root, 'tests'));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, '.gitignore'), 'node_modules\n');
  writeFileSync(join(root, 'source.js'), 'export const value = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'base'], { cwd: root });
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
  writeFileSync(join(root, 'source.js'), 'export const value = 2;\n');
  writeFileSync(join(root, 'tests/value.test.js'), `import {it,expect} from 'vitest';
import {value} from '../source.js';
import {assertProperty,fc} from ${JSON.stringify(helper)};
it('[value-correct]',async()=>{
 const r=await assertProperty({id:'value-correct',seed:31,numRuns:10,corpus:'orca/corpus/value-correct.json',
 arbitrary:fc.integer(),predicate:()=>value===2});
 expect(r.failed).toBe(false);
});`);
  const selection = [{ id: 'value-correct', test: 'tests/value.test.js',
    property: { runs: 10, maxDiscardRatio: 0, coverage: {}, generators: ['tests/value.test.js'], corpus: 'orca/corpus/value-correct.json' } }];
  const mutation = (after: string) => ({ version: 1, id: 'value-mutant', rationale: 'Change required source value',
    changes: [{ path: 'source.js', before_sha256: hash('export const value = 2;\n'), after }] });
  return { root, selection, mutation, clean: () => rmSync(root, { recursive: true, force: true }) };
}

it.each([
  ['killed', 'export const value = 3;\n'],
  ['survived', 'export const value = 2 + 0;\n'],
  ['invalid', 'export const value = !!!;\n'],
])('mutation probe records %s from actual execution and preserves dirty caller', async (status, source) => {
  const f = fixture();
  try {
    const api = await import(modulePath).catch(() => null);
    expect(api?.probeMutation).toBeTypeOf('function');
    const before = execFileSync('git', ['status', '--porcelain'], { cwd: f.root, encoding: 'utf8' });
    const receipt = api!.probeMutation(f.root, f.selection, f.mutation(source));
    expect(receipt.status, JSON.stringify(receipt.reasons)).toBe(status);
    expect(receipt.baseline.outcome).toBe('green');
    expect(receipt.mutant.outcome).toBe(status === 'killed' ? 'red' : status === 'survived' ? 'green' : 'inconclusive');
    expect(receipt.baseline.tests).toEqual(receipt.mutant.tests);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: f.root, encoding: 'utf8' })).toBe(before);
    expect(readFileSync(join(f.root, 'source.js'), 'utf8')).toBe('export const value = 2;\n');
  } finally { f.clean(); }
}, 30000);

it('no applicable mutation is unavailable and never a successful kill', async () => {
  const f = fixture();
  try {
    const api = await import(modulePath).catch(() => null);
    expect(api?.probeMutation).toBeTypeOf('function');
    const r = api!.probeMutation(f.root, f.selection);
    expect(r.status).toBe('unavailable');
    expect(r.mutant).toBe(null);
  } finally { f.clean(); }
});

it('mutation cannot change test/generator bytes or use a stale source hash', async () => {
  const f = fixture();
  try {
    const api = await import(modulePath).catch(() => null);
    expect(api?.probeMutation).toBeTypeOf('function');
    const stale = f.mutation('export const value=3;');
    stale.changes[0].before_sha256 = hash('stale');
    expect(api!.probeMutation(f.root, f.selection, stale).status).toBe('invalid');
    const test = f.mutation('throw Error("changed test")');
    test.changes[0].path = 'tests/value.test.js';
    test.changes[0].before_sha256 = hash(readFileSync(join(f.root, 'tests/value.test.js'), 'utf8'));
    expect(api!.probeMutation(f.root, f.selection, test).status).toBe('invalid');
  } finally { f.clean(); }
}, 30000);

it('equivalence requires an operator-pinned signature bound to the actual surviving probe', async () => {
  const f = fixture();
  const keys = mkdtempSync(join(tmpdir(), 'orca-equivalence-review-'));
  try {
    const api = await import(modulePath).catch(() => null);
    expect(api?.probeMutation).toBeTypeOf('function');
    const probe = api!.probeMutation(f.root, f.selection, f.mutation('export const value = 2 + 0;\n'));
    const pair = generateKeyPairSync('ed25519');
    const config = join(keys, 'reviewers.json');
    writeFileSync(config, JSON.stringify({ version: 1, reviewers: [{
      id: 'owner', kind: 'human', publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }),
    }] }));
    const rationale = 'Arithmetic identity preserves the required value';
    const digest = api!.equivalenceDigest(probe, rationale);
    const review = { reviewer: 'owner', rationale, signature: sign(null,
      Buffer.from(JSON.stringify(['orca-property-equivalence/v1', digest])), pair.privateKey).toString('base64') };
    expect(api!.applyEquivalenceReview(f.root, probe, review, config).status).toBe('equivalent');
    expect(() => api!.applyEquivalenceReview(f.root, probe, { ...review, rationale: 'different' }, config)).toThrow(/signature|review/i);
    const tampered = structuredClone(probe);
    tampered.mutation.changes[0].after = 'export const value = 2 * 1;\n';
    expect(() => api!.applyEquivalenceReview(f.root, tampered, review, config)).toThrow(/digest|mutation|signature/i);
  } finally { f.clean(); rmSync(keys, { recursive: true, force: true }); }
}, 30000);

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FakeGitHub } from '../helpers/fake-github.js';
import { createIssueFromChange } from '../../src/issue/create.js';
import { APPROVED_LABEL } from '../../src/issue/approve-flow.js';
import { sc } from '../helpers/sc.js';

const FULL = ['Problem', 'Desired outcome', 'Non-goals', 'Constraints', 'Success criteria']
  .map(h => `## ${h}\n\ntext for ${h}\n`).join('\n');

let dir: string;
let gh: FakeGitHub;
let out: string[];

function change(name: string, intent: string | null): string {
  const d = join(dir, name);
  mkdirSync(d, { recursive: true });
  if (intent !== null) writeFileSync(join(d, 'intent.md'), intent);
  return d;
}
const run = (extra: Record<string, unknown> = {}) =>
  createIssueFromChange({
    port: gh, repo: 'GotakoVN/orca', changesDir: dir, name: 'my-change', shape: 'enhancement',
    log: (s: string) => out.push(s), ...extra,
  });

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orca-create-')); gh = new FakeGitHub(); out = []; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const C = 'Create Issue From Change';

describe('createIssueFromChange', () => {
  it(`${sc(C, 'Issue created from a change')}`, async () => {
    const d = change('my-change', `# Intent: my-change\n\n${FULL}`);
    const r = await run();
    expect(r.created).toBe(true);
    expect(gh.created).toHaveLength(1);
    expect(gh.created[0].labels).toEqual(['enhancement']);
    expect(gh.created[0].title).toBe('my-change');
    expect(gh.created[0].body).toContain('text for Problem');
    expect(readFileSync(join(d, '.issue'), 'utf-8').trim()).toBe('https://github.com/GotakoVN/orca/issues/100');
  });

  it(`${sc(C, 'Never approved on creation')}`, async () => {
    change('my-change', `# Intent: my-change\n\n${FULL}`);
    await run();
    expect(gh.created[0].labels).not.toContain(APPROVED_LABEL);
  });

  it(`${sc(C, 'Missing intent')}`, async () => {
    change('my-change', null);
    await expect(run()).rejects.toThrow(/intent\.md/);
    expect(gh.created).toHaveLength(0);
  });

  it(`${sc(C, 'Invalid shape')}`, async () => {
    change('my-change', `# Intent: x\n\n${FULL}`);
    await expect(run({ shape: 'epic' })).rejects.toThrow(/bug.*enhancement/);
    expect(gh.created).toHaveLength(0);
  });

  it(`${sc('Creation Is Idempotent', 'Repeat creation')}`, async () => {
    const d = change('my-change', `# Intent: my-change\n\n${FULL}`);
    writeFileSync(join(d, '.issue'), 'https://github.com/GotakoVN/orca/issues/7\n');
    const r = await run();
    expect(r.created).toBe(false);
    expect(r.url).toBe('https://github.com/GotakoVN/orca/issues/7');
    expect(gh.created).toHaveLength(0);
  });

  it(`${sc('Dry Run', 'Dry run')}`, async () => {
    const d = change('my-change', `# Intent: my-change\n\n${FULL}`);
    const r = await run({ dryRun: true });
    expect(r.created).toBe(false);
    expect(gh.calls).toEqual([]);
    expect(existsSync(join(d, '.issue'))).toBe(false);
    const text = out.join('\n');
    expect(text).toContain('my-change');
    expect(text).toContain('enhancement');
    expect(text).toContain('conforming');
  });

  it(`${sc('Classification Report', 'Non-conforming body reported')}`, async () => {
    change('my-change', '# Intent: my-change\n\n## Problem\n\nonly this\n');
    const r = await run();
    expect(r.created).toBe(true);
    expect(out.join('\n')).toContain('Non-goals');
  });
});

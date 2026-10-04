import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FakeGitHub } from '../helpers/fake-github.js';
import { cmdIssue } from '../../src/cli/commands/issue.js';
import { APPROVED_LABEL } from '../../src/issue/approve-flow.js';

const ENH_BODY = ['Problem', 'Desired outcome', 'Non-goals', 'Constraints', 'Success criteria']
  .map(h => `## ${h}\n\ntext\n`).join('\n');

let dir: string;
let gh: FakeGitHub;
let out: string[];
const deps = (extra = {}) => ({
  port: gh, repo: 'GotakoVN/orca', changesDir: dir, log: (s: string) => out.push(s), config: {}, ...extra,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-cli-issue-'));
  gh = new FakeGitHub();
  out = [];
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('cmdIssue', () => {
  it('classify prints the result and the missing sections', async () => {
    gh.addIssue({ number: 3, author: 'a', labels: ['enhancement'], body: '## Problem\n\nx\n' });
    await cmdIssue(['classify', '3'], deps());
    expect(out.join('\n')).toContain('non-conforming');
    expect(out.join('\n')).toContain('Non-goals');
  });

  it('open creates the change folder from an approved issue and names the approver', async () => {
    gh.addIssue({ number: 12, author: 'a', labels: ['enhancement', APPROVED_LABEL], body: ENH_BODY });
    await gh.createComment(12, 'Approved by @alice. This issue is now the approved intent of record.');
    await cmdIssue(['open', '12', '--name', 'my-change'], deps());
    const intent = readFileSync(join(dir, 'my-change', 'intent.md'), 'utf-8');
    expect(intent).toContain('Issue: GotakoVN/orca#12');
    expect(intent).toContain('Approved by: alice');
  });

  it('open refuses an unapproved issue and writes nothing', async () => {
    gh.addIssue({ number: 12, author: 'a', labels: ['enhancement'], body: ENH_BODY });
    await expect(cmdIssue(['open', '12', '--name', 'my-change'], deps())).rejects.toThrow(/not approved/);
    expect(existsSync(join(dir, 'my-change'))).toBe(false);
  });

  it('open requires --name', async () => {
    gh.addIssue({ number: 12, author: 'a', labels: ['enhancement', APPROVED_LABEL], body: ENH_BODY });
    await expect(cmdIssue(['open', '12'], deps())).rejects.toThrow(/--name/);
  });

  it('draft prints the comment and does not post it without --post', async () => {
    gh.addIssue({ number: 4, author: 'a', labels: ['enhancement'], body: '## Problem\n\nx\n' });
    await cmdIssue(['draft', '4'], deps({ config: { provider: 'local' } }));
    expect(out.join('\n')).toContain('[orca-proposed]');
    expect(gh.calls.some(c => c.startsWith('createComment'))).toBe(false);
  });

  it('draft --post posts the comment', async () => {
    gh.addIssue({ number: 4, author: 'a', labels: ['enhancement'], body: '## Problem\n\nx\n' });
    await cmdIssue(['draft', '4', '--post'], deps({ config: { provider: 'local' } }));
    expect(gh.calls.some(c => c.startsWith('createComment'))).toBe(true);
  });

  it('draft without a configured provider fails and sends nothing', async () => {
    gh.addIssue({ number: 4, author: 'a', labels: ['enhancement'], body: '## Problem\n\nx\n' });
    await expect(cmdIssue(['draft', '4'], deps())).rejects.toThrow(/drafting\.provider/);
    expect(gh.calls.some(c => c.startsWith('createComment'))).toBe(false);
  });

  it('rejects an unknown subcommand and a bad issue number', async () => {
    await expect(cmdIssue(['frobnicate', '1'], deps())).rejects.toThrow(/Usage/);
    await expect(cmdIssue(['classify', 'abc'], deps())).rejects.toThrow(/issue number/);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FakeGitHub } from '../helpers/fake-github.js';
import { runGha } from '../../src/issue/gha.js';
import { APPROVE_MARKER, APPROVED_LABEL, ACTORS_PATH } from '../../src/issue/approve-flow.js';
import { PROGRESS_MARKER } from '../../src/issue/progress.js';

const ENH_BODY = ['Problem', 'Desired outcome', 'Non-goals', 'Constraints', 'Success criteria']
  .map(h => `## ${h}\n\ntext\n`).join('\n');

let root: string;
let gh: FakeGitHub;
const BOT = 'orca[bot]';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-gha-'));
  gh = new FakeGitHub();
  gh.addIssue({ number: 12, author: 'carol', labels: ['enhancement'], body: ENH_BODY });
  gh.setDefaultBranchFile(ACTORS_PATH, 'reviewers:\n  - login: alice\n    kind: human\n');
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const ctx = (eventName: string, payload: unknown) =>
  ({ eventName, payload: payload as Record<string, any>, repo: 'GotakoVN/orca', sha: 'abc', projectRoot: root, botLogin: BOT });

describe('runGha', () => {
  it('on an opened conforming issue: posts the approve button and sets orca:intent', async () => {
    await runGha(gh, ctx('issues', { action: 'opened', issue: { number: 12 }, sender: { login: 'carol' } }));
    const comments = await gh.listComments(12);
    expect(comments.filter(c => c.body.includes(APPROVE_MARKER))).toHaveLength(1);
    expect((await gh.getIssue(12)).labels).toContain('orca:intent');
  });

  it('does not reset an existing phase label when an issue is edited', async () => {
    await gh.addLabel(12, 'orca:design');
    await runGha(gh, ctx('issues', { action: 'edited', issue: { number: 12 }, sender: { login: 'carol' } }));
    const labels = (await gh.getIssue(12)).labels;
    expect(labels).toContain('orca:design');
    expect(labels).not.toContain('orca:intent');
  });

  it('on a ticked button edit by a reviewer: records the approval', async () => {
    await runGha(gh, ctx('issues', { action: 'opened', issue: { number: 12 }, sender: { login: 'carol' } }));
    const button = (await gh.listComments(12)).find(c => c.body.includes(APPROVE_MARKER))!;
    const checked = button.body.replace('- [ ] Approve', '- [x] Approve');
    gh.setCommentBody(button.id, checked);
    await runGha(gh, ctx('issue_comment', {
      action: 'edited', issue: { number: 12 }, sender: { login: 'alice' },
      comment: { id: button.id, body: checked }, changes: { body: { from: button.body } },
    }));
    expect((await gh.getIssue(12)).labels).toContain(APPROVED_LABEL);
  });

  it('ignores events sent by the bot itself', async () => {
    await runGha(gh, ctx('issues', { action: 'opened', issue: { number: 12 }, sender: { login: BOT } }));
    expect(gh.calls).toEqual([]);
  });

  it('ignores a newly created comment, whatever it says', async () => {
    await runGha(gh, ctx('issue_comment', {
      action: 'created', issue: { number: 12 }, sender: { login: 'alice' }, comment: { id: 5, body: 'approved' },
    }));
    expect((await gh.getIssue(12)).labels).not.toContain(APPROVED_LABEL);
  });

  it('on push: syncs every change that records an issue in this repo and skips the rest', async () => {
    const mk = (name: string, intent: string) => {
      mkdirSync(join(root, 'openspec', 'changes', name), { recursive: true });
      writeFileSync(join(root, 'openspec', 'changes', name, 'intent.md'), intent, 'utf-8');
    };
    mk('mine', '# Intent: mine\n\nIssue: GotakoVN/orca#12\n');
    mk('other-repo', '# Intent: o\n\nIssue: acme/else#4\n');
    mk('no-issue', '# Intent: n\n');
    await runGha(gh, ctx('push', { ref: 'refs/heads/master' }));
    expect((await gh.listComments(12)).filter(c => c.body.includes(PROGRESS_MARKER))).toHaveLength(1);
    expect(gh.calls.filter(c => c.startsWith('getIssue')).every(c => c === 'getIssue:12')).toBe(true);
  });

  it('on push with no openspec/changes directory: does nothing and does not throw', async () => {
    await expect(runGha(gh, ctx('push', {}))).resolves.toBeUndefined();
    expect(gh.calls).toEqual([]);
  });

  it('ignores event types it does not handle', async () => {
    await runGha(gh, ctx('watch', {}));
    expect(gh.calls).toEqual([]);
  });
});

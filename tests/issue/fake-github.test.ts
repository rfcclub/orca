import { describe, it, expect } from 'vitest';
import { FakeGitHub } from '../helpers/fake-github.js';

describe('FakeGitHub', () => {
  it('stores issues and round-trips labels', async () => {
    const gh = new FakeGitHub();
    gh.addIssue({ number: 12, author: 'alice', labels: ['enhancement'], body: 'b' });
    await gh.addLabel(12, 'orca:spec');
    await gh.removeLabel(12, 'enhancement');
    expect((await gh.getIssue(12)).labels).toEqual(['orca:spec']);
  });

  it('creates, lists and updates comments in place', async () => {
    const gh = new FakeGitHub();
    gh.addIssue({ number: 1, author: 'a', labels: [], body: '' });
    const c = await gh.createComment(1, 'one');
    await gh.updateComment(c.id, 'two');
    const list = await gh.listComments(1);
    expect(list).toHaveLength(1);
    expect(list[0].body).toBe('two');
  });

  it('reads files from the default branch and returns null when absent', async () => {
    const gh = new FakeGitHub();
    gh.setDefaultBranchFile('openspec/actors.yaml', 'reviewers: []');
    expect(await gh.readDefaultBranchFile('openspec/actors.yaml')).toBe('reviewers: []');
    expect(await gh.readDefaultBranchFile('nope')).toBeNull();
  });

  it('records every call and can be made to fail every call', async () => {
    const gh = new FakeGitHub();
    gh.addIssue({ number: 1, author: 'a', labels: [], body: '' });
    await gh.getIssue(1);
    expect(gh.calls).toEqual(['getIssue:1']);
    gh.failAll(new Error('offline'));
    await expect(gh.getIssue(1)).rejects.toThrow('offline');
  });
});

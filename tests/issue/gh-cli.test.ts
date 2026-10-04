import { describe, it, expect } from 'vitest';
import { GhCliPort, type GhExec } from '../../src/issue/gh-cli.js';

interface Call { args: string[]; input?: string }

function port(responses: Array<string | Error>): { port: GhCliPort; calls: Call[] } {
  const calls: Call[] = [];
  const exec: GhExec = async (args, input) => {
    calls.push({ args, input });
    const r = responses.shift();
    if (r === undefined) throw new Error('no canned response');
    if (r instanceof Error) throw r;
    return r;
  };
  return { port: new GhCliPort('GotakoVN/orca', exec), calls };
}

describe('GhCliPort', () => {
  it('maps an issue response to Issue', async () => {
    const { port: p, calls } = port([JSON.stringify({
      number: 12, user: { login: 'alice' }, labels: [{ name: 'bug' }, { name: 'orca:spec' }], body: 'hello',
    })]);
    expect(await p.getIssue(12)).toEqual({ number: 12, author: 'alice', labels: ['bug', 'orca:spec'], body: 'hello' });
    expect(calls[0].args).toEqual(['api', 'repos/GotakoVN/orca/issues/12']);
  });

  it('treats a null body as empty', async () => {
    const { port: p } = port([JSON.stringify({ number: 1, user: { login: 'a' }, labels: [], body: null })]);
    expect((await p.getIssue(1)).body).toBe('');
  });

  it('adds a label via a JSON body on stdin', async () => {
    const { port: p, calls } = port(['[]']);
    await p.addLabel(12, 'orca:design');
    expect(calls[0].args).toEqual(['api', '-X', 'POST', 'repos/GotakoVN/orca/issues/12/labels', '--input', '-']);
    expect(JSON.parse(calls[0].input!)).toEqual({ labels: ['orca:design'] });
  });

  it('removes a label with the name URL-encoded and ignores a 404', async () => {
    const { port: p, calls } = port([new Error('gh: Label does not exist (HTTP 404)')]);
    await p.removeLabel(12, 'orca:spec');
    expect(calls[0].args).toEqual(['api', '-X', 'DELETE', 'repos/GotakoVN/orca/issues/12/labels/orca%3Aspec']);
  });

  it('rethrows a non-404 error when removing a label', async () => {
    const { port: p } = port([new Error('gh: HTTP 500')]);
    await expect(p.removeLabel(12, 'orca:spec')).rejects.toThrow('500');
  });

  it('flattens paginated comment pages', async () => {
    const page1 = [{ id: 1, user: { login: 'a' }, body: 'one' }];
    const page2 = [{ id: 2, user: { login: 'b' }, body: 'two' }];
    const { port: p, calls } = port([JSON.stringify([page1, page2])]);
    expect(await p.listComments(12)).toEqual([
      { id: 1, author: 'a', body: 'one' },
      { id: 2, author: 'b', body: 'two' },
    ]);
    expect(calls[0].args).toEqual(['api', '--paginate', '--slurp', 'repos/GotakoVN/orca/issues/12/comments']);
  });

  it('creates a comment through stdin so special characters survive', async () => {
    const { port: p, calls } = port([JSON.stringify({ id: 9, user: { login: 'bot' }, body: 'x' })]);
    const c = await p.createComment(12, 'a "quoted"\nline `code`');
    expect(c).toEqual({ id: 9, author: 'bot', body: 'x' });
    expect(JSON.parse(calls[0].input!)).toEqual({ body: 'a "quoted"\nline `code`' });
  });

  it('updates a comment by id', async () => {
    const { port: p, calls } = port(['{}']);
    await p.updateComment(77, 'new');
    expect(calls[0].args).toEqual(['api', '-X', 'PATCH', 'repos/GotakoVN/orca/issues/comments/77', '--input', '-']);
    expect(JSON.parse(calls[0].input!)).toEqual({ body: 'new' });
  });

  it('reads a default-branch file raw and returns null on 404', async () => {
    const { port: p, calls } = port(['reviewers: []\n', new Error('gh: Not Found (HTTP 404)')]);
    expect(await p.readDefaultBranchFile('openspec/actors.yaml')).toBe('reviewers: []\n');
    expect(calls[0].args).toEqual([
      'api', '-H', 'Accept: application/vnd.github.raw+json', 'repos/GotakoVN/orca/contents/openspec/actors.yaml',
    ]);
    expect(await p.readDefaultBranchFile('missing.yaml')).toBeNull();
  });

  it('rejects a path that tries to leave the repo', async () => {
    const { port: p } = port([]);
    await expect(p.readDefaultBranchFile('../secrets')).rejects.toThrow(/invalid path/);
  });

  it('rejects a malformed repo name and a non-integer issue number', async () => {
    expect(() => new GhCliPort('not a repo', async () => '')).toThrow(/invalid repo/);
    const { port: p } = port([]);
    await expect(p.getIssue(1.5)).rejects.toThrow(/invalid issue number/);
  });
});

describe('GhCliPort creation helpers', () => {
  it('createIssue posts title, body and labels and returns the number', async () => {
    const { port: p, calls } = port([JSON.stringify({ number: 41 })]);
    expect(await p.createIssue({ title: 'T', body: 'B', labels: ['bug'] })).toEqual({ number: 41 });
    expect(calls[0].args).toEqual(['api', '-X', 'POST', 'repos/GotakoVN/orca/issues', '--input', '-']);
    expect(JSON.parse(calls[0].input!)).toEqual({ title: 'T', body: 'B', labels: ['bug'] });
  });

  it('ensureLabel posts the label and ignores "already exists"', async () => {
    const { port: p, calls } = port(['{}', new Error('gh api failed (exit 1): 422 Validation Failed already_exists')]);
    await p.ensureLabel('orca:spec', 'ededed', 'desc');
    await p.ensureLabel('orca:spec', 'ededed', 'desc');
    expect(calls[0].args).toEqual(['api', '-X', 'POST', 'repos/GotakoVN/orca/labels', '--input', '-']);
    expect(JSON.parse(calls[0].input!)).toEqual({ name: 'orca:spec', color: 'ededed', description: 'desc' });
  });

  it('ensureLabel rethrows other errors', async () => {
    const { port: p } = port([new Error('gh api failed (exit 1): 500 boom')]);
    await expect(p.ensureLabel('x', 'ededed', 'd')).rejects.toThrow(/500/);
  });
});

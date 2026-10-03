import { describe, it, expect, beforeEach } from 'vitest';
import { FakeGitHub } from '../helpers/fake-github.js';
import {
  ensureApproveButton, handleApprovalEvent, APPROVE_MARKER, APPROVED_LABEL, ACTORS_PATH,
} from '../../src/issue/approve-flow.js';
import { sc } from '../helpers/sc.js';

const ENH_BODY = ['Problem', 'Desired outcome', 'Non-goals', 'Constraints', 'Success criteria']
  .map(h => `## ${h}\n\ntext\n`).join('\n');

const ACTORS = `reviewers:
  - login: alice
    kind: human
  - login: owner
    kind: human
  - login: agent-a
    kind: agent
  - login: agent-b
    kind: agent
`;

const UNCHECKED = `${APPROVE_MARKER}\n- [ ] Approve\n`;
const CHECKED = `${APPROVE_MARKER}\n- [x] Approve\n`;

let gh: FakeGitHub;

async function setup(author: string): Promise<number> {
  gh = new FakeGitHub();
  gh.addIssue({ number: 12, author, labels: ['enhancement'], body: ENH_BODY });
  gh.setDefaultBranchFile(ACTORS_PATH, ACTORS);
  await ensureApproveButton(gh, 12);
  const button = (await gh.listComments(12)).find(c => c.body.includes(APPROVE_MARKER))!;
  return button.id;
}

async function tick(buttonId: number, sender: string): Promise<void> {
  gh.setCommentBody(buttonId, CHECKED);
  await handleApprovalEvent(gh, {
    kind: 'comment-edited', issueNo: 12, commentId: buttonId, sender, body: CHECKED, previousBody: UNCHECKED,
  });
}

const labels = async () => (await gh.getIssue(12)).labels;
const bodies = async () => (await gh.listComments(12)).map(c => c.body);

const A = 'Reviewer Role Authority';
const F = 'Four-Eyes Rule';
const B = 'Approval Button Created By The Workflow';
const R = 'Approval Record';

describe('approve button', () => {
  it(`${sc(B, 'Button on a conforming issue')}`, async () => {
    await setup('carol');
    const buttons = (await bodies()).filter(b => b.includes(APPROVE_MARKER));
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toContain('- [ ] Approve');
  });

  it(`${sc(B, 'No button on a non-conforming issue')}`, async () => {
    gh = new FakeGitHub();
    gh.addIssue({ number: 12, author: 'carol', labels: ['enhancement'], body: '## Problem\n\nonly this\n' });
    await ensureApproveButton(gh, 12);
    expect((await bodies()).filter(b => b.includes(APPROVE_MARKER))).toHaveLength(0);
  });

  it('is idempotent: a second call does not add a second button', async () => {
    await setup('carol');
    await ensureApproveButton(gh, 12);
    expect((await bodies()).filter(b => b.includes(APPROVE_MARKER))).toHaveLength(1);
  });
});

describe('reviewer authority through the workflow', () => {
  it(`${sc(A, 'Approval by a reviewer')}`, async () => {
    const id = await setup('carol');
    await tick(id, 'alice');
    expect(await labels()).toContain(APPROVED_LABEL);
  });

  it(`${sc(A, 'Approval by a non-reviewer')}`, async () => {
    const id = await setup('carol');
    await tick(id, 'bob');
    expect(await labels()).not.toContain(APPROVED_LABEL);
    expect((await bodies()).some(b => b.includes('bob') && b.includes('does not hold the reviewer role'))).toBe(true);
  });

  it(`${sc(A, 'Approval claimed in comment text')}`, async () => {
    await setup('carol');
    await handleApprovalEvent(gh, { kind: 'comment-created', issueNo: 12, commentId: 99, sender: 'bob', body: 'approved' });
    await handleApprovalEvent(gh, { kind: 'comment-created', issueNo: 12, commentId: 100, sender: 'alice', body: '/approve' });
    expect(await labels()).not.toContain(APPROVED_LABEL);
  });

  it(`${sc(A, 'Agent holds the reviewer role')}`, async () => {
    const id = await setup('alice');
    await tick(id, 'agent-b');
    expect(await labels()).toContain(APPROVED_LABEL);
  });

  it('refuses everyone when openspec/actors.yaml is absent on the default branch', async () => {
    gh = new FakeGitHub();
    gh.addIssue({ number: 12, author: 'carol', labels: ['enhancement'], body: ENH_BODY });
    await ensureApproveButton(gh, 12);
    const id = (await gh.listComments(12))[0].id;
    await tick(id, 'alice');
    expect(await labels()).not.toContain(APPROVED_LABEL);
  });
});

describe('four-eyes through the workflow', () => {
  it(`${sc(F, 'Agent approves its own work')}`, async () => {
    const id = await setup('agent-a');
    await tick(id, 'agent-a');
    expect(await labels()).not.toContain(APPROVED_LABEL);
    expect((await bodies()).some(b => b.includes('an author cannot approve its own work'))).toBe(true);
  });

  it(`${sc(F, 'Different agent approves')}`, async () => {
    const id = await setup('agent-a');
    await tick(id, 'agent-b');
    expect(await labels()).toContain(APPROVED_LABEL);
  });

  it(`${sc(F, 'Human approves agent-authored work')}`, async () => {
    const id = await setup('agent-a');
    await tick(id, 'owner');
    expect(await labels()).toContain(APPROVED_LABEL);
  });
});

describe('approval record', () => {
  it(`${sc(R, 'Label and comment after approval')}`, async () => {
    const id = await setup('carol');
    await tick(id, 'alice');
    expect(await labels()).toContain(APPROVED_LABEL);
    expect((await bodies()).some(b => b.includes('alice') && /approved/i.test(b) && !b.includes(APPROVE_MARKER))).toBe(true);
  });

  it(`${sc(R, 'Reaction alone does not approve')}`, async () => {
    await setup('carol');
    const before = (await bodies()).length;
    await handleApprovalEvent(gh, { kind: 'reaction', issueNo: 12, sender: 'alice', content: '+1' });
    expect(await labels()).not.toContain(APPROVED_LABEL);
    expect((await bodies()).length).toBe(before);
  });

  it('resets the checkbox when an approval is refused', async () => {
    const id = await setup('carol');
    await tick(id, 'bob');
    const button = (await gh.listComments(12)).find(c => c.id === id)!;
    expect(button.body).toContain('- [ ] Approve');
  });

  it('records an approval once: re-delivering the same tick adds no second approval comment', async () => {
    const id = await setup('carol');
    await tick(id, 'alice');
    const n = (await bodies()).length;
    await tick(id, 'alice');
    expect((await bodies()).length).toBe(n);
  });

  it('ignores an edit of the button comment that does not tick the box', async () => {
    const id = await setup('carol');
    await handleApprovalEvent(gh, {
      kind: 'comment-edited', issueNo: 12, commentId: id, sender: 'alice', body: UNCHECKED + 'x', previousBody: UNCHECKED,
    });
    expect(await labels()).not.toContain(APPROVED_LABEL);
  });

  it('ignores a ticked lookalike button planted by a person when a bot login is given', async () => {
    await setup('carol');
    const fake = await gh.createComment(12, `${APPROVE_MARKER}\n${UNCHECKED}`);
    gh.setCommentAuthor(fake.id, 'mallory');
    gh.setCommentBody(fake.id, CHECKED);
    await handleApprovalEvent(gh, {
      kind: 'comment-edited', issueNo: 12, commentId: fake.id, sender: 'alice', body: CHECKED, previousBody: UNCHECKED,
    }, { botLogin: 'orca[bot]' });
    expect(await labels()).not.toContain(APPROVED_LABEL);
  });

  it('does not treat a planted lookalike as the existing button', async () => {
    gh = new FakeGitHub();
    gh.addIssue({ number: 12, author: 'carol', labels: ['enhancement'], body: ENH_BODY });
    const fake = await gh.createComment(12, `${APPROVE_MARKER}\n${UNCHECKED}`);
    gh.setCommentAuthor(fake.id, 'mallory');
    await ensureApproveButton(gh, 12, { botLogin: 'orca[bot]' });
    const buttons = (await gh.listComments(12)).filter(c => c.author === 'orca[bot]' && c.body.includes(APPROVE_MARKER));
    expect(buttons).toHaveLength(1);
  });
});

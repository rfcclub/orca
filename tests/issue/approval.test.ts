import { describe, it, expect } from 'vitest';
import { decideApproval, parseActors, kindOf } from '../../src/issue/approval.js';
import type { Actors } from '../../src/issue/types.js';
import { sc } from '../helpers/sc.js';

const actors: Actors = {
  reviewers: [
    { login: 'alice', kind: 'human' },
    { login: 'owner', kind: 'human' },
    { login: 'agent-a', kind: 'agent' },
    { login: 'agent-b', kind: 'agent' },
  ],
  agents: ['agent-writer'],
};

const A = 'Reviewer Role Authority';
const F = 'Four-Eyes Rule';

describe('decideApproval', () => {
  it(`${sc(A, 'Approval by a reviewer')} (decision)`, () => {
    expect(decideApproval({ approver: 'alice', authors: ['carol'], actors })).toEqual({ ok: true });
  });

  it(`${sc(A, 'Approval by a non-reviewer')} (decision)`, () => {
    expect(decideApproval({ approver: 'bob', authors: ['carol'], actors }))
      .toEqual({ ok: false, reason: 'not-reviewer' });
  });

  it(`${sc(A, 'Agent holds the reviewer role')} (decision)`, () => {
    expect(decideApproval({ approver: 'agent-b', authors: ['alice'], actors })).toEqual({ ok: true });
  });

  it(`${sc(F, 'Agent approves its own work')} (decision)`, () => {
    expect(decideApproval({ approver: 'agent-a', authors: ['agent-a'], actors }))
      .toEqual({ ok: false, reason: 'self-approval' });
  });

  it(`${sc(F, 'Different agent approves')} (decision)`, () => {
    expect(decideApproval({ approver: 'agent-b', authors: ['agent-a'], actors })).toEqual({ ok: true });
  });

  it(`${sc(F, 'Human approves agent-authored work')} (decision)`, () => {
    expect(decideApproval({ approver: 'owner', authors: ['agent-a'], actors })).toEqual({ ok: true });
  });

  it('allows a human author to approve their own issue (design D3)', () => {
    expect(decideApproval({ approver: 'alice', authors: ['alice'], actors })).toEqual({ ok: true });
  });

  it('compares logins case-insensitively', () => {
    expect(decideApproval({ approver: 'Agent-A', authors: ['agent-a'], actors }))
      .toEqual({ ok: false, reason: 'self-approval' });
  });

  it('refuses everyone when there are no reviewers', () => {
    expect(decideApproval({ approver: 'alice', authors: [], actors: { reviewers: [], agents: [] } }))
      .toEqual({ ok: false, reason: 'not-reviewer' });
  });
});

describe('kindOf', () => {
  it('reads kind from reviewers, then the agents list, else human', () => {
    expect(kindOf('agent-a', actors)).toBe('agent');
    expect(kindOf('agent-writer', actors)).toBe('agent');
    expect(kindOf('alice', actors)).toBe('human');
    expect(kindOf('someone-unlisted', actors)).toBe('human');
  });
});

describe('parseActors', () => {
  it('parses reviewers and agents from yaml', () => {
    const a = parseActors(`reviewers:\n  - login: owner\n    kind: human\n  - login: bot-1\n    kind: agent\nagents:\n  - writer-1\n`);
    expect(a.reviewers).toEqual([{ login: 'owner', kind: 'human' }, { login: 'bot-1', kind: 'agent' }]);
    expect(a.agents).toEqual(['writer-1']);
  });

  it('defaults kind to human and agents to empty', () => {
    const a = parseActors(`reviewers:\n  - login: owner\n`);
    expect(a.reviewers).toEqual([{ login: 'owner', kind: 'human' }]);
    expect(a.agents).toEqual([]);
  });

  it('rejects a reviewer entry with an unknown kind', () => {
    expect(() => parseActors(`reviewers:\n  - login: x\n    kind: robot\n`)).toThrow(/kind/);
  });

  it('treats empty content as no actors', () => {
    expect(parseActors('')).toEqual({ reviewers: [], agents: [] });
  });
});

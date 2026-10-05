import { describe, it, expect, vi } from 'vitest';
import { authenticatedOutcomeReview, cmdCheckOutcomes } from '../../src/cli/commands/check-outcomes.ts';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import { stringify } from 'yaml';
import type { GitHubPort } from '../../src/issue/github.ts';
import type { Comment } from '../../src/issue/types.ts';

const digest = 'a'.repeat(64);
function port(comments: Comment[], roles: string | null): GitHubPort {
  return {
    async getIssue() { return { number: 13, author: 'agent', labels: ['orca:approved'], body: '# Intent' }; },
    async listComments() { return comments; },
    async readDefaultBranchFile() { return roles; },
    async addLabel() { throw new Error('read-only'); },
    async removeLabel() { throw new Error('read-only'); },
    async createComment() { throw new Error('read-only'); },
    async updateComment() { throw new Error('read-only'); },
    async createIssue() { throw new Error('read-only'); },
    async ensureLabel() { throw new Error('read-only'); },
  };
}
const roles = 'reviewers:\n  - login: owner\n    kind: human\n  - login: agent\n    kind: agent\nagents: [agent]\n';
const comment = (author: string, body: string): Comment => ({ id: 1, author, body });

describe('authenticated outcome review', () => {
  it('unauthenticated-review: only accepts a configured human and exact stage/digest', async () => {
    const review = await authenticatedOutcomeReview(port([
      comment('agent', `/accept-outcome code ${digest}`),
      comment('stranger', `/accept-outcome choice ${digest}`),
      comment('owner', `/accept-outcome choice ${digest}`),
    ], roles), 13, 'openspec');
    expect(await review('choice', digest)).toBe(true);
    expect(await review('code', digest)).toBe(false);
    expect(await review('choice', 'b'.repeat(64))).toBe(false);
  });

  it('unauthenticated-review: ignores quoted tokens and bot approval reports', async () => {
    const review = await authenticatedOutcomeReview(port([
      comment('owner', `> /accept-outcome choice ${digest}`),
      comment('bot', `Approved by @owner.\n/accept-outcome choice ${digest}`),
    ], roles), 13, 'openspec');
    expect(await review('choice', digest)).toBe(false);
  });

  it('unauthenticated-review: missing role data fails closed', async () => {
    const review = await authenticatedOutcomeReview(port([
      comment('owner', `/accept-outcome choice ${digest}`),
    ], null), 13, 'openspec');
    expect(await review('choice', digest)).toBe(false);
  });

  it('unauthenticated-review: revoking intent approval refuses all acceptance', async () => {
    const p = port([comment('owner', `/accept-outcome choice ${digest}`)], roles);
    p.getIssue = async () => ({ number: 13, author: 'agent', labels: [], body: '# Intent' });
    await expect(authenticatedOutcomeReview(p, 13, 'openspec')).rejects.toThrow(/approv/i);
  });

  it('invalid-contract: online checking refuses an edited canonical issue snapshot or planted criteria', async () => {
    const p = port([comment('owner', `/accept-outcome choice ${digest}`)], roles);
    p.getIssue = async () => ({
      number: 13, author: 'agent', labels: ['orca:approved'],
      body: '# Intent\n\n## Success criteria\n- canonical requirement\n',
    });
    await expect(authenticatedOutcomeReview(p, 13, 'openspec', '# edited snapshot')).rejects.toThrow(/snapshot/i);
    const planted = '## Success criteria\n- forged requirement\n\n' + (await p.getIssue(13)).body;
    await expect(authenticatedOutcomeReview(p, 13, 'openspec', planted)).rejects.toThrow(/criteria/i);
  });
});

describe('check-outcomes CLI', () => {
  it('unauthenticated-review: offline CLI writes a scoped report and exits nonzero', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-outcome-cli-'));
    const change = join(root, 'openspec/changes/demo');
    mkdirSync(join(change, '.harness'), { recursive: true });
    const intent = '# Intent\n## Success criteria\n- a\n## Intent Approval\nStatus: APPROVED\n';
    const hash = (s: string) => createHash('sha256').update(s).digest('hex');
    const scope = { environment: 'fixture', revision: 'r1', boundary: 'reader' };
    writeFileSync(join(change, 'intent.md'), intent);
    writeFileSync(join(change, '.harness/decision.md'), 'choose A');
    const contract = {
      version: 1, intent_sha256: hash(intent), stages: [{
        id: 'choice', outcome: 'decision', criteria: ['SC-1'], scope,
        evidence: [{ path: '.harness/decision.md', sha256: hash('choose A'), kind: 'decision', scope }],
        question: 'Which?', options: ['A', 'B'], choice: 'A', consequences: ['adapter'],
        obligations: [], revisit: 'new measurements',
      }],
    };
    writeFileSync(join(change, 'tasks.md'), `\`\`\`orca-outcomes\n${stringify(contract)}\`\`\`\n`);
    const cwd = process.cwd();
    const exit = process.exitCode;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      process.chdir(root);
      await cmdCheckOutcomes('demo');
      const report = JSON.parse(readFileSync(join(change, '.harness/outcome-report.json'), 'utf8'));
      expect(report.stages[0].state).toBe('review-required');
      expect(report.stages[0].scope).toEqual(scope);
      expect(report.complete).toBe(false);
      expect(process.exitCode).toBe(1);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('review-required'));
    } finally {
      process.chdir(cwd);
      process.exitCode = exit;
      log.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

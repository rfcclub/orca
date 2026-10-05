import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { parseActors } from '../../issue/approval.js';
import { APPROVED_LABEL } from '../../issue/approve-flow.js';
import { GhCliPort } from '../../issue/gh-cli.js';
import type { GitHubPort } from '../../issue/github.js';
import { parseIssueRef } from '../../issue/status.js';
import { checkOutcomes, type OutcomeReview } from '../../harness/outcomes.js';
import { extractLockedCriteria } from '../../harness/gate-plan.js';
import { getChangeDir } from '../utils.js';

/** Read-only authentication. Local roles, bot reports and agent attestations are not authority. */
export async function authenticatedOutcomeReview(port: GitHubPort, issue: number, workspace: string, intent?: string): Promise<OutcomeReview> {
  const [source, roles, comments] = await Promise.all([
    port.getIssue(issue), port.readDefaultBranchFile(`${workspace}/actors.yaml`), port.listComments(issue),
  ]);
  if (!source.labels.includes(APPROVED_LABEL)) throw new Error('Canonical intent approval has been revoked');
  if (intent !== undefined) {
    if (!intent.includes(source.body.trim())) throw new Error('Canonical issue snapshot changed or local intent was edited');
    const criteria = (s: string) => extractLockedCriteria(s, 'intent.md').map(c => ({ id: c.id, text: c.text }));
    if (JSON.stringify(criteria(intent)) !== JSON.stringify(criteria(source.body))) {
      throw new Error('Local criteria differ from the approved canonical issue');
    }
  }
  const humans = new Set((roles ? parseActors(roles).reviewers : [])
    .filter(r => r.kind === 'human').map(r => r.login.toLowerCase()));
  const accepted = new Set<string>();
  for (const comment of comments) {
    if (!humans.has(comment.author.toLowerCase())) continue;
    // Entire comment must be one explicit token; quoted/pasted surrounding prose cannot approve.
    const token = /^\/accept-outcome ([a-z0-9][a-z0-9-]*) ([a-f0-9]{64})$/.exec(comment.body.trim());
    if (token) accepted.add(`${token[1]}:${token[2]}`);
  }
  return async (stage, digest) => accepted.has(`${stage}:${digest}`);
}

export async function cmdCheckOutcomes(name: string, opts: { online?: boolean } = {}): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error('Invalid change name');
  const dir = getChangeDir(name);
  if (!existsSync(dir)) throw new Error(`Change "${name}" not found`);
  let review: OutcomeReview | undefined;
  if (opts.online) {
    const intent = readFileSync(join(dir, 'intent.md'), 'utf8');
    const ref = parseIssueRef(intent);
    if (!ref) throw new Error('Online outcome review requires the canonical Issue: owner/repo#N reference');
    review = await authenticatedOutcomeReview(new GhCliPort(ref.repo), ref.number, basename(dirname(dirname(dir))), intent);
  }
  const report = await checkOutcomes(dir, { review });
  if (report.mode === 'legacy') {
    console.log('No outcome contract; use the existing implementation workflow and executable test/gate evidence.');
    return;
  }
  mkdirSync(join(dir, '.harness'), { recursive: true });
  writeFileSync(join(dir, '.harness/outcome-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (!report.complete) process.exitCode = 1;
}

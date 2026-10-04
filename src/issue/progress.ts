import type { GitHubPort } from './github.js';
import type { OrcaPhase } from './phase.js';

export const PROGRESS_MARKER = '<!-- orca-progress -->';

export type PhaseTarget = OrcaPhase | 'blocked';

/** The only labels the workflow owns. `orca:approved` is the approval record, not a phase. */
export const PHASE_LABELS = [
  'orca:intent', 'orca:spec', 'orca:design', 'orca:plan', 'orca:tdd', 'orca:verified', 'orca:blocked',
];

/** Leaves exactly one phase label on the issue, removing any other (this also reverts hand edits). */
export async function syncPhaseLabel(port: GitHubPort, issueNo: number, target: PhaseTarget): Promise<void> {
  const want = `orca:${target}`;
  const issue = await port.getIssue(issueNo);
  for (const label of issue.labels) {
    if (PHASE_LABELS.includes(label) && label !== want) await port.removeLabel(issueNo, label);
  }
  if (!issue.labels.includes(want)) await port.addLabel(issueNo, want);
}

export interface ProgressScenario {
  id: string;
  passing: boolean;
  testUrl?: string;
}

export interface ProgressInput {
  phase: PhaseTarget;
  owner: string;
  blockedBy?: string[];
  scenarios: ProgressScenario[];
}

function issueLink(ref: string, owner: string): string {
  const m = ref.match(/^(?:(.+?)\/)?([^/#]+)#(\d+)$/);
  if (!m) return ref;
  const [, o, repo, n] = m;
  return `[${ref}](https://github.com/${o ?? owner}/${repo}/issues/${n})`;
}

export function renderProgress(input: ProgressInput): string {
  const { phase, owner, blockedBy = [], scenarios } = input;
  const passing = scenarios.filter(s => s.passing).length;
  const lines = [PROGRESS_MARKER, `**Phase:** ${phase}`];
  if (blockedBy.length > 0) {
    lines.push(`**Blocked by:** ${blockedBy.map(r => issueLink(r, owner)).join(', ')}`);
  }
  lines.push('', `### Scenarios (${passing}/${scenarios.length} passing)`, '');
  for (const s of scenarios) {
    const name = s.testUrl ? `[${s.id}](${s.testUrl})` : s.id;
    lines.push(`- [${s.passing ? 'x' : ' '}] ${name}`);
  }
  return lines.join('\n') + '\n';
}

/** Keeps exactly one progress comment: edit it in place, create it only when absent. */
export async function upsertProgress(
  port: GitHubPort,
  issueNo: number,
  body: string,
  opts: { botLogin?: string } = {},
): Promise<void> {
  const comments = await port.listComments(issueNo);
  const existing = comments.find(
    c => c.body.includes(PROGRESS_MARKER) && (!opts.botLogin || c.author === opts.botLogin),
  );
  if (!existing) {
    await port.createComment(issueNo, body);
    return;
  }
  if (existing.body !== body) await port.updateComment(existing.id, body);
}

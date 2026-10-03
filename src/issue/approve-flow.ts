import type { GitHubPort } from './github.js';
import { classifyIssue } from './classify.js';
import { decideApproval, parseActors } from './approval.js';
import type { Actors } from './types.js';

export const APPROVE_MARKER = '<!-- orca-approve -->';
export const APPROVED_LABEL = 'orca:approved';
export const ACTORS_PATH = 'openspec/actors.yaml';

const UNCHECKED = '- [ ] Approve';
const CHECKED = '- [x] Approve';

export type ApprovalEvent =
  | { kind: 'comment-created'; issueNo: number; commentId: number; sender: string; body: string }
  | { kind: 'comment-edited'; issueNo: number; commentId: number; sender: string; body: string; previousBody: string }
  | { kind: 'reaction'; issueNo: number; sender: string; content: string };

/**
 * Posts the approve "button" — a checkbox in a comment the workflow owns —
 * on a conforming issue. Non-conforming issues get none. Idempotent.
 */
export async function ensureApproveButton(
  port: GitHubPort,
  issueNo: number,
  opts: { botLogin?: string } = {},
): Promise<void> {
  const issue = await port.getIssue(issueNo);
  if (classifyIssue(issue).result !== 'conforming') return;
  const comments = await port.listComments(issueNo);
  if (comments.some(c => isButton(c, opts.botLogin))) return;
  await port.createComment(
    issueNo,
    `${APPROVE_MARKER}\n${UNCHECKED}\n\nA reviewer ticks the box above to approve this issue as the intent of record.`,
  );
}

/** The button is the workflow's own comment: a planted lookalike from a person does not count. */
function isButton(c: { body: string; author: string }, botLogin?: string): boolean {
  return c.body.includes(APPROVE_MARKER) && (!botLogin || c.author === botLogin);
}

async function loadActors(port: GitHubPort): Promise<Actors> {
  const text = await port.readDefaultBranchFile(ACTORS_PATH);
  return text === null ? { reviewers: [], agents: [] } : parseActors(text);
}

/**
 * Only one input approves: the button comment going from unticked to ticked.
 * Reactions and comment text are deliberately ignored (authority is role data).
 */
export async function handleApprovalEvent(
  port: GitHubPort,
  event: ApprovalEvent,
  opts: { botLogin?: string } = {},
): Promise<void> {
  if (event.kind !== 'comment-edited') return;
  if (!event.previousBody.includes(UNCHECKED) || !event.body.includes(CHECKED)) return;

  const comments = await port.listComments(event.issueNo);
  const button = comments.find(c => c.id === event.commentId && isButton(c, opts.botLogin));
  if (!button) return;

  const issue = await port.getIssue(event.issueNo);
  if (issue.labels.includes(APPROVED_LABEL)) return; // already recorded

  const decision = decideApproval({
    approver: event.sender,
    authors: [issue.author],
    actors: await loadActors(port),
  });

  if (decision.ok) {
    await port.addLabel(event.issueNo, APPROVED_LABEL);
    await port.createComment(event.issueNo, `Approved by @${event.sender}. This issue is now the approved intent of record.`);
    return;
  }

  const why = decision.reason === 'not-reviewer'
    ? `@${event.sender} does not hold the reviewer role in this project, so the approval was not recorded.`
    : `@${event.sender}: an author cannot approve its own work (four-eyes rule). A different reviewer must approve.`;
  await port.createComment(event.issueNo, why);
  await port.updateComment(button.id, button.body.replace(CHECKED, UNCHECKED));
}

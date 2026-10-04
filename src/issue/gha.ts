import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { ensureApproveButton, handleApprovalEvent } from './approve-flow.js';
import type { GitHubPort } from './github.js';
import { PHASE_LABELS, syncPhaseLabel } from './progress.js';
import { parseIssueRef } from './status.js';
import { syncChange } from './sync.js';

export interface GhaContext {
  /** `GITHUB_EVENT_NAME` */
  eventName: string;
  /** Parsed `GITHUB_EVENT_PATH` file. Issue text is only ever read from here, never put in a shell. */
  payload: Record<string, any>;
  /** `owner/repo` */
  repo: string;
  sha: string;
  /** Checkout root (where `openspec/changes` lives). */
  projectRoot: string;
  /** Login the workflow's token comments as; its own events and comments are never trusted as input. */
  botLogin: string;
}

/** The workflow's single entry point: one event in, idempotent GitHub writes out. */
export async function runGha(port: GitHubPort, ctx: GhaContext): Promise<void> {
  const { eventName, payload, botLogin } = ctx;
  if (payload.sender?.login === botLogin) return;

  if (eventName === 'issues' && ['opened', 'edited', 'reopened'].includes(payload.action)) {
    const issueNo: number = payload.issue.number;
    await ensureApproveButton(port, issueNo, { botLogin });
    const issue = await port.getIssue(issueNo);
    if (!issue.labels.some(l => PHASE_LABELS.includes(l))) await syncPhaseLabel(port, issueNo, 'intent');
    return;
  }

  if (eventName === 'issue_comment' && payload.action === 'edited') {
    await handleApprovalEvent(port, {
      kind: 'comment-edited',
      issueNo: payload.issue.number,
      commentId: payload.comment.id,
      sender: payload.sender.login,
      body: payload.comment.body ?? '',
      previousBody: payload.changes?.body?.from ?? '',
    }, { botLogin });
    return;
  }

  if (eventName === 'push') {
    const changesDir = join(ctx.projectRoot, 'openspec', 'changes');
    if (!existsSync(changesDir)) return;
    for (const name of readdirSync(changesDir)) {
      const changeDir = join(changesDir, name);
      const intentPath = join(changeDir, 'intent.md');
      if (!statSync(changeDir).isDirectory() || !existsSync(intentPath)) continue;
      const ref = parseIssueRef(readFileSync(intentPath, 'utf-8'));
      if (!ref || ref.repo !== ctx.repo) continue;
      await syncChange(port, { issueNo: ref.number, repo: ctx.repo, sha: ctx.sha, changeDir, botLogin });
    }
  }
}

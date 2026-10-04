import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { classifyIssue } from './classify.js';
import type { Issue } from './types.js';

export interface ProposedItem {
  section: string;
  text: string;
  acceptedBy?: string;
}

export interface CreateChangeInput {
  issue: Issue;
  /** `owner/repo`, recorded as `Issue: owner/repo#N`. */
  repo: string;
  approved: boolean;
  approvedBy?: string;
  changesDir: string;
  name: string;
  proposed?: ProposedItem[];
  now?: () => Date;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export function issueRef(repo: string, number: number): string {
  return `${repo}#${number}`;
}

/** Inserts (or replaces) the `Issue:` line directly under a spec's title. */
export function stampSpecIssue(specMd: string, ref: string): string {
  const lines = specMd.replace(/^Issue: .*\n(\n)?/m, '').split('\n');
  const titleIdx = lines.findIndex(l => /^#\s+/.test(l));
  if (titleIdx === -1) return `Issue: ${ref}\n\n${specMd}`;
  lines.splice(titleIdx + 1, 0, '', `Issue: ${ref}`);
  return lines.join('\n');
}

function renderIntent(input: CreateChangeInput): string {
  const { issue, repo, name, approvedBy } = input;
  const date = (input.now ? input.now() : new Date()).toISOString().slice(0, 10);
  const parts = [
    `# Intent: ${name}`,
    '',
    `Issue: ${issueRef(repo, issue.number)}`,
    '',
    `Generated from the approved issue. The issue is the intent of record; its edit history is on GitHub.`,
    '',
    issue.body.trim(),
    '',
  ];
  if (input.proposed?.length) {
    parts.push('## Proposed Additions', '');
    for (const p of input.proposed) {
      const tag = p.acceptedBy ? `orca-proposed accepted-by:${p.acceptedBy}` : 'orca-proposed';
      parts.push(`- [${tag}] ${p.section} | ${p.text}`);
    }
    parts.push('');
  }
  parts.push('## Intent Approval', '', 'Status: APPROVED', '');
  if (approvedBy) parts.push(`Approved by: ${approvedBy}`);
  parts.push(`Date: ${date}`, '');
  return parts.join('\n');
}

function renderBugTasks(input: CreateChangeInput): string {
  return [
    `# Tasks: ${input.name}`,
    '',
    `Issue: ${issueRef(input.repo, input.issue.number)}`,
    '',
    '- [ ] Write a failing regression test that reproduces the bug (this is the success criterion)',
    '- [ ] Fix the bug until the regression test passes',
    '- [ ] Run the full suite',
    '',
  ].join('\n');
}

/**
 * Creates the change folder from an approved, conforming issue. Writes nothing
 * unless every check passes. A bug gets intent.md + tasks.md only (no spec, no design).
 */
export function createChangeFromIssue(input: CreateChangeInput): { dir: string; files: string[] } {
  const { issue, approved, changesDir, name } = input;

  if (!NAME_RE.test(name)) throw new Error(`invalid change name "${name}" (use lowercase letters, digits and hyphens)`);
  if (!approved) throw new Error(`issue #${issue.number} is not approved`);
  const c = classifyIssue(issue);
  if (c.result !== 'conforming') throw new Error(`issue #${issue.number} is non-conforming: ${c.reason ?? 'unknown'}`);

  const dir = join(changesDir, name);
  if (existsSync(dir)) throw new Error(`change "${name}" already exists at ${dir}`);

  mkdirSync(dir, { recursive: true });
  const files = ['intent.md'];
  writeFileSync(join(dir, 'intent.md'), renderIntent(input), 'utf-8');
  if (c.shape === 'bug') {
    writeFileSync(join(dir, 'tasks.md'), renderBugTasks(input), 'utf-8');
    files.push('tasks.md');
  }
  return { dir, files };
}

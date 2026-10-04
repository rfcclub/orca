import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { classifyIssue, type Shape } from './classify.js';
import type { GitHubPort } from './github.js';

export interface CreateIssueInput {
  port: GitHubPort;
  repo: string;
  changesDir: string;
  name: string;
  /** `bug` or `enhancement`; anything else is rejected. */
  shape: string;
  title?: string;
  dryRun?: boolean;
  log?: (s: string) => void;
}

export interface CreateIssueResult {
  created: boolean;
  url?: string;
}

const SHAPES: Shape[] = ['bug', 'enhancement'];
/** Records the created issue inside the change folder so a change is never turned into two issues. */
export const ISSUE_MARKER = '.issue';

function titleOf(intent: string, name: string): string {
  const h = intent.match(/^#\s+(?:Intent:\s*)?(.+?)\s*$/m);
  return h?.[1] ?? name;
}

/**
 * Turns a change folder's intent.md into one issue. The body is the intent text as written (nothing is
 * filled in), the only label is the shape, and approval is never added: approval stays with a human.
 */
export async function createIssueFromChange(input: CreateIssueInput): Promise<CreateIssueResult> {
  const { port, repo, changesDir, name } = input;
  const log = input.log ?? (() => {});
  if (!SHAPES.includes(input.shape as Shape)) throw new Error(`invalid shape "${input.shape}" (expected bug or enhancement)`);

  const dir = join(changesDir, name);
  const intentPath = join(dir, 'intent.md');
  if (!existsSync(intentPath)) throw new Error(`no intent.md in ${dir}`);

  const markerPath = join(dir, ISSUE_MARKER);
  if (existsSync(markerPath)) {
    const url = readFileSync(markerPath, 'utf-8').trim();
    log(`${name} already has an issue: ${url}`);
    return { created: false, url };
  }

  const body = readFileSync(intentPath, 'utf-8');
  const title = input.title ?? titleOf(body, name);
  const labels = [input.shape];
  const c = classifyIssue({ labels, body });

  if (input.dryRun) {
    log(`dry run: would create in ${repo}\n  title: ${title}\n  labels: ${labels.join(', ')}\n  ${c.result}${c.missing.length ? ` (missing: ${c.missing.join(', ')})` : ''}`);
    return { created: false };
  }

  const { number } = await port.createIssue({ title, body, labels });
  const url = `https://github.com/${repo}/issues/${number}`;
  writeFileSync(markerPath, `${url}\n`, 'utf-8');
  log(`created ${url} (${c.result}${c.missing.length ? `; missing: ${c.missing.join(', ')}` : ''})`);
  return { created: true, url };
}

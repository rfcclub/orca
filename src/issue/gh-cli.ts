import { spawn } from 'child_process';
import type { GitHubPort } from './github.js';
import type { Comment, Issue } from './types.js';

/** Runs `gh <args>` and resolves with stdout; rejects with stderr in the message on a non-zero exit. */
export type GhExec = (args: string[], input?: string) => Promise<string>;

export const defaultGhExec: GhExec = (args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(out);
      else reject(new Error(`gh ${args[0]} failed (exit ${code}): ${err.trim() || out.trim()}`));
    });
    child.stdin.end(input ?? '');
  });

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function checkNumber(n: number): void {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid issue number: ${n}`);
}

const isNotFound = (e: unknown) => /404|Not Found/i.test(e instanceof Error ? e.message : String(e));

/** Real adapter: the `gh` CLI's existing login is the only credential (intent assumption). */
export class GhCliPort implements GitHubPort {
  constructor(private readonly repo: string, private readonly exec: GhExec = defaultGhExec) {
    if (!REPO_RE.test(repo)) throw new Error(`invalid repo "${repo}" (expected owner/name)`);
  }

  private api(path: string) {
    return `repos/${this.repo}/${path}`;
  }

  async getIssue(number: number): Promise<Issue> {
    checkNumber(number);
    const raw = JSON.parse(await this.exec(['api', this.api(`issues/${number}`)]));
    return {
      number: raw.number,
      author: raw.user?.login ?? '',
      labels: (raw.labels ?? []).map((l: { name: string }) => l.name),
      body: raw.body ?? '',
    };
  }

  async addLabel(number: number, label: string): Promise<void> {
    checkNumber(number);
    await this.exec(['api', '-X', 'POST', this.api(`issues/${number}/labels`), '--input', '-'], JSON.stringify({ labels: [label] }));
  }

  async removeLabel(number: number, label: string): Promise<void> {
    checkNumber(number);
    try {
      await this.exec(['api', '-X', 'DELETE', this.api(`issues/${number}/labels/${encodeURIComponent(label)}`)]);
    } catch (e) {
      if (!isNotFound(e)) throw e; // already gone is fine
    }
  }

  async listComments(number: number): Promise<Comment[]> {
    checkNumber(number);
    const pages: Array<Array<{ id: number; user?: { login: string }; body?: string }>> =
      JSON.parse(await this.exec(['api', '--paginate', '--slurp', this.api(`issues/${number}/comments`)]));
    return pages.flat().map(c => ({ id: c.id, author: c.user?.login ?? '', body: c.body ?? '' }));
  }

  async createComment(number: number, body: string): Promise<Comment> {
    checkNumber(number);
    const raw = JSON.parse(
      await this.exec(['api', '-X', 'POST', this.api(`issues/${number}/comments`), '--input', '-'], JSON.stringify({ body })),
    );
    return { id: raw.id, author: raw.user?.login ?? '', body: raw.body ?? '' };
  }

  async updateComment(commentId: number, body: string): Promise<void> {
    checkNumber(commentId);
    await this.exec(['api', '-X', 'PATCH', this.api(`issues/comments/${commentId}`), '--input', '-'], JSON.stringify({ body }));
  }

  async createIssue(input: { title: string; body: string; labels: string[] }): Promise<{ number: number }> {
    const raw = JSON.parse(await this.exec(['api', '-X', 'POST', this.api('issues'), '--input', '-'], JSON.stringify(input)));
    return { number: raw.number };
  }

  async ensureLabel(name: string, color: string, description: string): Promise<void> {
    try {
      await this.exec(['api', '-X', 'POST', this.api('labels'), '--input', '-'], JSON.stringify({ name, color, description }));
    } catch (e) {
      if (!/already_exists/i.test(e instanceof Error ? e.message : String(e))) throw e;
    }
  }

  async readDefaultBranchFile(path: string): Promise<string | null> {
    const segments = path.split('/');
    if (path.startsWith('/') || segments.some(s => s === '..' || s === '')) {
      throw new Error(`invalid path: ${path}`);
    }
    try {
      return await this.exec([
        'api', '-H', 'Accept: application/vnd.github.raw+json', this.api(`contents/${segments.map(encodeURIComponent).join('/')}`),
      ]);
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }
}

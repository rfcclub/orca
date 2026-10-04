import type { GitHubPort } from '../../src/issue/github.js';
import type { Comment, Issue } from '../../src/issue/types.js';

export class FakeGitHub implements GitHubPort {
  readonly calls: string[] = [];
  private issues = new Map<number, Issue>();
  private comments = new Map<number, Comment[]>();
  private files = new Map<string, string>();
  private nextCommentId = 1;
  private nextIssueNumber = 100;
  readonly labelsEnsured: string[] = [];
  readonly created: Array<{ number: number; title: string; body: string; labels: string[] }> = [];
  private failure: Error | null = null;

  addIssue(issue: Issue): void {
    this.issues.set(issue.number, { ...issue, labels: [...issue.labels] });
  }

  setDefaultBranchFile(path: string, content: string): void {
    this.files.set(path, content);
  }

  /** Make every later port call reject, to simulate being offline. */
  failAll(error: Error): void {
    this.failure = error;
  }

  /** Test helper: edit a comment as a person would, bypassing the port call log. */
  setCommentBody(commentId: number, body: string): void {
    for (const list of this.comments.values()) {
      const c = list.find(x => x.id === commentId);
      if (c) c.body = body;
    }
  }

  /** Test helper: make a comment look like it was written by someone else. */
  setCommentAuthor(commentId: number, author: string): void {
    for (const list of this.comments.values()) {
      const c = list.find(x => x.id === commentId);
      if (c) c.author = author;
    }
  }

  private enter(call: string): void {
    this.calls.push(call);
    if (this.failure) throw this.failure;
  }

  private issue(number: number): Issue {
    const issue = this.issues.get(number);
    if (!issue) throw new Error(`no issue #${number}`);
    return issue;
  }

  async getIssue(number: number): Promise<Issue> {
    this.enter(`getIssue:${number}`);
    const i = this.issue(number);
    return { ...i, labels: [...i.labels] };
  }

  async addLabel(number: number, label: string): Promise<void> {
    this.enter(`addLabel:${number}:${label}`);
    const i = this.issue(number);
    if (!i.labels.includes(label)) i.labels.push(label);
  }

  async removeLabel(number: number, label: string): Promise<void> {
    this.enter(`removeLabel:${number}:${label}`);
    const i = this.issue(number);
    i.labels = i.labels.filter(l => l !== label);
  }

  async listComments(number: number): Promise<Comment[]> {
    this.enter(`listComments:${number}`);
    return (this.comments.get(number) ?? []).map(c => ({ ...c }));
  }

  async createComment(number: number, body: string): Promise<Comment> {
    this.enter(`createComment:${number}`);
    const c: Comment = { id: this.nextCommentId++, author: 'orca[bot]', body };
    const list = this.comments.get(number) ?? [];
    list.push(c);
    this.comments.set(number, list);
    return { ...c };
  }

  async updateComment(commentId: number, body: string): Promise<void> {
    this.enter(`updateComment:${commentId}`);
    for (const list of this.comments.values()) {
      const c = list.find(x => x.id === commentId);
      if (c) { c.body = body; return; }
    }
    throw new Error(`no comment ${commentId}`);
  }

  async readDefaultBranchFile(path: string): Promise<string | null> {
    this.enter(`readDefaultBranchFile:${path}`);
    return this.files.get(path) ?? null;
  }

  async createIssue(input: { title: string; body: string; labels: string[] }): Promise<{ number: number }> {
    this.enter('createIssue');
    const number = this.nextIssueNumber++;
    this.created.push({ number, ...input, labels: [...input.labels] });
    this.issues.set(number, { number, author: 'orca[bot]', labels: [...input.labels], body: input.body });
    return { number };
  }

  async ensureLabel(name: string, _color: string, _description: string): Promise<void> {
    this.enter(`ensureLabel:${name}`);
    if (!this.labelsEnsured.includes(name)) this.labelsEnsured.push(name);
  }
}

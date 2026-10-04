import type { Comment, Issue } from './types.js';

/**
 * Every GitHub interaction orca makes goes through this interface so the
 * logic stays pure and testable; the real adapter is `GhCliPort`.
 */
export interface GitHubPort {
  getIssue(number: number): Promise<Issue>;
  addLabel(number: number, label: string): Promise<void>;
  removeLabel(number: number, label: string): Promise<void>;
  listComments(number: number): Promise<Comment[]>;
  createComment(number: number, body: string): Promise<Comment>;
  updateComment(commentId: number, body: string): Promise<void>;
  /** Content of a file on the default branch, or null when it does not exist. */
  readDefaultBranchFile(path: string): Promise<string | null>;
}

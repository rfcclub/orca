import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { relative, sep } from 'node:path';

/**
 * Size contract for the reviewed diff: the largest git stdout, in bytes, that gate-code will
 * collect, bind and review. It is passed to the child process as maxBuffer, so a larger diff is
 * refused with diff_collection_failed rather than truncated or replaced by another review
 * subject. Node's own default (1 MiB) is far below a legitimate large change.
 */
export const MAX_REVIEWED_DIFF_BYTES = 64 * 1024 * 1024;

/** Longest git stderr kept in a diagnosis, in characters. */
export const MAX_DIAGNOSTIC_CHARS = 2048;

export type DiffCollectionReason =
  | 'diff_too_large' // output exceeded the byte ceiling (ENOBUFS); nothing partial is used
  | 'git_unavailable' // git could not be started (for example not installed)
  | 'git_failed' // git exited non-zero or was killed by a signal
  | 'not_in_project'; // the change directory is not inside a git work tree

/**
 * Raised when the reviewed diff cannot be collected completely. Callers must not fall back to an
 * empty or partial diff: the verdict would be bound to a different subject than the code.
 * Raw status, signal, error code and (bounded, redacted) stderr stay separate fields.
 */
export class DiffCollectionError extends Error {
  readonly code = 'diff_collection_failed' as const;
  constructor(
    readonly reason: DiffCollectionReason,
    message: string,
    readonly details: {
      command: string;
      status: number | null;
      signal: string | null;
      errorCode: string | null;
      stderr: string;
      partialBytes: number;
      maxBytes: number;
    },
  ) {
    super(`diff_collection_failed (${reason}): ${message}`);
    this.name = 'DiffCollectionError';
  }
}

/** Bound a diagnostic and drop credentials embedded in URLs, so a receipt cannot leak them or grow without limit. */
export function boundDiagnostic(text: string): string {
  const redacted = text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[redacted]@');
  return redacted.length > MAX_DIAGNOSTIC_CHARS
    ? redacted.slice(0, MAX_DIAGNOSTIC_CHARS) + `... [truncated ${redacted.length - MAX_DIAGNOSTIC_CHARS} chars]`
    : redacted;
}

export interface CodeDiffOptions {
  /** Byte ceiling for git stdout; defaults to MAX_REVIEWED_DIFF_BYTES. */
  maxBytes?: number;
}

/**
 * Bind reviewed source and authored contracts without hashing the receipt that
 * stores the verdict itself. Exclusions are limited to this change's machine
 * state; another change's files and this change's intent/spec/plan stay bound.
 * Throws DiffCollectionError when the complete diff cannot be collected.
 */
export function reviewedCodeDiff(changeDir: string, opts: CodeDiffOptions = {}): string {
  return reviewedGitDiff(changeDir, [], opts);
}

/** The paths in reviewedCodeDiff, NUL-delimited so Git never quotes them. */
export function reviewedCodeFiles(changeDir: string, opts: CodeDiffOptions = {}): string[] {
  return reviewedGitDiff(changeDir, ['--name-only', '-z'], opts).split('\0').filter(Boolean);
}

function runGit(args: string[], cwd: string, maxBytes: number): string {
  const command = 'git ' + args.slice(0, 2).join(' ');
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: maxBytes, stdio: ['ignore', 'pipe', 'pipe'] });
  const errorCode = res.error ? ((res.error as NodeJS.ErrnoException).code ?? res.error.name) : null;
  const details = {
    command,
    status: res.status,
    signal: res.signal,
    errorCode,
    stderr: boundDiagnostic(res.stderr ?? ''),
    partialBytes: Buffer.byteLength(res.stdout ?? ''),
    maxBytes,
  };
  if (errorCode === 'ENOBUFS') {
    throw new DiffCollectionError('diff_too_large',
      `${command} output exceeds the ${maxBytes}-byte reviewed diff ceiling; nothing was reviewed or bound`, details);
  }
  if (errorCode) {
    throw new DiffCollectionError('git_unavailable', `${command} could not run (${errorCode})`, details);
  }
  if (res.status !== 0) {
    const how = res.status === null ? `killed by ${res.signal ?? 'unknown signal'}` : `exited ${res.status}`;
    throw new DiffCollectionError('git_failed', `${command} ${how}${details.stderr ? ': ' + details.stderr.trim() : ''}`, details);
  }
  return res.stdout;
}

function reviewedGitDiff(changeDir: string, options: string[], opts: CodeDiffOptions): string {
  const maxBytes = opts.maxBytes ?? MAX_REVIEWED_DIFF_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('maxBytes must be a positive integer');
  const root = runGit(['rev-parse', '--show-toplevel'], changeDir, maxBytes).trim();
  const prefix = relative(realpathSync(root), realpathSync(changeDir)).split(sep).join('/');
  if (!prefix || prefix.startsWith('../')) {
    throw new DiffCollectionError('not_in_project', 'Change directory must be inside the project',
      { command: 'git rev-parse', status: 0, signal: null, errorCode: null, stderr: '', partialBytes: 0, maxBytes });
  }
  const excluded = ['phase.json', '.harness', '.orca-verify.json'].map(path =>
    `:(top,exclude,literal)${prefix}/${path}`);
  return runGit(['diff', 'HEAD', ...options, '--', '.', ...excluded], root, maxBytes);
}

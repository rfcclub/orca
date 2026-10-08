import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { relative, sep } from 'node:path';

/**
 * Bind reviewed source and authored contracts without hashing the receipt that
 * stores the verdict itself. Exclusions are limited to this change's machine
 * state; another change's files and this change's intent/spec/plan stay bound.
 */
export function reviewedCodeDiff(changeDir: string): string {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: changeDir, encoding: 'utf8' }).trim();
  const prefix = relative(realpathSync(root), realpathSync(changeDir)).split(sep).join('/');
  if (!prefix || prefix.startsWith('../')) throw new Error('Change directory must be inside the project');
  const excluded = ['phase.json', '.harness', '.orca-verify.json'].map(path =>
    `:(top,exclude,literal)${prefix}/${path}`);
  return execFileSync('git', ['diff', 'HEAD', '--', '.', ...excluded],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

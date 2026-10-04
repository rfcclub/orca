import { readFileSync } from 'fs';
import { runGha } from '../../issue/gha.js';
import { GhCliPort } from '../../issue/gh-cli.js';

/** `GITHUB_TOKEN` comments as this login. */
const BOT_LOGIN = 'github-actions[bot]';

/**
 * Entry point for the GitHub Action. All input comes from the event payload file and
 * environment variables; issue text is never interpolated into a shell command.
 */
export async function cmdGha(action: string | undefined): Promise<void> {
  if (action !== 'run') throw new Error('Usage: loomkit gha run');
  const need = (k: string) => {
    const v = process.env[k];
    if (!v) throw new Error(`${k} is not set; this command runs inside GitHub Actions`);
    return v;
  };
  const repo = need('GITHUB_REPOSITORY');
  const payload = JSON.parse(readFileSync(need('GITHUB_EVENT_PATH'), 'utf-8'));
  await runGha(new GhCliPort(repo), {
    eventName: need('GITHUB_EVENT_NAME'),
    payload,
    repo,
    sha: process.env.GITHUB_SHA ?? 'HEAD',
    projectRoot: process.env.GITHUB_WORKSPACE ?? process.cwd(),
    botLogin: BOT_LOGIN,
  });
}

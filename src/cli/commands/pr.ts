import { authFromEnv, getInstallationToken } from '../../pr/auth.js';
import { createPr } from '../../pr/create.js';

export interface PrDeps {
  log?: (s: string) => void;
}

const USAGE = [
  'Usage: orca pr create --repo owner/name --head branch --title <t> [--body <b>] [--base <branch>] [--issue <n>]',
  '       orca pr token [--repo owner/name]   Print a short-lived installation token (for gh/GIT_AUTH)',
].join('\n');

export async function cmdPr(args: string[], deps: PrDeps = {}): Promise<void> {
  const log = deps.log ?? console.log;
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const sub = args[0];

  if (sub === 'token') {
    const t = await getInstallationToken(authFromEnv(), flag('--repo'));
    log(t.token);
    return;
  }

  if (sub !== 'create') throw new Error(USAGE);
  const repo = flag('--repo');
  const head = flag('--head');
  const title = flag('--title');
  if (!repo || !head || !title) throw new Error(USAGE);
  const issue = flag('--issue');
  const pr = await createPr({
    repo,
    head,
    title,
    body: flag('--body'),
    base: flag('--base'),
    issue: issue ? Number(issue) : undefined,
  });
  log(`created ${pr.url} (#${pr.number})`);
}

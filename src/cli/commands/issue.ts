import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { APPROVED_LABEL } from '../../issue/approve-flow.js';
import { classifyIssue } from '../../issue/classify.js';
import { draftMissing, localProvider, type DraftConfig } from '../../issue/draft.js';
import { createIssueFromChange } from '../../issue/create.js';
import { createChangeFromIssue } from '../../issue/folder.js';
import { initRepo } from '../../issue/init.js';
import { defaultGhExec, GhCliPort } from '../../issue/gh-cli.js';
import type { GitHubPort } from '../../issue/github.js';
import { loadConfig } from '../../config/loader.js';
import { getChangesDir, getWorkspaceDir } from '../utils.js';

export interface IssueDeps {
  port?: GitHubPort;
  repo?: string;
  changesDir?: string;
  log?: (s: string) => void;
  config?: DraftConfig;
  projectRoot?: string;
}

const USAGE = [
  'Usage: orca issue <classify|draft|open> <number> [--repo owner/name] [--name <change>] [--post]',
  '       orca issue create --from-change <name> --shape <bug|enhancement> [--title <t>] [--dry-run] [--repo owner/name]',
  '       orca issue init --reviewer <login> [--reviewer <login>] [--agent <login>] [--force] [--repo owner/name]',
].join('\n');

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function flagAll(args: string[], name: string): string[] {
  return args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));
}

async function detectRepo(): Promise<string> {
  return (await defaultGhExec(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'])).trim();
}

export async function cmdIssue(args: string[], deps: IssueDeps = {}): Promise<void> {
  const [sub, rawNumber] = args;
  if (sub === 'create' || sub === 'init') return cmdIssueSetup(sub, args, deps);
  if (!['classify', 'draft', 'open'].includes(sub ?? '')) throw new Error(USAGE);
  const number = Number(rawNumber);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`invalid issue number: ${rawNumber ?? '(missing)'}\n${USAGE}`);

  const log = deps.log ?? console.log;
  const repo = deps.repo ?? flag(args, '--repo') ?? await detectRepo();
  const port = deps.port ?? new GhCliPort(repo);
  const issue = await port.getIssue(number);

  if (sub === 'classify') {
    const c = classifyIssue(issue);
    log(`#${number}: ${c.result}${c.shape ? ` (${c.shape})` : ''}`);
    if (c.missing.length) log(`missing: ${c.missing.join(', ')}`);
    if (c.reason && !c.missing.length) log(c.reason);
    return;
  }

  if (sub === 'draft') {
    const config = deps.config ?? configFromDisk();
    const comment = await draftMissing({ issue, providers: { local: localProvider }, config });
    if (comment === null) { log(`#${number} is already conforming; nothing to draft.`); return; }
    log(comment);
    if (args.includes('--post')) {
      await port.createComment(number, comment);
      log(`posted the draft to ${repo}#${number}`);
    }
    return;
  }

  // open
  const name = flag(args, '--name');
  if (!name) throw new Error(`--name <change> is required\n${USAGE}`);
  const comments = await port.listComments(number);
  const approvedBy = comments
    .map(c => c.body.match(/^Approved by @(\S+?)\./)?.[1])
    .filter((x): x is string => !!x)
    .pop();
  const result = createChangeFromIssue({
    issue, repo, name,
    approved: issue.labels.includes(APPROVED_LABEL),
    approvedBy,
    changesDir: deps.changesDir ?? getChangesDir(),
  });
  log(`✓ created ${result.dir}`);
  for (const f of result.files) log(`  └── ${f}`);
}

function configFromDisk(): DraftConfig {
  const path = join(getWorkspaceDir(), 'config.yaml');
  const cfg = loadConfig(existsSync(path) ? readFileSync(path, 'utf-8') : null);
  return { provider: cfg.drafting?.provider };
}

async function cmdIssueSetup(sub: 'create' | 'init', args: string[], deps: IssueDeps): Promise<void> {
  const log = deps.log ?? console.log;
  const dryRun = sub === 'create' && args.includes('--dry-run');
  const repo = deps.repo ?? flag(args, '--repo') ?? await detectRepo();
  // a dry run must not touch GitHub, so it gets a port only when none was injected and a real call is needed
  const port = deps.port ?? new GhCliPort(repo);

  if (sub === 'create') {
    const name = flag(args, '--from-change');
    const shape = flag(args, '--shape');
    if (!name || !shape) throw new Error(`--from-change and --shape are required\n${USAGE}`);
    await createIssueFromChange({
      port, repo, name, shape, title: flag(args, '--title'), dryRun, log,
      changesDir: deps.changesDir ?? getChangesDir(),
    });
    return;
  }

  await initRepo({
    port, log, force: args.includes('--force'),
    projectRoot: deps.projectRoot ?? process.cwd(),
    reviewers: flagAll(args, '--reviewer'),
    agents: flagAll(args, '--agent'),
  });
}

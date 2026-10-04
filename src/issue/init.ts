import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { APPROVED_LABEL } from './approve-flow.js';
import type { GitHubPort } from './github.js';

/** Same content as this repo's own `.github/workflows/orca-issue.yml` (a test keeps them equal). */
export const WORKFLOW_TEMPLATE = `name: Orca Issue

# The only writer of orca:* phase labels and of the single progress comment.
# issues / issue_comment events run the workflow file from the default branch, never
# code from a PR. Issue text is read from the event payload file by the CLI and is
# never interpolated into a shell command (no \`\${{ github.event.* }}\` inside \`run:\`).
on:
  issues:
    types: [opened, edited, reopened]
  issue_comment:
    types: [edited]
  push:
    paths:
      - 'openspec/changes/**'

permissions:
  contents: read
  issues: write

concurrency:
  group: orca-issue-\${{ github.event.issue.number || github.ref }}
  cancel-in-progress: false

jobs:
  orca:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: corepack enable pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: node dist/cli/index.js gha run
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`;

const PHASES = ['intent', 'spec', 'design', 'plan', 'tdd', 'verified', 'blocked'];

export interface InitInput {
  port: GitHubPort;
  projectRoot: string;
  /** Logins of human reviewers; at least one is required. */
  reviewers: string[];
  /** Agent logins that author work but hold no reviewer role. */
  agents: string[];
  force?: boolean;
  log?: (s: string) => void;
}

function renderActors(reviewers: string[], agents: string[]): string {
  const r = reviewers.map(l => `  - login: ${l}\n    kind: human`).join('\n');
  const a = agents.length ? agents.map(l => `  - ${l}`).join('\n') : '';
  return [
    '# Who holds the reviewer role in this project. Read from the DEFAULT branch by the',
    '# orca workflow, so changing it needs a reviewed PR. Empty = nobody can approve.',
    'reviewers:',
    r,
    '# Agent accounts that author work but hold no reviewer role:',
    a ? `agents:\n${a}` : 'agents: []',
    '',
  ].join('\n');
}

function writeIfAllowed(path: string, content: string, force: boolean | undefined, written: string[], kept: string[]): void {
  if (existsSync(path) && !force) { kept.push(path); return; }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');
  written.push(path);
}

/** Makes a repo ready to receive orca issues. Idempotent; existing files are kept unless `force`. */
export async function initRepo(input: InitInput): Promise<{ labels: string[]; written: string[]; kept: string[] }> {
  const { port, projectRoot } = input;
  const log = input.log ?? (() => {});
  if (input.reviewers.length === 0) throw new Error('at least one human reviewer is required (--reviewer <login>)');

  const labels = [...PHASES.map(p => `orca:${p}`), APPROVED_LABEL];
  for (const l of labels) await port.ensureLabel(l, 'ededed', 'managed by orca');

  const written: string[] = [];
  const kept: string[] = [];
  writeIfAllowed(join(projectRoot, '.github', 'workflows', 'orca-issue.yml'), WORKFLOW_TEMPLATE, input.force, written, kept);
  writeIfAllowed(join(projectRoot, 'openspec', 'actors.yaml'), renderActors(input.reviewers, input.agents), input.force, written, kept);
  for (const w of written) log(`wrote ${w}`);
  for (const k of kept) log(`kept ${k} (use --force to overwrite)`);
  return { labels, written, kept };
}

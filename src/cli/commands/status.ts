import { join } from 'path';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { getLoomKitDir, listChanges } from '../utils.js';
import type { GitHubPort } from '../../issue/github.js';
import { GhCliPort } from '../../issue/gh-cli.js';
import { localPhase } from '../../issue/phase.js';
import { fetchRemote, parseIssueRef, resolveStatus } from '../../issue/status.js';

export interface StatusOptions {
  /** Builds the GitHub port for a repo; injected by tests. */
  portFor?: (repo: string) => GitHubPort;
  timeoutMs?: number;
}

export async function cmdStatus(opts: StatusOptions = {}): Promise<void> {
  const portFor = opts.portFor ?? ((repo: string) => new GhCliPort(repo));
  const loomkitDir = getLoomKitDir();
  const changes = listChanges();
  const specsDir = join(loomkitDir, 'specs');
  const archiveDir = join(loomkitDir, 'archive');

  console.log('LoomKit Status');
  console.log('━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Location: ${loomkitDir}`);

  // Living specs
  const specCount = countFiles(specsDir, 'spec.md');
  console.log(`\n📋 Living specs: ${specCount}`);

  // Active changes
  console.log(`\n🔄 Active changes: ${changes.length}`);
  for (const change of changes) {
    const changeDir = join(loomkitDir, 'changes', change);
    const verifyPath = join(changeDir, '.loomkit-verify.json');

    let status = 'draft';
    if (existsSync(verifyPath)) {
      const result = JSON.parse(readFileSync(verifyPath, 'utf-8'));
      status = result.passed ? '✅ verified' : `❌ ${(result.coverage * 100).toFixed(0)}%`;
    }

    const hasProposal = existsSync(join(changeDir, 'proposal.md'));
    const hasDesign = existsSync(join(changeDir, 'design.md'));
    const hasTasks = existsSync(join(changeDir, 'tasks.md'));

    console.log(`  ${change} [${status}]`);
    console.log(`    ${hasProposal ? '✓' : '○'} proposal   ${hasDesign ? '✓' : '○'} design   ${hasTasks ? '✓' : '○'} plan`);

    // Only changes that record a GitHub issue get a GitHub-aware phase line.
    const intentPath = join(changeDir, 'intent.md');
    const ref = existsSync(intentPath) ? parseIssueRef(readFileSync(intentPath, 'utf-8')) : null;
    if (ref) {
      const remote = await fetchRemote(portFor, ref, opts.timeoutMs);
      for (const line of resolveStatus(localPhase(changeDir), remote).lines) {
        console.log(`    ${line}`);
      }
    }
  }

  // Archive
  if (existsSync(archiveDir)) {
    const archives = readdirSync(archiveDir).filter(d => statSync(join(archiveDir, d)).isDirectory());
    console.log(`\n📦 Archived: ${archives.length}`);
    for (const archive of archives.slice(-5)) {
      console.log(`  ${archive}`);
    }
    if (archives.length > 5) console.log(`  ... and ${archives.length - 5} more`);
  }
}

function countFiles(dir: string, filename: string): number {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      count += countFiles(full, filename);
    } else if (entry.name === filename) {
      count++;
    }
  }
  return count;
}

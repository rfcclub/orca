import type { GitHubPort } from './github.js';
import { PHASE_LABELS } from './progress.js';

export type Remote =
  | { state: 'ok'; phase: string }
  | { state: 'unavailable' }
  | { state: 'none' };

export interface ResolvedStatus {
  lines: string[];
  disagree: boolean;
}

/** Never picks a source silently: when GitHub and local files differ, both are shown. */
export function resolveStatus(local: string, remote: Remote): ResolvedStatus {
  if (remote.state === 'none') {
    return { lines: [`phase: ${local} (source: local)`], disagree: false };
  }
  if (remote.state === 'unavailable') {
    return {
      lines: [`phase: ${local} (source: local)`, 'GitHub state unavailable — showing local files only'],
      disagree: false,
    };
  }
  if (remote.phase === local) {
    return { lines: [`phase: ${local} (source: github, local files agree)`], disagree: false };
  }
  return {
    lines: [
      `phase: github: ${remote.phase} | local: ${local}`,
      'sources disagree — the workflow writes the GitHub label, the CLI reads local files; one of them is stale',
    ],
    disagree: true,
  };
}

/** The phase named by the issue's single orca phase label, or null when there is none yet. */
export function remotePhase(labels: string[]): string | null {
  const label = labels.find(l => PHASE_LABELS.includes(l));
  return label ? label.slice('orca:'.length) : null;
}

/** Reads the `Issue: owner/repo#N` line recorded in a generated intent.md. */
export function parseIssueRef(intentMd: string): { repo: string; number: number } | null {
  const m = intentMd.match(/^Issue:\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)\s*$/m);
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}

/** Asks GitHub for the phase; any error or timeout is `unavailable`, never a throw. */
export async function fetchRemote(
  portFor: (repo: string) => GitHubPort,
  ref: { repo: string; number: number },
  timeoutMs = 3000,
): Promise<Remote> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const port = portFor(ref.repo);
    const issue = await Promise.race([
      port.getIssue(ref.number),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); }),
    ]);
    const phase = remotePhase(issue.labels);
    return phase ? { state: 'ok', phase } : { state: 'none' };
  } catch {
    return { state: 'unavailable' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

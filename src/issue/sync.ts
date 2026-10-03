import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { findChangeSpecFiles } from '../cli/utils.js';
import { parseSpec } from '../spec/parser.js';
import type { GitHubPort } from './github.js';
import { localPhase } from './phase.js';
import { renderProgress, syncPhaseLabel, upsertProgress, type ProgressScenario } from './progress.js';

/** `Blocked by: other-repo#3, acme/lib#9` in intent.md. */
export function parseBlockedBy(intentMd: string): string[] {
  const m = intentMd.match(/^Blocked by:[ \t]*(.*)$/m);
  if (!m) return [];
  return m[1].split(',').map(s => s.trim()).filter(Boolean);
}

function readTraceability(changeDir: string): Map<string, { passing: boolean; test?: string }> {
  const out = new Map<string, { passing: boolean; test?: string }>();
  const path = join(changeDir, '.traceability.yaml');
  if (!existsSync(path)) return out;
  try {
    const data: any = parseYaml(readFileSync(path, 'utf-8'));
    for (const e of Array.isArray(data?.scenarios) ? data.scenarios : []) {
      if (typeof e?.scenario === 'string') {
        out.set(e.scenario, { passing: e.status === 'passing', test: typeof e.test === 'string' ? e.test : undefined });
      }
    }
  } catch {
    // an unreadable traceability file means "no evidence yet", not a crash
  }
  return out;
}

/**
 * The workflow's whole job for one change: set the single phase label and keep
 * the single progress comment current. Only SHALL/MUST scenarios are mandatory.
 */
export async function syncChange(
  port: GitHubPort,
  input: { issueNo: number; repo: string; sha: string; changeDir: string; botLogin?: string },
): Promise<void> {
  const { issueNo, repo, sha, changeDir } = input;
  const intentPath = join(changeDir, 'intent.md');
  const blockedBy = existsSync(intentPath) ? parseBlockedBy(readFileSync(intentPath, 'utf-8')) : [];
  const trace = readTraceability(changeDir);

  const scenarios: ProgressScenario[] = [];
  for (const file of findChangeSpecFiles(changeDir, '')) {
    for (const req of parseSpec(readFileSync(file, 'utf-8')).requirements) {
      if (req.strength !== 'SHALL' && req.strength !== 'MUST') continue;
      for (const sc of req.scenarios) {
        const t = trace.get(sc.id);
        scenarios.push({
          id: sc.id,
          passing: t?.passing ?? false,
          testUrl: t?.test ? `https://github.com/${repo}/blob/${sha}/${t.test}` : undefined,
        });
      }
    }
  }

  const phase = localPhase(changeDir);
  const target = blockedBy.length > 0 ? 'blocked' : phase;
  await syncPhaseLabel(port, issueNo, target);
  await upsertProgress(
    port,
    issueNo,
    renderProgress({ phase: target, owner: repo.split('/')[0], blockedBy, scenarios }),
    { botLogin: input.botLogin },
  );
}

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { findChangeSpecFiles } from '../cli/utils.js';

export type OrcaPhase = 'intent' | 'spec' | 'design' | 'plan' | 'tdd' | 'verified';

function readJson(path: string): any | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * The change's phase as the local files show it (design D7). The furthest artifact wins;
 * unreadable plan/gate files are treated as absent so status never throws.
 */
export function localPhase(changeDir: string): OrcaPhase {
  const gate = readJson(join(changeDir, '.loomkit-verify.json'));
  if (gate?.passed === true) return 'verified';

  const plan = readJson(join(changeDir, 'plan.json'));
  if (Array.isArray(plan?.tasks) && plan.tasks.some((t: { status?: string }) => t.status === 'in_progress' || t.status === 'complete')) {
    return 'tdd';
  }

  if (existsSync(join(changeDir, 'tasks.md'))) return 'plan';
  if (existsSync(join(changeDir, 'design.md'))) return 'design';
  if (findChangeSpecFiles(changeDir, '').length > 0) return 'spec';
  return 'intent';
}

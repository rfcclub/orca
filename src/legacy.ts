import { existsSync } from 'fs';
import { join } from 'path';

/**
 * Orca was called LoomKit before the rename. Repos created then still carry these names on disk
 * (hundreds of change folders hold the old verify file), so they stay readable. This file is the
 * only place the old name is spelled out.
 */
export const VERIFY_FILE = '.orca-verify.json';
export const LEGACY_VERIFY_FILE = '.loomkit-verify.json';
export const LEGACY_WORKSPACE_DIR = 'loomkit';

/** Where to read a change's verify result: the new file, else the legacy one, else the new name. */
export function verifyFilePath(changeDir: string): string {
  const current = join(changeDir, VERIFY_FILE);
  if (existsSync(current)) return current;
  const legacy = join(changeDir, LEGACY_VERIFY_FILE);
  return existsSync(legacy) ? legacy : current;
}

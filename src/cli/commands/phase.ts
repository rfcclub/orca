import { join } from 'path';
import { existsSync } from 'fs';
import { getChangeDir, changeExists } from '../utils.js';
import { createPhaseJson } from '../../harness/phase-json.js';

/**
 * Creates phase.json for a change, which turns phase-order enforcement on for it. Refuses to
 * replace an existing phase.json: recorded phase state is never reset by this command.
 */
export function createChangePhaseJson(name: string): string {
  if (!changeExists(name)) throw new Error(`Change "${name}" not found.`);
  const changeDir = getChangeDir(name);
  const file = join(changeDir, 'phase.json');
  if (existsSync(file)) throw new Error(`phase.json already exists at ${file}; it is not replaced`);
  createPhaseJson(changeDir, name);
  return file;
}

export function cmdPhase(args: string[]): void {
  const [action, name] = args;
  if (action !== 'init' || !name || name.startsWith('--')) {
    console.error('Usage: orca phase init <name>');
    process.exit(1);
  }
  try {
    const file = createChangePhaseJson(name);
    console.log(`✓  Created ${file}`);
    console.log('  Phase enforcement is now on for this change: the transition guard refuses a phase whose');
    console.log('  prior phase is not complete (record-red, plan-json start, gate-code, verify).');
    console.log('  Note: intent, plan and branch must be recorded complete before record-red or plan-json start,');
    console.log('  and no workflow command records them yet (see USAGE.md).');
  } catch (err: unknown) {
    console.error(`✗  ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

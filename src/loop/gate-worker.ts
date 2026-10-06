import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGateCode } from '../harness/gate-code.js';
import { recordPhaseComplete } from '../harness/phase-json.js';
import { safePath } from './process.js';
import { reviewedCodeDiff } from '../harness/code-diff.js';
import { hashBytes } from '../verify/execution.js';

export function requireFreshLoopGate(root: string, changeDir: string): void {
  const folder = safePath(root, join(changeDir, '.harness/gate-verdicts'));
  const names = readdirSync(folder).filter(n => /^\d+\.json$/.test(n)).sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5)));
  if (!names.length) throw new Error('Final code gate evidence required');
  const gate = JSON.parse(readFileSync(safePath(root, join(folder, names.at(-1)!)), 'utf8'));
  if (gate.task_id || !['PASS', 'PASS_WITH_WARNINGS'].includes(gate.verdict)) {
    throw new Error('Final passing code gate required');
  }
  if (gate.bound_diff_sha256 !== hashBytes(reviewedCodeDiff(changeDir))) {
    throw new Error('Stale code gate: reviewed source changed; review the edit and rerun the final gate');
  }
}

export async function loopGate(input: { root: string; changeDir: string; selfCheckPath: string; taskId?: string }) {
  const result = await runGateCode({ changeDir: input.changeDir, projectRoot: input.root,
    selfCheckPath: safePath(input.root, input.selfCheckPath), taskId: input.taskId });
  if (!input.taskId && ['PASS', 'PASS_WITH_WARNINGS'].includes(result.verdict)) {
    try {
      recordPhaseComplete(input.changeDir, 'gate-code', [], [], { type: 'tool', marker: 'loop:code-gate-passed' });
    } catch (e) {
      if (!(e as Error).message.includes('phase.json not found')) throw e;
    }
  }
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loopGate(JSON.parse(readFileSync(process.argv[2], 'utf8')))
    .then(result => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch(error => { console.error(`Loop gate failed: ${(error as Error).message}`); process.exitCode = 1; });
}

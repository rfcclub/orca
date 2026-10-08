import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readTestContract } from '../verify/change.js';
import { executeTests, hashBytes, selectedFile, sourceBinding, validateExecutionReceipt } from '../verify/execution.js';
import { applyEquivalenceReview, mutationDigest, probeMutation, type MutationReceipt } from '../property/mutation.js';

export interface SealPropertyContract { id: string; priority: 'MUST' | 'SHOULD' | 'MAY'; runs: number; contract_sha256: string }
export interface SealPropertyReview {
  property_id: string; contract_sha256: string; status: 'verified' | 'invalid' | 'unavailable';
  fresh: boolean; runs_actual: number; seed: number;
  mutants: Array<{ id: string; outcome: MutationReceipt['status']; equivalence_verified?: boolean }>;
}

/** A trusted callback, never a certification flag read from the agent's JSON. */
export function createPropertySealBridge(root: string, changeDir: string, name: string,
  options: { reviewersFile?: string } = {}) {
  const current = () => readTestContract(root, changeDir, name);
  const pinned = current();
  const properties = pinned.selection.filter(s => s.property);
  const contracts: SealPropertyContract[] = properties.map(s => ({ id: s.id, priority: 'MUST',
    runs: s.property!.runs, contract_sha256: hashBytes(JSON.stringify([s, pinned.inputs])) }));
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  return { contracts, verify: async (_input: unknown, requested: readonly SealPropertyContract[]): Promise<SealPropertyReview[]> => {
    if (!same(requested, contracts) || !same(current().inputs, pinned.inputs) || !same(current().selection, pinned.selection)) {
      throw new Error('Property contract changed or is stale');
    }
    const before = sourceBinding(root);
    const results: SealPropertyReview[] = [];
    const executions: unknown[] = [];
    const probeDir = join(changeDir, '.harness/property-probes');
    const paths = existsSync(probeDir) ? readdirSync(probeDir).filter(p => p.endsWith('.json')).sort() : [];
    for (const contract of contracts) {
      const selection = properties.filter(s => s.id === contract.id);
      const execution = executeTests(root, selection);
      executions.push({ property_id: contract.id, execution });
      const run = JSON.parse(execution.property_report ?? '[]').find((r: {id?:string}) => r.id === contract.id);
      const review: SealPropertyReview = { property_id: contract.id, contract_sha256: contract.contract_sha256,
        status: execution.outcome === 'green' && validateExecutionReceipt(root, execution) ? 'verified' : 'invalid',
        fresh: same(execution.source, before), runs_actual: run?.successful_runs ?? 0,
        seed: run?.seed, mutants: [] };
      for (const path of paths) {
        let receipt: MutationReceipt;
        try {
          receipt = JSON.parse(readFileSync(selectedFile(root, relative(root, join(probeDir, path))), 'utf8'));
          if (!Array.isArray(receipt.selection)) throw new Error('Malformed probe selection');
          if (!receipt.selection.some(s => s.id === contract.id)) continue;
          if (!same(receipt.selection, selection) || !receipt.mutation ||
            mutationDigest(receipt.mutation) !== receipt.mutation_sha256 || !receipt.baseline ||
            !validateExecutionReceipt(root, receipt.baseline) || receipt.baseline.outcome !== 'green' ||
            !same(receipt.baseline.source, before) || !same(receipt.baseline.tests, execution.tests) ||
            !same(receipt.baseline.runner, execution.runner)) throw new Error('Stale or invalid probe bindings');
          // Status is deliberately ignored: only the current isolated execution decides.
          const fresh = probeMutation(root, selection, receipt.mutation);
          executions.push({ property_id: contract.id, path, probe: fresh });
          if (receipt.equivalence && fresh.status === 'survived') {
            applyEquivalenceReview(root, { ...receipt, status: 'survived' }, receipt.equivalence, options.reviewersFile);
            review.mutants.push({ id: receipt.mutation.id, outcome: 'equivalent', equivalence_verified: true });
          } else review.mutants.push({ id: receipt.mutation.id, outcome: fresh.status });
        } catch (error) {
          review.mutants.push({ id: path, outcome: 'invalid' });
          executions.push({ property_id: contract.id, path, error: String(error) });
        }
      }
      if (!review.mutants.length) review.mutants.push({ id: `${contract.id}-unavailable`, outcome: 'unavailable' });
      results.push(review);
    }
    if (!same(sourceBinding(root), before) || !same(current().inputs, pinned.inputs) || !same(current().selection, pinned.selection)) {
      throw new Error('Property execution inputs changed during verification');
    }
    const evidenceDir = join(changeDir, '.harness/property-gate');
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, `${Date.now()}-${randomUUID()}.json`), JSON.stringify({ contracts, results, executions }, null, 2));
    return results;
  } };
}

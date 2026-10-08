import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import fc from 'fast-check';
import type { TestSelection } from '../verify/execution.js';

const hashBytes = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export interface PropertyContract {
  runs: number;
  maxDiscardRatio: number;
  coverage: Record<string, number>;
  generators: string[];
  corpus: string;
}

const count = z.number().int().nonnegative();
const schema = z.object({
  version: z.literal(1), id: z.string(), invocation: z.string(),
  adapter_sha256: z.string(),
  framework: z.object({ name: z.literal('fast-check'), version: z.string(), sha256: z.string() }),
  seed: z.number().int().min(-2147483648).max(2147483647),
  requested_runs: count, successful_runs: count, skipped: count, shrinks: count,
  categories: z.record(z.string(), count),
  failed: z.boolean(), interrupted: z.boolean(),
  failure_kind: z.enum(['assertion', 'inconclusive']).nullable(),
  replay_path: z.string().nullable(), counterexample: z.unknown(),
  corpus: z.object({ path: z.string(), before_sha256: z.string().nullable(),
    after_sha256: z.string().nullable(), cases: count, executed: count, failed: z.boolean() }),
});

/** Compare helper observations with current spec, framework and corpus bytes. */
export function propertyEvidence(root: string, selection: TestSelection[], report: string,
  invocation: string | undefined, outcome: string): string[] {
  const required = selection.filter(s => s.property);
  if (!required.length) return [];
  const reasons: string[] = [];
  try {
    const receipts = z.array(schema).parse(JSON.parse(report));
    const runtimeUrl = new URL('./runtime.js', import.meta.url);
    const runtime = existsSync(runtimeUrl) ? runtimeUrl : new URL('./runtime.ts', import.meta.url);
    const adapterHash = hashBytes(readFileSync(runtime));
    const frameworkUrl = import.meta.resolve('fast-check');
    const frameworkHash = hashBytes(readFileSync(fileURLToPath(frameworkUrl)));
    // Read the pinned framework's own runtime version, without accepting an
    // agent-authored version/count declaration in YAML.
    for (const selected of required) {
      const matching = receipts.filter(r => r.id === selected.id);
      if (matching.length !== 1) { reasons.push(`Expected exactly one property receipt for ${selected.id}`); continue; }
      const r = matching[0], contract = selected.property!;
      if (!invocation || r.invocation !== invocation || r.adapter_sha256 !== adapterHash ||
          r.framework.sha256 !== frameworkHash || r.framework.version !== fc.__version) reasons.push(`Property adapter/framework binding changed: ${selected.id}`);
      if (r.interrupted) reasons.push(`Property execution interrupted: ${selected.id}`);
      if (r.failed) {
        if (outcome !== 'red' || r.failure_kind !== 'assertion' ||
            (!r.corpus.failed && (r.counterexample == null || r.replay_path === null))) {
          reasons.push(`Property failure is inconclusive: ${selected.id}`);
        }
        continue;
      }
      if (r.failure_kind !== null || r.successful_runs < contract.runs ||
          r.requested_runs !== r.successful_runs) reasons.push(`Property completed runs below contract: ${selected.id}`);
      const attempts = r.successful_runs + r.skipped;
      if (!attempts || r.skipped / attempts > contract.maxDiscardRatio) reasons.push(`Property discard ratio exceeds contract: ${selected.id}`);
      for (const [category, minimum] of Object.entries(contract.coverage)) {
        if (!r.successful_runs || (r.categories[category] ?? 0) / r.successful_runs < minimum) {
          reasons.push(`Property category ${category} below contract: ${selected.id}`);
        }
      }
      if (Object.values(r.categories).some(n => n > r.successful_runs)) reasons.push(`Property category counts are inconsistent: ${selected.id}`);
      const corpus = resolve(root, contract.corpus);
      const corpusHash = existsSync(corpus) ? hashBytes(readFileSync(corpus)) : null;
      const cases = corpusHash ? z.object({ property: z.literal(selected.id), cases: z.array(z.unknown()) })
        .parse(JSON.parse(readFileSync(corpus, 'utf8'))).cases.length : 0;
      if (r.corpus.path !== contract.corpus || r.corpus.before_sha256 !== corpusHash ||
          r.corpus.after_sha256 !== corpusHash || r.corpus.failed ||
          r.corpus.cases !== cases || r.corpus.executed !== cases) reasons.push(`Property corpus replay missing or changed: ${selected.id}`);
    }
  } catch (error) {
    reasons.push(`Missing or invalid property receipt: ${(error as Error).message}`);
  }
  return reasons;
}

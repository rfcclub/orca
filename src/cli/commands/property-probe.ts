import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { changeExists, getChangeDir, getProjectRoot } from '../utils.js';
import { readTestContract } from '../../verify/change.js';
import { probeMutation, applyEquivalenceReview, mutationDigest, type MutationReceipt } from '../../property/mutation.js';

export function cmdPropertyProbe(name: string, options: { property: string; mutation?: string; equivalence?: string }): void {
  try {
    if (!changeExists(name)) throw new Error(`Change "${name}" not found`);
    const root = getProjectRoot(), dir = getChangeDir(name);
    const selected = readTestContract(root, dir, name).selection.find(s => s.id === options.property && s.property);
    if (!selected) throw new Error('Unknown required Property');
    const mutation = options.mutation ? JSON.parse(readFileSync(options.mutation, 'utf8')) : undefined;
    let receipt: MutationReceipt;
    const output = join(dir, '.harness/property-probes');
    if (options.equivalence) {
      const id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/).parse(mutation?.id);
      receipt = JSON.parse(readFileSync(join(output, `${id}.json`), 'utf8'));
      if (receipt.mutation_sha256 !== mutationDigest(mutation) ||
          JSON.stringify(receipt.selection) !== JSON.stringify([selected])) throw new Error('Mutation or property contract changed before review');
      const review = z.object({ reviewer: z.string(), rationale: z.string().min(1), signature: z.string() })
        .strict().parse(JSON.parse(readFileSync(options.equivalence, 'utf8')));
      receipt = applyEquivalenceReview(root, receipt, review);
    } else receipt = probeMutation(root, [selected], mutation);
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, `${receipt.mutation?.id ?? `${selected.id}-unavailable`}.json`), JSON.stringify(receipt, null, 2) + '\n');
    console.log(JSON.stringify(receipt, null, 2));
    if (receipt.status === 'invalid') process.exitCode = 1;
    if (receipt.status === 'unavailable') process.exitCode = 2;
  } catch (error) {
    console.error(`Property probe failed: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

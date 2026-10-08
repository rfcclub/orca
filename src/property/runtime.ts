import fc from 'fast-check';
import { AssertionError } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { corpusPath as checkedCorpusPath } from './corpus-path.js';

export { fc };

type Encoded = null | string | boolean |
  { type: 'number' | 'bigint'; value: string } | { type: 'undefined' } |
  { type: 'array'; values: Encoded[] } | { type: 'object'; entries: [string, Encoded][] };

function encode(value: unknown): Encoded {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'undefined') return { type: 'undefined' };
  if (typeof value === 'number') return { type: 'number', value: Object.is(value, -0) ? '-0' : String(value) };
  if (typeof value === 'bigint') return { type: 'bigint', value: String(value) };
  if (Array.isArray(value)) return { type: 'array', values: value.map(encode) };
  if (typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return { type: 'object', entries: Object.entries(value).map(([key, item]) => [key, encode(item)]) };
  }
  throw new Error('Unsupported concrete corpus value; use plain records/arrays and primitive values');
}

function decode(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  const encoded = z.object({ type: z.string() }).passthrough().parse(value);
  switch (encoded.type) {
    case 'undefined': return undefined;
    case 'number': {
      const text = z.string().parse(encoded.value);
      if (text !== 'NaN' && Number.isNaN(Number(text))) throw new Error('Invalid corpus number');
      return Number(text);
    }
    case 'bigint': return BigInt(z.string().parse(encoded.value));
    case 'array': return z.array(z.unknown()).parse(encoded.values).map(decode);
    case 'object': return Object.fromEntries(z.array(z.tuple([z.string(), z.unknown()])).parse(encoded.entries)
      .map(([key, item]) => [key, decode(item)]));
    default: throw new Error('Unsupported corpus encoding');
  }
}

const corpusSchema = z.object({
  version: z.literal(1), property: z.string(),
  cases: z.array(z.object({ input: z.unknown(), seed: z.number().int(), path: z.string(), framework: z.string() })),
});
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const fileHash = (path: string) => existsSync(path) ? hash(readFileSync(path)) : null;

export interface PropertyRunReceipt {
  version: 1;
  id: string;
  invocation: string | null;
  adapter_sha256: string;
  framework: { name: 'fast-check'; version: string; sha256: string };
  seed: number;
  requested_runs: number;
  successful_runs: number;
  skipped: number;
  shrinks: number;
  categories: Record<string, number>;
  failed: boolean;
  failure_kind: 'assertion' | 'inconclusive' | null;
  interrupted: boolean;
  replay_path: string | null;
  counterexample: Encoded | null;
  corpus: { path: string; before_sha256: string | null; after_sha256: string | null; cases: number; executed: number; failed: boolean };
  error: string | null;
}

export interface PropertyOptions<T> {
  id: string;
  seed?: number;
  numRuns: number;
  corpus: string;
  arbitrary: fc.Arbitrary<T>;
  predicate: (input: T) => boolean | void | Promise<boolean | void>;
  classify?: (input: T) => string[];
}

/** Own framework execution; callers provide a generator/predicate, never run counts. */
export async function assertProperty<T>(options: PropertyOptions<T>): Promise<PropertyRunReceipt> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(options.id)) throw new Error('Property requires a stable slug ID');
  if (!Number.isInteger(options.seed) || options.seed! < -2147483648 || options.seed! > 2147483647) {
    throw new Error('Property requires an explicit deterministic signed 32-bit seed');
  }
  if (!Number.isSafeInteger(options.numRuns) || options.numRuns < 1) throw new Error('Property requires positive numRuns');
  const seed = options.seed!;
  const corpusPath = resolve(options.corpus);
  if (process.env.ORCA_PROPERTY_RUN_ID) checkedCorpusPath(process.cwd(), relative(process.cwd(), corpusPath));
  const before = fileHash(corpusPath);
  const corpus = before ? corpusSchema.parse(JSON.parse(readFileSync(corpusPath, 'utf8'))) :
    { version: 1 as const, property: options.id, cases: [] as z.infer<typeof corpusSchema>['cases'] };
  if (corpus.property !== options.id) throw new Error('Corpus belongs to a different property');
  const frameworkEntry = fileURLToPath(import.meta.resolve('fast-check'));
  const receipt: PropertyRunReceipt = {
    version: 1, id: options.id, invocation: process.env.ORCA_PROPERTY_RUN_ID ?? null,
    adapter_sha256: hash(readFileSync(fileURLToPath(import.meta.url))),
    framework: { name: 'fast-check', version: fc.__version, sha256: hash(readFileSync(frameworkEntry)) },
    seed, requested_runs: options.numRuns, successful_runs: 0, skipped: 0, shrinks: 0,
    categories: {}, failed: false, failure_kind: null, interrupted: false, replay_path: null, counterexample: null,
    corpus: { path: relative(process.cwd(), corpusPath), before_sha256: before, after_sha256: before,
      cases: corpus.cases.length, executed: 0, failed: false }, error: null,
  };
  const emit = () => {
    const dir = process.env.ORCA_PROPERTY_RECEIPT_DIR;
    if (dir) writeFileSync(resolve(dir, `${options.id}-${randomUUID()}.json`), JSON.stringify(receipt));
  };
  for (const entry of corpus.cases) {
    try {
      // The codec is the input boundary. Concrete values deliberately bypass the
      // current generator, so generator changes cannot erase historical failures.
      const result = await options.predicate(decode(entry.input) as T);
      if (result === false) throw new AssertionError({ message: 'predicate returned false', operator: 'property-corpus' });
      receipt.corpus.executed++;
    } catch (error) {
      receipt.failed = true; receipt.corpus.failed = true;
      receipt.failure_kind = (error as Error).name === 'AssertionError' ? 'assertion' : 'inconclusive';
      receipt.seed = entry.seed;
      receipt.counterexample = entry.input as Encoded;
      receipt.error = `Concrete corpus replay failed; seed ${entry.seed}; path ${entry.path}; corpus ${corpusPath}: ${(error as Error).message}`;
      receipt.replay_path = entry.path;
      emit();
      if (receipt.failure_kind === 'inconclusive') throw new Error(`Property execution inconclusive: ${receipt.error}`, { cause: error });
      throw new AssertionError({ message: receipt.error, operator: 'property-corpus' });
    }
  }
  let firstFailure = false;
  const property = fc.asyncProperty(options.arbitrary, async value => {
    try {
      const result = await options.predicate(value);
      if (result === false) {
        if (!firstFailure) receipt.failure_kind = 'assertion';
        firstFailure = true; return false;
      }
      if (!firstFailure) {
        for (const label of new Set(options.classify?.(value) ?? [])) {
          if (!label.trim()) throw new Error('Empty property category label');
          receipt.categories[label] = (receipt.categories[label] ?? 0) + 1;
        }
      }
      return true;
    } catch (error) {
      if (!fc.PreconditionFailure.isFailure(error)) {
        if (!firstFailure) receipt.failure_kind = (error as Error).name === 'AssertionError' ? 'assertion' : 'inconclusive';
        firstFailure = true;
      }
      throw error;
    }
  });
  const result = await fc.check(property, { seed, numRuns: options.numRuns });
  receipt.seed = result.seed;
  receipt.failed = result.failed;
  receipt.interrupted = result.interrupted;
  receipt.successful_runs = result.failed && result.counterexample ? Math.max(0, result.numRuns - 1) : result.numRuns;
  receipt.skipped = result.numSkips;
  receipt.shrinks = result.numShrinks;
  receipt.replay_path = result.counterexamplePath;
  receipt.error = result.errorInstance ? String(result.errorInstance) : null;
  if (result.counterexample !== null) {
    receipt.counterexample = encode(result.counterexample[0]);
    if (!corpus.cases.some(entry => JSON.stringify(entry.input) === JSON.stringify(receipt.counterexample))) {
      corpus.cases.push({ input: receipt.counterexample, seed: result.seed,
        path: result.counterexamplePath!, framework: fc.__version });
      mkdirSync(dirname(corpusPath), { recursive: true });
      writeFileSync(corpusPath, JSON.stringify(corpus, null, 2) + '\n');
    }
    receipt.corpus.after_sha256 = fileHash(corpusPath);
  }
  emit();
  if (result.failed || result.interrupted) {
    if (receipt.failure_kind !== 'assertion') throw new Error(`Property execution inconclusive: ${receipt.error ?? 'discard limit or interruption'}`);
    throw new AssertionError({ message: `Property ${options.id} failed; seed ${result.seed}; path ${result.counterexamplePath ?? 'unavailable'}; counterexample ${JSON.stringify(receipt.counterexample)}; corpus ${corpusPath}`,
      operator: 'property' });
  }
  return receipt;
}

import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { isAbsolute, join, relative } from 'path';
import { z } from 'zod';
import { checkOutcomes, type OutcomeReview } from './outcomes.js';

const id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const configSchema = z.object({
  version: z.literal(1),
  reviewers: z.array(z.object({
    id, kind: z.enum(['human', 'agent']), publicKey: z.string().min(1),
  }).strict()),
}).strict();
const receiptSchema = z.object({
  version: z.literal(1),
  reviews: z.array(z.object({
    stage: id, digest, reviewer: id, signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  }).strict()),
}).strict();
type Receipt = z.infer<typeof receiptSchema>;

/** This is operator configuration, never a file supplied by a project. */
export function localReviewersPath(): string {
  return process.env.ORCA_REVIEWERS_FILE ?? join(homedir(), '.config/orca/reviewers.json');
}

function contained(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
}

function externalFile(file: string, projectRoot: string): string {
  if (!isAbsolute(file)) throw new Error('Reviewer authority paths must be absolute and outside the project');
  const resolved = realpathSync(file);
  if (contained(realpathSync(projectRoot), resolved)) {
    throw new Error('Reviewer configuration and private keys must stay outside the project');
  }
  return resolved;
}

function trustedReviewers(projectRoot: string, file: string): Map<string, KeyObject> {
  const config = configSchema.parse(JSON.parse(readFileSync(externalFile(file, projectRoot), 'utf8')));
  const ids = new Set<string>();
  const humans = new Map<string, KeyObject>();
  for (const reviewer of config.reviewers) {
    if (ids.has(reviewer.id)) throw new Error(`Duplicate reviewer identity: ${reviewer.id}`);
    ids.add(reviewer.id);
    const key = createPublicKey(reviewer.publicKey);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('Local reviewer keys must use Ed25519');
    if (reviewer.kind === 'human') humans.set(reviewer.id, key);
  }
  return humans;
}

function message(stage: string, boundDigest: string): Buffer {
  return Buffer.from(JSON.stringify(['orca-outcome-review/v1', stage, boundDigest]));
}

function receiptPath(changeDir: string): string {
  const root = realpathSync(changeDir);
  const harness = join(root, '.harness');
  mkdirSync(harness, { recursive: true });
  if (!contained(root, realpathSync(harness))) throw new Error('Local review receipt must remain inside the change');
  const file = join(harness, 'local-review.json');
  if (existsSync(file) && !contained(root, realpathSync(file))) {
    throw new Error('Local review receipt must remain inside the change');
  }
  return file;
}

function readReceipt(file: string): Receipt {
  return existsSync(file)
    ? receiptSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
    : { version: 1, reviews: [] };
}

/** A signature proves possession of a configured operator key; protect that key and config. */
export function localOutcomeReview(
  changeDir: string, projectRoot: string, reviewersFile = localReviewersPath(),
): OutcomeReview {
  const reviewers = trustedReviewers(projectRoot, reviewersFile);
  const receipt = readReceipt(receiptPath(changeDir));
  return async (stage, boundDigest) => receipt.reviews.some(review => {
    const key = reviewers.get(review.reviewer);
    if (!key || review.stage !== stage || review.digest !== boundDigest) return false;
    const signature = Buffer.from(review.signature, 'base64');
    return signature.toString('base64') === review.signature &&
      verify(null, message(stage, boundDigest), key, signature);
  });
}

export async function signLocalOutcomeReview(
  changeDir: string, projectRoot: string,
  opts: { stage: string; digest: string; reviewer: string; keyPath: string },
  reviewersFile = localReviewersPath(),
): Promise<void> {
  id.parse(opts.stage); id.parse(opts.reviewer); digest.parse(opts.digest);
  const report = await checkOutcomes(changeDir);
  if (report.digest !== opts.digest) throw new Error('Review requires the explicit current contract digest');
  const stage = report.stages.find(s => s.id === opts.stage);
  if (!stage) throw new Error('Unknown outcome stage');
  if (stage.state !== 'review-required') throw new Error('Cannot sign an incomplete or unsupported stage; fix evidence first');
  const publicKey = trustedReviewers(projectRoot, reviewersFile).get(opts.reviewer);
  if (!publicKey) throw new Error('Reviewer is not a configured human operator');
  const privateKey = createPrivateKey(readFileSync(externalFile(opts.keyPath, projectRoot)));
  const derived = createPublicKey(privateKey);
  if (privateKey.asymmetricKeyType !== 'ed25519' ||
      !derived.export({ type: 'spki', format: 'der' }).equals(publicKey.export({ type: 'spki', format: 'der' }))) {
    throw new Error('Private key does not match the configured reviewer key');
  }
  const file = receiptPath(changeDir);
  const receipt = readReceipt(file);
  receipt.reviews = receipt.reviews.filter(r => r.stage !== opts.stage || r.reviewer !== opts.reviewer);
  receipt.reviews.push({
    stage: opts.stage, digest: opts.digest, reviewer: opts.reviewer,
    signature: sign(null, message(opts.stage, opts.digest), privateKey).toString('base64'),
  });
  const temp = mkdtempSync(join(realpathSync(join(changeDir, '.harness')), '.review-'));
  try {
    writeFileSync(join(temp, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
    renameSync(join(temp, 'receipt.json'), file);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

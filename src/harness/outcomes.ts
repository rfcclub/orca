import { createHash } from 'crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'fs';
import { isAbsolute, join, relative, resolve } from 'path';
import { parse } from 'yaml';
import { z } from 'zod';
import { extractLockedCriteria, hasApprovalRecord } from './gate-plan.js';

const text = z.string().trim().min(1);
const scopeSchema = z.object({ environment: text, revision: text, boundary: text }).strict();
const evidenceSchema = z.object({
  path: text, sha256: z.string().regex(/^[a-f0-9]{64}$/), scope: scopeSchema,
  kind: z.enum(['observation', 'decision', 'verification', 'baseline', 'rehearsal',
    'recovery', 'authorization', 'live', 'tests']),
}).strict();
const stageSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  outcome: z.enum(['investigation', 'decision', 'implementation', 'migration']),
  scope: scopeSchema, criteria: z.array(text).min(1), evidence: z.array(evidenceSchema),
  question: text.optional(), budget: text.optional(),
  hypotheses: z.array(z.object({
    prediction: text, result: z.enum(['confirmed', 'refuted', 'unresolved']),
    observations: z.array(text),
  }).strict()).optional(),
  unknowns: z.array(text).optional(),
  conclusion: z.object({
    status: z.enum(['conclusive', 'inconclusive']), reason: text,
    nextEvidence: text.optional(), rootCause: text.optional(),
  }).strict().optional(),
  options: z.array(text).optional(), choice: text.optional(),
  consequences: z.array(text).optional(), revisit: text.optional(),
  obligations: z.array(z.object({
    text, verification: text, state: z.enum(['fulfilled', 'deferred']),
    followUp: z.string().url().optional(), evidence: text.optional(),
  }).strict()).optional(),
  target: text.optional(), invariants: z.array(text).optional(),
  consumers: z.array(text).optional(), stopConditions: z.array(text).optional(),
  recovery: text.optional(), prerequisites: z.array(text).optional(),
}).strict();
const contractSchema = z.object({
  version: z.literal(1), intent_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  stages: z.array(stageSchema).min(1),
}).strict();

export type OutcomeContract = z.infer<typeof contractSchema>;
type Stage = OutcomeContract['stages'][number];
export type OutcomeState = 'incomplete' | 'review-required' | 'unsupported' |
  'findings-reviewed' | 'findings-reviewed-inconclusive' | 'decision-accepted' | 'migration-completed';
export interface OutcomeAssessment {
  id: string;
  outcome: Stage['outcome'];
  state: OutcomeState;
  reasons: string[];
  followUps: string[];
  unknowns: string[];
  scope: Stage['scope'];
}
export interface OutcomeReport {
  mode: 'legacy' | 'outcomes';
  complete: boolean;
  digest?: string;
  stages: OutcomeAssessment[];
}
export type OutcomeReview = (stage: string, digest: string) => Promise<boolean>;
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

/** Review binds the entire contract, including receipts, scope and deferred work. */
export function contractDigest(contract: unknown): string {
  return sha256(JSON.stringify(canonical(contract)));
}

export function readOutcomeContract(changeDir: string): OutcomeContract | null {
  const tasksPath = join(changeDir, 'tasks.md');
  if (!existsSync(tasksPath)) return null;
  const tasks = readFileSync(tasksPath, 'utf8');
  const fences = [...tasks.matchAll(/^```orca-outcomes\s*\r?\n([\s\S]*?)^```\s*$/gm)];
  const openings = [...tasks.matchAll(/^```orca-outcomes\b/gm)].length;
  if (openings !== fences.length) throw new Error('Unclosed outcome contract fence');
  if (fences.length === 0) {
    return null;
  }
  if (fences.length !== 1) throw new Error('Exactly one outcome contract is permitted');
  const intentPath = join(changeDir, 'intent.md');
  const intent = existsSync(intentPath) ? readFileSync(intentPath, 'utf8') : '';
  if (!hasApprovalRecord(intent)) throw new Error('Outcome contract requires approved intent');
  const contract = contractSchema.parse(parse(fences[0][1]));
  if (contract.intent_sha256 !== sha256(intent)) throw new Error('Intent hash changed since the outcome contract was written');
  const criteria = new Set(extractLockedCriteria(intent, 'intent.md').map(c => c.id));
  const ids = new Set<string>();
  for (const stage of contract.stages) {
    if (ids.has(stage.id)) throw new Error(`Duplicate outcome stage: ${stage.id}`);
    ids.add(stage.id);
    for (const id of stage.criteria) {
      if (!criteria.has(id)) throw new Error(`Unknown approved-intent criterion: ${id}`);
    }
  }
  return contract;
}

function receiptErrors(changeDir: string, stage: Stage): string[] {
  const root = realpathSync(changeDir);
  const errors: string[] = [];
  const paths = new Set<string>();
  for (const evidence of stage.evidence) {
    if (paths.has(evidence.path)) errors.push(`Duplicate evidence path: ${evidence.path}`);
    paths.add(evidence.path);
    if (JSON.stringify(canonical(evidence.scope)) !== JSON.stringify(canonical(stage.scope))) {
      errors.push(`Evidence scope mismatch: ${evidence.path}`);
    }
    try {
      if (isAbsolute(evidence.path)) throw new Error('absolute path');
      const file = realpathSync(resolve(root, evidence.path));
      const rel = relative(root, file);
      if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('outside change');
      if (!statSync(file).isFile()) throw new Error('not a regular file');
      const bytes = readFileSync(file);
      if (!bytes.length || bytes.toString('utf8').trim().length === 0) throw new Error('empty receipt');
      if (sha256(bytes) !== evidence.sha256) throw new Error('hash mismatch');
    } catch (e) {
      errors.push(`Invalid evidence ${evidence.path}: ${(e as Error).message}`);
    }
  }
  return errors;
}

function assess(stage: Stage): { terminal: OutcomeState; reasons: string[]; followUps: string[] } {
  const reasons: string[] = [];
  const followUps: string[] = [];
  const has = (kind: string) => stage.evidence.some(e => e.kind === kind);
  let terminal: OutcomeState = 'incomplete';
  if (stage.outcome === 'investigation') {
    terminal = stage.conclusion?.status === 'inconclusive' ? 'findings-reviewed-inconclusive' : 'findings-reviewed';
    if (!stage.question || !stage.budget || !stage.hypotheses?.length || !stage.conclusion || !stage.unknowns || !has('observation')) {
      reasons.push('Investigation needs question, predictions, budget, observations, conclusion and unknowns');
    }
    const supports = (h: NonNullable<Stage['hypotheses']>[number]) => h.observations.length > 0 &&
      h.observations.every(p => stage.evidence.some(e => e.path === p && e.kind === 'observation'));
    for (const h of stage.hypotheses ?? []) {
      if (h.result !== 'unresolved' && !supports(h)) reasons.push(`Unsupported hypothesis: ${h.prediction}`);
    }
    if (stage.conclusion?.status === 'inconclusive') {
      if (!stage.conclusion.nextEvidence || !stage.unknowns?.length) reasons.push('Inconclusive result needs unknowns and resolving evidence');
      if (stage.conclusion.rootCause) reasons.push('An inconclusive result cannot claim a root cause');
    } else {
      if (!stage.hypotheses?.some(h => h.result !== 'unresolved' && supports(h))) reasons.push('Conclusion lacks resolved observations');
      if (stage.conclusion?.rootCause && (!stage.hypotheses?.some(h => h.result === 'confirmed' && supports(h)) ||
          !stage.hypotheses.some(h => h.result === 'refuted' && supports(h)))) {
        reasons.push('Root cause needs confirming and alternative-refuting observations; recovery alone is insufficient');
      }
    }
  } else if (stage.outcome === 'decision') {
    terminal = 'decision-accepted';
    if (!stage.question || !stage.options || new Set(stage.options).size < 2 || !stage.choice ||
        !stage.options.includes(stage.choice) || !stage.consequences?.length || !stage.revisit ||
        !stage.obligations || !has('decision')) reasons.push('Decision record is incomplete');
    for (const obligation of stage.obligations ?? []) {
      if (obligation.state === 'deferred') {
        if (!obligation.followUp) reasons.push(`Deferred obligation needs follow-up: ${obligation.text}`);
        else followUps.push(obligation.followUp);
      } else if (!stage.evidence.some(e => e.path === obligation.evidence && e.kind === 'verification')) {
        reasons.push(`Fulfilled obligation needs verification evidence: ${obligation.text}`);
      }
    }
  } else if (stage.outcome === 'migration') {
    terminal = 'migration-completed';
    if (!stage.target || !stage.invariants?.length || !stage.consumers?.length ||
        !stage.stopConditions?.length || !stage.recovery || !stage.prerequisites?.length) reasons.push('Migration scope/transition/recovery plan is incomplete');
    for (const kind of ['baseline', 'rehearsal', 'recovery', 'authorization', 'live']) {
      if (!has(kind)) reasons.push(`Migration requires ${kind} evidence at its declared live boundary`);
    }
  } else {
    terminal = 'unsupported';
    reasons.push('Executable code verification is unavailable: existing YAML status and reviewer opinion are not test execution');
  }
  return { terminal, reasons, followUps };
}

/**
 * The review callback is a trusted external adapter, never a contract field.
 * Without it, receipt integrity can be checked offline but acceptance is unknown.
 */
export async function checkOutcomes(changeDir: string, opts: { review?: OutcomeReview } = {}): Promise<OutcomeReport> {
  const contract = readOutcomeContract(changeDir);
  if (!contract) return { mode: 'legacy', complete: false, stages: [] };
  const digest = contractDigest(contract);
  const stages: OutcomeAssessment[] = [];
  for (const stage of contract.stages) {
    const assessment = assess(stage);
    const reasons = [...receiptErrors(changeDir, stage), ...assessment.reasons];
    let state: OutcomeState = assessment.terminal === 'unsupported' ? 'unsupported' : 'incomplete';
    if (reasons.length === 0) {
      state = 'review-required';
      try {
        if (opts.review && await opts.review(stage.id, digest)) state = assessment.terminal;
        else reasons.push('Authenticated human review of this contract digest is required');
      } catch {
        reasons.push('Human review is unavailable; acceptance remains unknown');
      }
    }
    stages.push({ id: stage.id, outcome: stage.outcome, state, reasons,
      followUps: assessment.followUps, unknowns: stage.unknowns ?? [], scope: stage.scope });
  }
  const complete = stages.every(s => !['incomplete', 'review-required', 'unsupported'].includes(s.state));
  return { mode: 'outcomes', complete, digest, stages };
}

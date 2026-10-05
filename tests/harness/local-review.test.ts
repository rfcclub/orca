import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, createHash } from 'crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { localOutcomeReview, signLocalOutcomeReview } from '../../src/harness/local-review.ts';
import { checkOutcomes, readOutcomeContract, contractDigest } from '../../src/harness/outcomes.ts';

function fixture(outcome: 'decision' | 'investigation' | 'migration' = 'decision') {
  const root = mkdtempSync(join(tmpdir(), 'orca-local-review-'));
  const project = join(root, 'project');
  const dir = join(project, 'openspec/changes/demo');
  const keys = join(root, 'keys');
  mkdirSync(join(dir, '.harness'), { recursive: true });
  mkdirSync(keys);
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const key = join(keys, 'owner.pem');
  writeFileSync(key, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const config = join(keys, 'reviewers.json');
  const roles = { version: 1, reviewers: [{ id: 'owner', kind: 'human', publicKey }] };
  writeFileSync(config, JSON.stringify(roles));
  const hash = (v: string) => createHash('sha256').update(v).digest('hex');
  const intent = '# Intent\n## Success Criteria\n- Preserve local use\n## Intent Approval\nStatus: APPROVED\n';
  writeFileSync(join(dir, 'intent.md'), intent);
  const scope = { environment: 'fixture', revision: 'r1', boundary: 'local reader' };
  const kinds = outcome === 'decision' ? ['decision'] : outcome === 'investigation' ? ['observation']
    : ['baseline', 'rehearsal', 'recovery', 'authorization', 'live'];
  const evidence = kinds.map(kind => {
    const path = `.harness/${kind}.json`;
    writeFileSync(join(dir, path), `observed ${kind}`);
    return { path, kind, sha256: hash(`observed ${kind}`), scope };
  });
  const stage = {
    id: 'finding', outcome, scope, criteria: ['SC-1'], evidence,
    ...(outcome === 'decision' ? {
      question: 'Which?', options: ['A', 'B'], choice: 'A', consequences: ['local use'],
      revisit: 'new measurements', obligations: [],
    } : outcome === 'investigation' ? {
      question: 'Does it work?', budget: 'one probe',
      hypotheses: [{ prediction: 'A works', result: 'confirmed', observations: ['.harness/observation.json'] }],
      conclusion: { status: 'conclusive', reason: 'Observed A' }, unknowns: [],
    } : {
      target: 'v2', invariants: ['records'], consumers: ['reader'],
      prerequisites: ['snapshot'], stopConditions: ['mismatch'], recovery: 'restore snapshot',
    }),
  };
  const contract = { version: 1, intent_sha256: hash(intent), stages: [stage] };
  const save = () => writeFileSync(join(dir, 'tasks.md'), '```orca-outcomes\n' + JSON.stringify(contract) + '\n```\n');
  save();
  const digest = () => contractDigest(readOutcomeContract(dir));
  const sign = () => signLocalOutcomeReview(dir, project, {
    stage: 'finding', digest: digest(), reviewer: 'owner', keyPath: key,
  }, config);
  return { root, project, dir, key, keys, config, roles, contract, save, digest, sign,
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('local signed outcome review', () => {
  it.each([
    ['decision', 'decision-accepted'], ['investigation', 'findings-reviewed'],
    ['migration', 'migration-completed'],
  ] as const)('local-review: completes %s with a pinned operator signature', async (kind, state) => {
    const f = fixture(kind);
    try {
      await f.sign();
      const review = localOutcomeReview(f.dir, f.project, f.config);
      const report = await checkOutcomes(f.dir, { review });
      expect(report.complete).toBe(true);
      expect(report.stages[0].state).toBe(state);
      expect(await review('other', f.digest())).toBe(false);
    } finally { f.cleanup(); }
  });

  it('invalid-local-review: rejects unauthorized identities and a wrong private key', async () => {
    const f = fixture();
    try {
      await expect(signLocalOutcomeReview(f.dir, f.project, {
        stage: 'finding', digest: f.digest(), reviewer: 'agent', keyPath: f.key,
      }, f.config)).rejects.toThrow(/reviewer/i);
      const wrong = generateKeyPairSync('ed25519');
      writeFileSync(f.key, wrong.privateKey.export({ type: 'pkcs8', format: 'pem' }));
      await expect(f.sign()).rejects.toThrow(/key/i);
    } finally { f.cleanup(); }
  });

  it('invalid-local-review: ignores a forged signature and revoked reviewer', async () => {
    const f = fixture();
    try {
      await f.sign();
      const path = join(f.dir, '.harness/local-review.json');
      const receipt = JSON.parse(readFileSync(path, 'utf8'));
      receipt.reviews[0].signature = Buffer.alloc(64).toString('base64');
      writeFileSync(path, JSON.stringify(receipt));
      expect(await localOutcomeReview(f.dir, f.project, f.config)('finding', f.digest())).toBe(false);
      await f.sign();
      writeFileSync(f.config, JSON.stringify({ version: 1, reviewers: [] }));
      expect(await localOutcomeReview(f.dir, f.project, f.config)('finding', f.digest())).toBe(false);
    } finally { f.cleanup(); }
  });

  it('invalid-local-review: configured agent keys cannot sign or accept a previous human receipt', async () => {
    const f = fixture();
    try {
      await f.sign();
      f.roles.reviewers[0].kind = 'agent';
      writeFileSync(f.config, JSON.stringify(f.roles));
      expect(await localOutcomeReview(f.dir, f.project, f.config)('finding', f.digest())).toBe(false);
      await expect(f.sign()).rejects.toThrow(/reviewer/i);
    } finally { f.cleanup(); }
  });

  it('stale-local-review: binds scope and every contract field, and requires the explicit current digest', async () => {
    const f = fixture();
    try {
      const old = f.digest();
      await f.sign();
      f.contract.stages[0].criteria.push('SC-1');
      f.save();
      expect(await localOutcomeReview(f.dir, f.project, f.config)('finding', f.digest())).toBe(false);
      await expect(signLocalOutcomeReview(f.dir, f.project, {
        stage: 'finding', digest: old, reviewer: 'owner', keyPath: f.key,
      }, f.config)).rejects.toThrow(/digest/i);
    } finally { f.cleanup(); }
  });

  it('incomplete-local-review: cannot sign incomplete evidence or an unknown stage', async () => {
    const f = fixture();
    try {
      await expect(signLocalOutcomeReview(f.dir, f.project, {
        stage: 'other', digest: f.digest(), reviewer: 'owner', keyPath: f.key,
      }, f.config)).rejects.toThrow(/stage/i);
      rmSync(join(f.dir, '.harness/decision.json'));
      await expect(f.sign()).rejects.toThrow(/incomplete|evidence/i);
    } finally { f.cleanup(); }
  });

  it('project-trust: refuses project-owned or symlinked trust configuration and private keys', async () => {
    const f = fixture();
    try {
      const projectConfig = join(f.project, 'reviewers.json');
      writeFileSync(projectConfig, JSON.stringify(f.roles));
      expect(() => localOutcomeReview(f.dir, f.project, projectConfig)).toThrow(/outside/i);
      const link = join(f.keys, 'linked.json');
      symlinkSync(projectConfig, link);
      expect(() => localOutcomeReview(f.dir, f.project, link)).toThrow(/outside/i);
      const projectKey = join(f.project, 'owner.pem');
      writeFileSync(projectKey, readFileSync(f.key));
      await expect(signLocalOutcomeReview(f.dir, f.project, {
        stage: 'finding', digest: f.digest(), reviewer: 'owner', keyPath: projectKey,
      }, f.config)).rejects.toThrow(/outside/i);
    } finally { f.cleanup(); }
  });

  it('invalid-local-review: missing config and malformed/ambiguous trust data fail closed', async () => {
    const f = fixture();
    try {
      rmSync(f.config);
      expect(() => localOutcomeReview(f.dir, f.project, f.config)).toThrow();
      f.roles.reviewers.push(f.roles.reviewers[0]);
      writeFileSync(f.config, JSON.stringify(f.roles));
      expect(() => localOutcomeReview(f.dir, f.project, f.config)).toThrow(/duplicate/i);
      writeFileSync(f.config, JSON.stringify({ version: 1, reviewers: [{ ...f.roles.reviewers[0], publicKey: 'not a key' }] }));
      expect(() => localOutcomeReview(f.dir, f.project, f.config)).toThrow();
    } finally { f.cleanup(); }
  });
});

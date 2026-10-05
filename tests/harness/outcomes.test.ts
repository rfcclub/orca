import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import { stringify } from 'yaml';
import { checkOutcomes, contractDigest } from '../../src/harness/outcomes.ts';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const intent = '# Intent\n\n## Success criteria\n- Scoped evidence\n- No promotion\n\n## Intent Approval\nStatus: APPROVED\n';
const scope = { environment: 'fixture', revision: 'revision-1', boundary: 'fixture consumer' };
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-outcomes-'));
  writeFileSync(join(dir, 'intent.md'), intent);
  mkdirSync(join(dir, '.harness'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function receipt(kind = 'observation', path = `.harness/${kind}.txt`, text = `observed ${kind}`) {
  writeFileSync(join(dir, path), text);
  return { kind, path, sha256: hash(text), scope };
}
function investigation() {
  const observation = receipt();
  return {
    id: 'finding', outcome: 'investigation', scope, criteria: ['SC-1'], evidence: [observation],
    question: 'Why did the operation fail?', budget: '2 probes / 1 minute',
    hypotheses: [{ prediction: 'replay reproduces failure', result: 'unresolved', observations: [observation.path] }],
    unknowns: ['the cause'], conclusion: { status: 'inconclusive', reason: 'budget exhausted', nextEvidence: 'live trace' },
  };
}
function decision() {
  return {
    id: 'choice', outcome: 'decision', scope, criteria: ['SC-2'], evidence: [receipt('decision')],
    question: 'Which storage?', options: ['A', 'B'], choice: 'A', consequences: ['new adapter'],
    revisit: 'load exceeds measured limit',
    obligations: [{ text: 'implement adapter', verification: 'integration test', state: 'deferred', followUp: 'https://example.test/issues/2' }],
  };
}
function migration() {
  return {
    id: 'move', outcome: 'migration', scope, criteria: ['SC-1'], target: 'new storage',
    invariants: ['records preserved'], consumers: ['fixture reader'], stopConditions: ['read mismatch'],
    recovery: 'restore baseline', prerequisites: ['backup verified'],
    evidence: ['baseline', 'rehearsal', 'recovery', 'authorization', 'live'].map(k => receipt(k)),
  };
}
function writeContract(stages: unknown[]) {
  const contract = { version: 1, intent_sha256: hash(intent), stages };
  writeFileSync(join(dir, 'tasks.md'), `# Tasks\n\n\`\`\`orca-outcomes\n${stringify(contract)}\`\`\`\n`);
  return contract;
}
const reviewed = async () => true; // Injected authenticated-review adapter; never a YAML status.

describe('task outcome contracts', () => {
  it('existing-coding-path: leaves changes without a contract on their existing path', async () => {
    writeFileSync(join(dir, 'tasks.md'), '# ordinary tasks');
    expect(await checkOutcomes(dir)).toMatchObject({ mode: 'legacy', stages: [], complete: false });
  });

  it('invalid-contract: fails closed on unapproved or stale intents and unknown criteria', async () => {
    writeContract([investigation()]);
    writeFileSync(join(dir, 'intent.md'), intent.replace('APPROVED', 'DRAFT'));
    await expect(checkOutcomes(dir)).rejects.toThrow(/approv/i);
    writeFileSync(join(dir, 'intent.md'), intent + '\nchanged');
    await expect(checkOutcomes(dir)).rejects.toThrow(/intent.*hash/i);
    writeFileSync(join(dir, 'intent.md'), intent);
    const stage = investigation();
    stage.criteria = ['SC-999'];
    writeContract([stage]);
    await expect(checkOutcomes(dir)).rejects.toThrow(/criterion/i);
  });

  it('invalid-contract: rejects duplicate stage IDs and duplicate contract fences', async () => {
    const stage = investigation();
    writeContract([stage, stage]);
    await expect(checkOutcomes(dir)).rejects.toThrow(/duplicate/i);
    const contract = writeContract([stage]);
    writeFileSync(join(dir, 'tasks.md'), `\`\`\`orca-outcomes\n${stringify(contract)}\`\`\`\n`.repeat(2));
    await expect(checkOutcomes(dir)).rejects.toThrow(/one.*contract/i);
  });

  it('invalid-contract: rejects a second unterminated contract instead of ignoring stages', async () => {
    const contract = writeContract([investigation()]);
    writeFileSync(join(dir, 'tasks.md'), `\`\`\`orca-outcomes\n${stringify(contract)}\`\`\`\n\n\`\`\`orca-outcomes\nunfinished`);
    await expect(checkOutcomes(dir)).rejects.toThrow(/one.*contract|unclosed/i);
  });

  it('inconclusive-result: reviewed observations can close inconclusively without a patch', async () => {
    writeContract([investigation()]);
    const result = await checkOutcomes(dir, { review: reviewed });
    expect(result.complete).toBe(true);
    expect(result.stages[0]).toMatchObject({ state: 'findings-reviewed-inconclusive', unknowns: ['the cause'] });
  });

  it('unauthenticated-review: offline and rejected reviews cannot produce a terminal claim', async () => {
    writeContract([investigation()]);
    expect((await checkOutcomes(dir)).stages[0].state).toBe('review-required');
    expect((await checkOutcomes(dir, { review: async () => false })).complete).toBe(false);
  });

  it('unsupported-cause: symptom recovery alone cannot establish a cause', async () => {
    const stage: any = investigation();
    stage.conclusion = { status: 'conclusive', reason: 'restarting recovered it', rootCause: 'cache' };
    stage.hypotheses[0].result = 'confirmed';
    writeContract([stage]);
    expect((await checkOutcomes(dir, { review: reviewed })).stages[0]).toMatchObject({ state: 'incomplete' });
    stage.hypotheses.push({ prediction: 'network fails independently', result: 'refuted', observations: [] });
    writeContract([stage]);
    expect((await checkOutcomes(dir, { review: reviewed })).complete).toBe(false);
    stage.hypotheses[1].observations = [receipt('observation', '.harness/refutation.txt').path];
    stage.evidence.push(receipt('observation', '.harness/refutation.txt'));
    writeContract([stage]);
    expect((await checkOutcomes(dir, { review: reviewed })).stages[0].state).toBe('findings-reviewed');
  });

  it('invalid-evidence: rejects missing, empty, changed and differently scoped evidence', async () => {
    for (const defect of ['missing', 'empty', 'changed', 'scope']) {
      const stage = investigation();
      if (defect === 'missing') rmSync(join(dir, stage.evidence[0].path));
      if (defect === 'empty') {
        writeFileSync(join(dir, stage.evidence[0].path), '');
        stage.evidence[0].sha256 = hash('');
      }
      if (defect === 'changed') writeFileSync(join(dir, stage.evidence[0].path), 'changed');
      if (defect === 'scope') stage.evidence[0].scope = { ...scope, environment: 'another environment' };
      writeContract([stage]);
      expect((await checkOutcomes(dir, { review: reviewed })).complete, defect).toBe(false);
    }
  });

  it('invalid-evidence: rejects traversal and symlink escape', async () => {
    const outer = mkdtempSync(join(tmpdir(), 'orca-outcomes-outside-'));
    try {
      writeFileSync(join(outer, 'secret.txt'), 'outside');
      const stage = investigation();
      symlinkSync(join(outer, 'secret.txt'), join(dir, '.harness/link'));
      stage.evidence[0] = { ...stage.evidence[0], path: '.harness/link', sha256: hash('outside') };
      writeContract([stage]);
      expect((await checkOutcomes(dir, { review: reviewed })).complete).toBe(false);
      stage.evidence[0].path = '../secret.txt';
      writeContract([stage]);
      expect((await checkOutcomes(dir, { review: reviewed })).complete).toBe(false);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it('deferred-implementation: decision acceptance preserves follow-ups and never claims code', async () => {
    writeContract([decision()]);
    const result = await checkOutcomes(dir, { review: reviewed });
    expect(result.stages[0]).toMatchObject({ state: 'decision-accepted', followUps: ['https://example.test/issues/2'] });
    expect(JSON.stringify(result)).not.toContain('code-verified');
    const bad: any = decision();
    delete bad.obligations[0].followUp;
    writeContract([bad]);
    expect((await checkOutcomes(dir, { review: reviewed })).complete).toBe(false);
  });

  it('code-only-migration: tests and rehearsal cannot replace live evidence', async () => {
    const stage = migration();
    stage.evidence = stage.evidence.filter(e => e.kind !== 'live');
    stage.evidence.push(receipt('tests'));
    writeContract([stage]);
    expect((await checkOutcomes(dir, { review: reviewed })).complete).toBe(false);
    stage.evidence.push(receipt('live'));
    writeContract([stage]);
    expect((await checkOutcomes(dir, { review: reviewed })).stages[0].state).toBe('migration-completed');
    stage.evidence = stage.evidence.filter(e => e.kind !== 'authorization');
    writeContract([stage]);
    expect((await checkOutcomes(dir, { review: reviewed })).complete).toBe(false);
  });

  it('no-automatic-promotion: shared receipts do not promote decisions into tested code', async () => {
    const finding = investigation();
    const choice = decision();
    choice.evidence.push(finding.evidence[0]);
    writeContract([finding, choice, { id: 'code', outcome: 'implementation', scope, criteria: ['SC-2'], evidence: [receipt('tests')] }]);
    const result = await checkOutcomes(dir, { review: reviewed });
    expect(result.stages.map(s => s.state)).toEqual(['findings-reviewed-inconclusive', 'decision-accepted', 'unsupported']);
    expect(result.complete).toBe(false);
  });

  it('unauthenticated-review: review tokens bind all contract content, not only the stage ID', async () => {
    const original = writeContract([decision()]);
    const digest = contractDigest(original);
    const seen: string[] = [];
    await checkOutcomes(dir, { review: async (_id, d) => { seen.push(d); return d === digest; } });
    expect(seen).toEqual([digest]);
    const changed = decision();
    changed.choice = 'B';
    writeContract([changed]);
    expect((await checkOutcomes(dir, { review: async (_id, d) => d === digest })).complete).toBe(false);
  });
});

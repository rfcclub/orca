import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'fs';
import { generateKeyPairSync, createHash } from 'crypto';
import { execFileSync, spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { contractDigest } from '../../src/harness/outcomes.ts';

const cli = process.env.ORCA_TEST_CLI ?? resolve('dist/cli/index.js');
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'orca-no-github-'));
  const project = join(root, 'project');
  const bin = join(root, 'bin');
  mkdirSync(project); mkdirSync(bin);
  const marker = join(root, 'gh-called');
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf called > '${marker}'\nexit 99\n`, { mode: 0o755 });
  symlinkSync('/usr/bin/git', join(bin, 'git'));
  const block = join(root, 'no-network.cjs');
  writeFileSync(block, `
    const deny=()=>{throw new Error('Network forbidden in local workflow')};
    global.fetch=deny;
    for(const name of ['node:http','node:https']){const m=require(name);m.request=deny;m.get=deny;}
    require('node:net').connect=deny;require('node:net').createConnection=deny;
  `);
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: bin, NODE_OPTIONS: `--require=${block}` };
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], {
    cwd: project, env, encoding: 'utf8',
  });
  return { root, project, marker, env, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('standalone local workflow CLI', () => {
  it('local-coding-path: completes ordinary file workflow without gh or network', () => {
    const s = sandbox();
    try {
      for (const args of [['init'], ['intent', 'demo'], ['spec', 'demo'], ['design', 'demo'], ['plan', 'demo']]) {
        const result = s.run(...args);
        expect(result.status, result.stderr).toBe(0);
      }
      const dir = join(s.project, 'orca/changes/demo');
      writeFileSync(join(dir, 'intent.md'), '# Intent\n## Success Criteria\n- Local files remain usable\n## Intent Approval\nStatus: APPROVED\nApproved by: fixture operator\n');
      writeFileSync(join(dir, 'tasks.md'), '# Tasks\nImplement and test local files remain usable. Verify local files remain usable by executing local-test.cjs.\n');
      const plan = s.run('gate-plan', 'demo');
      expect(plan.status, plan.stderr + plan.stdout).toBe(0);
      expect(plan.stdout).toContain('PASS');
      const spec = '## ADDED Requirements\n### Requirement: Local files\nOrca MUST preserve local files.\n#### Scenario: Local coding path\n- **WHEN** the operator runs the local workflow\n- **THEN** local files remain usable\n';
      writeFileSync(join(dir, 'specs/demo/spec.md'), spec);
      writeFileSync(join(s.project, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module' }));
      writeFileSync(join(s.project, '.gitignore'), 'node_modules\n');
      mkdirSync(join(s.project, 'tests'));
      writeFileSync(join(s.project, 'tests/local.test.js'), `import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
it('[local-files-local-coding-path]', () => {
  for(const name of ['intent.md','tasks.md','design.md'])
    expect(readFileSync('orca/changes/demo/'+name,'utf8').trim().length).toBeGreaterThan(0);
});`);
      execFileSync('/usr/bin/git', ['init', '-q'], { cwd: s.project });
      execFileSync('/usr/bin/git', ['add', '.'], { cwd: s.project });
      execFileSync('/usr/bin/git', ['-c', 'user.name=fixture', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'fixture'], { cwd: s.project });
      symlinkSync(resolve('node_modules'), join(s.project, 'node_modules'), 'dir');
      writeFileSync(join(s.project, 'local-test.cjs'), `const assert=require('node:assert/strict');const fs=require('node:fs');for(const name of ['intent.md','tasks.md','design.md'])assert.ok(fs.readFileSync('orca/changes/demo/'+name,'utf8').trim());console.log('PASS local files remain usable');`);
      const test = spawnSync(process.execPath, ['local-test.cjs'], { cwd: s.project, env: s.env, encoding: 'utf8' });
      expect(test.status).toBe(0);
      writeFileSync(join(dir, 'self-check.md'), '# Self-Check\n## Claims\n- Local files remain usable\n## Evidence\n```json\n' + JSON.stringify([{ type: 'command', command: 'node local-test.cjs', exit_code: test.status, output: test.stdout }]) + '\n```\n');
      const gate = s.run('gate-code', 'demo');
      expect(gate.status, gate.stderr + gate.stdout).toBe(0);
      expect(gate.stdout).toContain('PASS');
      writeFileSync(join(dir, '.traceability.yaml'), JSON.stringify({ scenarios: [{
        scenario: 'local-files-local-coding-path', test: 'tests/local.test.js', status: 'failing',
      }] }));
      const verified = s.run('verify', 'demo');
      expect(verified.status, verified.stdout + verified.stderr).toBe(0);
      expect(verified.stdout).toContain('PASS');
      expect(JSON.parse(readFileSync(join(dir, '.orca-verify.json'), 'utf8')).passed).toBe(true);
      expect(s.run('check-outcomes', 'demo').status).toBe(0);
      expect(s.run('status').status).toBe(0);
      const archive = s.run('archive', 'demo');
      expect(archive.status, archive.stdout + archive.stderr).toBe(0);
      expect(readdirSync(join(s.project, 'orca/archive'))).toHaveLength(1);
      expect(readFileSync(join(s.project, 'orca/specs/demo/spec.md'), 'utf8')).toContain('Local coding path');
      expect(existsSync(s.marker)).toBe(false);
    } finally { s.cleanup(); }
  });

  it('local-review: signs and accepts a local outcome without any issue, gh or network', () => {
    const s = sandbox();
    try {
      const dir = join(s.project, 'openspec/changes/demo');
      mkdirSync(join(dir, '.harness'), { recursive: true });
      const keys = join(s.root, 'keys'); mkdirSync(keys);
      const pair = generateKeyPairSync('ed25519');
      const key = join(keys, 'owner.pem');
      writeFileSync(key, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
      const config = join(keys, 'reviewers.json');
      writeFileSync(config, JSON.stringify({ version: 1, reviewers: [{
        id: 'owner', kind: 'human', publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }),
      }] }));
      s.env.ORCA_REVIEWERS_FILE = config;
      const intent = '# Intent\n## Success Criteria\n- Reviewed choice\n## Intent Approval\nStatus: APPROVED\nApproved by: fixture operator\n';
      const hash = (v: string) => createHash('sha256').update(v).digest('hex');
      const scope = { environment: 'fixture', revision: 'r1', boundary: 'local decision' };
      writeFileSync(join(dir, 'intent.md'), intent);
      writeFileSync(join(dir, 'decision.md'), 'Choose A');
      const contract = { version: 1, intent_sha256: hash(intent), stages: [{
        id: 'choice', outcome: 'decision', criteria: ['SC-1'], scope,
        evidence: [{ kind: 'decision', path: 'decision.md', sha256: hash('Choose A'), scope }],
        question: 'Which?', options: ['A', 'B'], choice: 'A', consequences: ['local use'],
        obligations: [], revisit: 'new evidence',
      }] };
      writeFileSync(join(dir, 'tasks.md'), '```orca-outcomes\n' + JSON.stringify(contract) + '\n```\n');
      expect(s.run('check-outcomes', 'demo', '--local-review').status).toBe(1);
      const digest = contractDigest(contract);
      const sign = s.run('review-outcome', 'demo', '--stage', 'choice', '--digest', digest,
        '--reviewer', 'owner', '--key', key);
      expect(sign.status, sign.stderr + sign.stdout).toBe(0);
      const checked = s.run('check-outcomes', 'demo', '--local-review');
      expect(checked.status, checked.stderr + checked.stdout).toBe(0);
      const report = JSON.parse(checked.stdout);
      expect(report.complete).toBe(true);
      expect(report.stages[0].state).toBe('decision-accepted');
      expect(report.review_source).toBe('local-signature');
      expect(s.run('check-outcomes', 'demo').status).toBe(1); // local receipts are explicitly opt-in
      expect(s.run('check-outcomes', 'demo', '--online', '--local-review').status).toBe(1);
      expect(existsSync(s.marker)).toBe(false);
    } finally { s.cleanup(); }
  });
});

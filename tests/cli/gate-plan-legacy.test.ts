import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url));
it('SC-002: missing change refuses the real CLI with an actionable error', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-gate-plan-missing-'));
  try {
    mkdirSync(join(root, 'openspec/changes'), { recursive: true });
    const result = spawnSync(process.execPath, [cli, 'gate-plan', 'missing'], { cwd: root, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Change "missing" not found.');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it('SC-022: unapproved intent reports the English approval instruction', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-gate-plan-language-'));
  try {
    const dir = join(root, 'openspec/changes/draft'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'intent.md'), '# Intent\nStatus: DRAFT\n');
    const result = spawnSync(process.execPath, [cli, 'gate-plan', 'draft'], { cwd: root, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('intent has no approval record');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

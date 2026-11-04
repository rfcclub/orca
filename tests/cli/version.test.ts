import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const cli = process.env.ORCA_TEST_CLI ?? resolve('dist/cli/index.js');
const version = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version;

it("[VER-001] prints Orca's own version and exits 0", () => {
  const cwd = mkdtempSync(join(tmpdir(), 'orca-version-'));
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'other', version: '9.9.9' }));
  const runs = ['--version', '-v', 'version'].map(flag => spawnSync(process.execPath, [cli, flag], { cwd, encoding: 'utf8' }));
  expect(runs.map(r => [r.status, r.stdout])).toEqual(runs.map(() => [0, `${version}\n`]));
});

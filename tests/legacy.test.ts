import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { verifyFilePath, VERIFY_FILE, LEGACY_VERIFY_FILE } from '../src/legacy.js';
import { localPhase } from '../src/issue/phase.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orca-legacy-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('legacy names stay readable', () => {
  it('a change folder holding only the legacy verify file is read from it', () => {
    writeFileSync(join(dir, LEGACY_VERIFY_FILE), JSON.stringify({ passed: true }));
    expect(verifyFilePath(dir)).toBe(join(dir, LEGACY_VERIFY_FILE));
    expect(localPhase(dir)).toBe('verified');
  });

  it('the new verify file wins when both exist', () => {
    writeFileSync(join(dir, LEGACY_VERIFY_FILE), JSON.stringify({ passed: true }));
    writeFileSync(join(dir, VERIFY_FILE), JSON.stringify({ passed: false }));
    expect(verifyFilePath(dir)).toBe(join(dir, VERIFY_FILE));
    expect(localPhase(dir)).not.toBe('verified');
  });

  it('with neither file the new name is used (for writing)', () => {
    mkdirSync(join(dir, 'x'));
    expect(verifyFilePath(join(dir, 'x'))).toBe(join(dir, 'x', VERIFY_FILE));
  });
});

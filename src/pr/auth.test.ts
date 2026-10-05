import { createPrivateKey, createPublicKey, createVerify, generateKeyPairSync } from 'crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { mintAppJwt } from './auth.js';

function tempKey(): string {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const dir = mkdtempSync(join(tmpdir(), 'orca-pr-'));
  const p = join(dir, 'app.private-key.pem');
  writeFileSync(p, privateKey);
  return p;
}

describe('mintAppJwt', () => {
  it('mints an RS256 JWT whose signature verifies against the key and carries the app id', () => {
    const keyPath = tempKey();
    const jwt = mintAppJwt({ appId: '12345', keyPath });
    const [h, p, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(claims.iss).toBe('12345');
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    const ok = createVerify('RSA-SHA256')
      .update(`${h}.${p}`)
      .verify(createPublicKey(createPrivateKey(readFileSync(keyPath, 'utf8'))), Buffer.from(s, 'base64url'));
    expect(ok).toBe(true);
  });
});

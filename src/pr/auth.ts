import { createSign } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

export interface AppAuth {
  appId: string;
  keyPath: string;
}

/** Mints a short-lived RS256 GitHub App JWT from the App's private key (PEM on disk). */
export function mintAppJwt(auth: AppAuth, ttlSeconds = 540): string {
  const key = readFileSync(auth.keyPath, 'utf8');
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  const input = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: auth.appId, iat: now - 60, exp: now + ttlSeconds })}`;
  const signer = createSign('RSA-SHA256');
  signer.update(input);
  return `${input}.${signer.sign(key).toString('base64url')}`;
}

const GITHUB_API = 'https://api.github.com';

function appHeaders(jwt: string): Record<string, string> {
  return {
    Authorization: `Bearer ${jwt}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'orca-colony',
  };
}

async function appApi<T>(path: string, jwt: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${GITHUB_API}${path}`, { ...init, headers: { ...appHeaders(jwt), ...init?.headers } });
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`GitHub API ${path} failed: ${res.status} ${detail}`.slice(0, 300));
  }
  return res.json() as Promise<T>;
}

export interface InstallationToken {
  token: string;
  expiresAt: string;
  installationId: number;
}

interface Installation {
  id: number;
  account?: { login?: string };
}

/** Exchanges the App JWT for a short-lived installation token; picks the installation covering `repo`'s owner. */
export async function getInstallationToken(auth: AppAuth, repo?: string): Promise<InstallationToken> {
  const jwt = mintAppJwt(auth);
  const installations = await appApi<Installation[]>('/app/installations', jwt);
  const owner = repo?.split('/')[0];
  const match = owner ? installations.find(i => i.account?.login === owner) : installations[0];
  if (!match) {
    throw new Error(`no github-app App installation found${owner ? ` on ${owner}` : ''} — install the App on the target owner first`);
  }
  const data = await appApi<{ token: string; expires_at: string; }>(`/app/installations/${match.id}/access_tokens`, jwt, {
    method: 'POST',
    body: '{}',
  });
  return { token: data.token, expiresAt: data.expires_at, installationId: match.id };
}

/** Auth from the environment: AGORA_COLONY_APP_ID + AGORA_COLONY_KEY_PATH (falls back to the newest ~/backup pem). */
export function authFromEnv(): AppAuth {
  const appId = process.env.AGORA_COLONY_APP_ID;
  if (!appId) throw new Error('AGORA_COLONY_APP_ID is not set (export it with the numeric GitHub App ID)');
  const keyPath = process.env.AGORA_COLONY_KEY_PATH ?? newestBackupKey();
  if (!keyPath) throw new Error('App private key not found — set AGORA_COLONY_KEY_PATH to the .pem path');
  return { appId, keyPath };
}

function newestBackupKey(): string | undefined {
  const dir = join(process.env.HOME ?? '', 'backup');
  try {
    const keys = readdirSync(dir)
      .filter(f => f.startsWith('github-app.') && f.endsWith('.private-key.pem'))
      .sort()
      .reverse();
    return keys.length ? join(dir, keys[0]) : undefined;
  } catch {
    return undefined;
  }
}

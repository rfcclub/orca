import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

/** Check absent files too: a corpus must never write through a symlink parent. */
export function corpusPath(root: string, path: string): string {
  if (isAbsolute(path) || !/^(orca|openspec)\/corpus\/[a-z0-9-]+\.json$/.test(path)) {
    throw new Error(`Unsafe property corpus path: ${path}`);
  }
  const base = realpathSync(root), file = resolve(base, path);
  if (relative(base, file).startsWith('..')) throw new Error(`Corpus escapes project: ${path}`);
  for (let current = file; current !== base; current = dirname(current)) {
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`Corpus follows a symlink: ${path}`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return file;
}

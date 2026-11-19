import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function stripSlash(p) {
  const s = p.replace(/[\\/]+$/, '');
  return s === '' ? '/' : s;
}

/** git repository root when cwd is inside one, otherwise cwd itself; always a real path. */
export function projectKey(cwd) {
  let root = null;
  try {
    root = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    root = null;
  }
  return stripSlash(realpath(root || cwd));
}

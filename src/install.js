import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeDir, loadConfig } from './paths.js';

export const MIN_NODE = [22, 13, 0];

export function nodeVersionOk(version = process.versions.node) {
  const v = version.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((v[i] || 0) > MIN_NODE[i]) return true;
    if ((v[i] || 0) < MIN_NODE[i]) return false;
  }
  return true;
}

export function settingsPath() {
  return path.join(claudeDir(), 'settings.json');
}

export function binPath() {
  return fs.realpathSync(fileURLToPath(new URL('../bin/ccstore.js', import.meta.url)));
}

function q(s) {
  return `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`;
}

export function hookCommand(event) {
  return `${q(process.execPath)} ${q(binPath())} hook ${event}`;
}

export function isOurCommand(cmd) {
  return typeof cmd === 'string' && cmd.includes('ccstore.js') && / hook session-(start|end)\b/.test(cmd);
}

function readSettings() {
  const file = settingsPath();
  if (!fs.existsSync(file)) return { file, data: {}, raw: null };
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return { file, data: {}, raw };
  try {
    return { file, data: JSON.parse(raw), raw };
  } catch (err) {
    throw new Error(`${file} 不是合法的 JSON，没有做任何修改：${err.message}`);
  }
}

/** Remove our hook handlers from a settings object; drops groups and events left empty. */
export function stripOurHooks(data) {
  const hooks = data.hooks;
  if (!hooks || typeof hooks !== 'object') return 0;
  let removed = 0;
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    hooks[event] = hooks[event]
      .map((group) => {
        if (!group || !Array.isArray(group.hooks)) return group;
        const before = group.hooks.length;
        const kept = group.hooks.filter((h) => !isOurCommand(h?.command));
        removed += before - kept.length;
        return { ...group, hooks: kept };
      })
      .filter((group) => !group || !Array.isArray(group.hooks) || group.hooks.length > 0);
    if (hooks[event].length === 0) delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete data.hooks;
  return removed;
}

export function addOurHooks(data, cfg = loadConfig()) {
  data.hooks = data.hooks && typeof data.hooks === 'object' ? data.hooks : {};
  const start = data.hooks.SessionStart || (data.hooks.SessionStart = []);
  start.push({
    matcher: cfg.injectOnClear ? 'startup|clear' : 'startup',
    hooks: [{ type: 'command', command: hookCommand('session-start'), timeout: 10 }],
  });
  const end = data.hooks.SessionEnd || (data.hooks.SessionEnd = []);
  end.push({ hooks: [{ type: 'command', command: hookCommand('session-end'), timeout: 30 }] });
  return data;
}

function backup(file, raw) {
  if (raw === null) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${file}.ccstore-backup-${stamp}`;
  fs.writeFileSync(dest, raw);
  return dest;
}

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.ccstore-tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function install() {
  if (!nodeVersionOk()) {
    throw new Error(`需要 Node.js >= ${MIN_NODE.join('.')}，当前是 ${process.versions.node}。`);
  }
  const { file, data, raw } = readSettings();
  const replaced = stripOurHooks(data);
  addOurHooks(data);
  const bak = backup(file, raw);
  write(file, data);
  return { file, backup: bak, replaced };
}

export function uninstall() {
  const { file, data, raw } = readSettings();
  if (raw === null) return { file, removed: 0, backup: null };
  const removed = stripOurHooks(data);
  if (!removed) return { file, removed: 0, backup: null };
  const bak = backup(file, raw);
  write(file, data);
  return { file, removed, backup: bak };
}

export function installState() {
  try {
    const { data } = readSettings();
    const found = { SessionStart: false, SessionEnd: false };
    for (const event of Object.keys(found)) {
      for (const g of data.hooks?.[event] || []) {
        if ((g?.hooks || []).some((h) => isOurCommand(h?.command))) found[event] = true;
      }
    }
    return found;
  } catch {
    return { SessionStart: false, SessionEnd: false };
  }
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULTS = Object.freeze({
  enabled: true,
  turns: 2,
  maxChars: 9000,
  injectOnClear: false,
  keepPerProject: 50,
  writeTrimmedSession: true,
});

export function storeHome() {
  return process.env.CCSTORE_HOME || path.join(os.homedir(), '.claude-session-store');
}

export function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function ensureStoreHome() {
  const dir = storeHome();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function configPath() {
  return path.join(storeHome(), 'config.json');
}

export function loadConfig() {
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    // missing or invalid config: defaults
  }
  const cfg = { ...DEFAULTS, ...user };
  cfg.turns = Math.max(1, Number(cfg.turns) || DEFAULTS.turns);
  cfg.maxChars = Math.max(1000, Number(cfg.maxChars) || DEFAULTS.maxChars);
  cfg.keepPerProject = Math.max(1, Number(cfg.keepPerProject) || DEFAULTS.keepPerProject);
  return cfg;
}

export function log(message) {
  try {
    ensureStoreHome();
    fs.appendFileSync(path.join(storeHome(), 'hook.log'), `${new Date().toISOString()} ${message}\n`);
  } catch {
    // logging must never throw
  }
}

export function envFlag(name) {
  const v = process.env[name];
  return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
}

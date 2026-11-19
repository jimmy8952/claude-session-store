import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BIN = fileURLToPath(new URL('../bin/ccstore.js', import.meta.url));

/** A temp HOME with ~/.claude and a store dir; sets env for in-process calls too. */
export function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccstore-test-'));
  const home = path.join(root, 'home');
  const env = {
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CCSTORE_HOME: path.join(home, '.claude-session-store'),
  };
  delete env.CCSTORE_FRESH;
  delete env.CCSTORE_DISABLE;
  fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  for (const k of ['HOME', 'CLAUDE_CONFIG_DIR', 'CCSTORE_HOME']) process.env[k] = env[k];
  delete process.env.CCSTORE_FRESH;
  delete process.env.CCSTORE_DISABLE;
  return { root, home, env };
}

export function makeDir(root, ...parts) {
  const d = path.join(root, ...parts);
  fs.mkdirSync(d, { recursive: true });
  return fs.realpathSync(d);
}

export function gitInit(dir) {
  spawnSync('git', ['init', '-q', dir]);
}

/** Builds a transcript the way Claude Code writes one: a parentUuid chain of records. */
export class Transcript {
  constructor({ sessionId = randomUUID(), cwd, entrypoint = 'cli' } = {}) {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.entrypoint = entrypoint;
    this.records = [];
    this.last = null;
    this.t = Date.parse('2026-11-19T06:00:00Z');
  }
  base(extra) {
    this.t += 1000;
    const r = {
      parentUuid: this.last,
      isSidechain: false,
      userType: 'external',
      cwd: this.cwd,
      sessionId: this.sessionId,
      version: '2.1.328',
      entrypoint: this.entrypoint,
      uuid: randomUUID(),
      timestamp: new Date(this.t).toISOString(),
      ...extra,
    };
    this.records.push(r);
    this.last = r.uuid;
    return r;
  }
  attachment(text) {
    return this.base({ type: 'attachment', attachment: { type: 'hook_additional_context', content: [text] } });
  }
  user(text) {
    return this.base({ type: 'user', message: { role: 'user', content: text } });
  }
  command(name) {
    return this.base({ type: 'user', message: { role: 'user', content: `<command-name>${name}</command-name>` } });
  }
  assistantText(text) {
    return this.base({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  }
  tool(name, input, output = 'lots of output', isError = false) {
    const id = `toolu_${randomUUID().slice(0, 8)}`;
    this.base({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
    return this.base({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output, is_error: isError }] },
      toolUseResult: { stdout: output },
    });
  }
  turn(prompt, answer, tools = []) {
    this.user(prompt);
    for (const [name, input, out, err] of tools) this.tool(name, input, out, err);
    this.assistantText(answer);
    return this;
  }
  /** move the write head back (simulates /rewind) */
  rewindTo(uuid) {
    this.last = uuid;
  }
  extra(record) {
    this.records.push(record);
  }
  dir() {
    return path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', this.cwd.replace(/[^A-Za-z0-9]/g, '-'));
  }
  write() {
    const dir = this.dir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${this.sessionId}.jsonl`);
    fs.writeFileSync(file, this.records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return file;
  }
}

export function runCli(args, { env, input, cwd } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    env: env || process.env,
    input: input === undefined ? undefined : typeof input === 'string' ? input : JSON.stringify(input),
    cwd,
    encoding: 'utf8',
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

export function endHook(t, file, env, reason = 'prompt_input_exit') {
  return runCli(['hook', 'session-end'], {
    env,
    input: { session_id: t.sessionId, transcript_path: file, cwd: t.cwd, hook_event_name: 'SessionEnd', reason },
  });
}

export function startHook(cwd, env, source = 'startup') {
  const r = runCli(['hook', 'session-start'], {
    env,
    input: { session_id: randomUUID(), transcript_path: '/dev/null', cwd, hook_event_name: 'SessionStart', source },
  });
  return { ...r, json: r.stdout.trim() ? JSON.parse(r.stdout) : null };
}

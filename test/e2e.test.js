import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { endHook, gitInit, makeDir, runCli, sandbox, startHook, Transcript } from './helpers.js';

function ageAllRows(storeDb, iso) {
  const db = new DatabaseSync(storeDb);
  db.prepare('UPDATE snapshots SET created_at = ?').run(iso);
  db.close();
}

function ctx(r) {
  return r.json?.hookSpecificOutput?.additionalContext ?? null;
}

test('full cycle: save on exit, inject on startup, skip on resume', () => {
  const { root, env } = sandbox();
  const repo = makeDir(root, 'repo');
  gitInit(repo);
  const sub = makeDir(root, 'repo', 'src');

  // nothing stored yet: plain fresh start
  assert.equal(startHook(repo, env).stdout, '');

  const t = new Transcript({ cwd: repo });
  t.turn('问题一', '回答一').turn('问题二', '回答二', [['Bash', { command: 'npm test' }, 'PASS 42 tests']]).turn('问题三', '回答三');
  const file = t.write();
  const end = endHook(t, file, env);
  assert.equal(end.code, 0);
  assert.equal(end.stdout, '');
  assert.equal(end.stderr, '');

  const s = startHook(sub, env); // same git project, different subdirectory
  assert.equal(s.code, 0);
  assert.equal(s.stderr, '', 'no ExperimentalWarning leaks');
  const text = ctx(s);
  assert.ok(text.includes('问题二') && text.includes('问题三'));
  assert.ok(!text.includes('问题一'));
  assert.ok(text.includes('[运行了 Bash: npm test，输出已省略]'));
  assert.ok(!text.includes('PASS 42 tests'));
  assert.equal(s.json.hookSpecificOutput.hookEventName, 'SessionStart');

  for (const source of ['resume', 'clear', 'compact', 'fork']) {
    assert.equal(startHook(repo, env, source).stdout, '', `no injection on ${source}`);
  }
  assert.equal(startHook(repo, { ...env, CCSTORE_FRESH: '1' }).stdout, '');

  // a different, non-git directory has nothing
  const other = makeDir(root, 'other');
  assert.equal(startHook(other, env).stdout, '');

  // trimmed session file sits next to the original and is labelled
  const show = runCli(['show', '--ids'], { env, cwd: repo });
  const trimmedId = show.stdout.match(/裁剪版 session\s+(\S+)/)[1];
  const trimmedFile = path.join(path.dirname(file), `${trimmedId}.jsonl`);
  assert.ok(fs.existsSync(trimmedFile));
  const lastLine = JSON.parse(fs.readFileSync(trimmedFile, 'utf8').trim().split('\n').at(-1));
  assert.equal(lastLine.type, 'custom-title');
  assert.ok(lastLine.customTitle.startsWith('[裁剪版·最近2轮]'));
});

test('no new prompt: opening and quitting keeps the previous snapshot', () => {
  const { root, env } = sandbox();
  const dir = makeDir(root, 'plain');
  const t1 = new Transcript({ cwd: dir });
  t1.turn('A', 'a').turn('B', 'b');
  endHook(t1, t1.write(), env);

  const t2 = new Transcript({ cwd: dir });
  t2.attachment('<ccstore-context project="x">...</ccstore-context>');
  const r = endHook(t2, t2.write(), env);
  assert.equal(r.code, 0);
  const list = runCli(['list'], { env, cwd: dir });
  assert.equal((list.stdout.match(/#\d+/g) || []).length, 1);

  // resumed trimmed session with no new prompt: still nothing new (uuids are preserved)
  const show = runCli(['show', '--ids'], { env, cwd: dir });
  const trimmedFile = show.stdout.match(/裁剪版文件\s+(\S+)/)[1];
  const tid = path.basename(trimmedFile, '.jsonl');
  endHook({ sessionId: tid, cwd: dir }, trimmedFile, env, 'other');
  assert.equal((runCli(['list'], { env, cwd: dir }).stdout.match(/#\d+/g) || []).length, 1);
});

test('one-question session merges with the previous snapshot: [A,B] + C -> [B,C]', () => {
  const { root, env } = sandbox();
  const dir = makeDir(root, 'm');
  const t1 = new Transcript({ cwd: dir });
  t1.turn('A', 'a').turn('B', 'b');
  endHook(t1, t1.write(), env);
  const t2 = new Transcript({ cwd: dir });
  t2.attachment('<ccstore-context>...</ccstore-context>');
  t2.turn('C', 'c', [['Read', { file_path: 'x.md' }]]);
  endHook(t2, t2.write(), env);

  const text = ctx(startHook(dir, env));
  assert.ok(text.includes('用户：B') && text.includes('用户：C'));
  assert.ok(!text.includes('用户：A'));

  // the trimmed session spans both sessions as one valid chain
  const show = runCli(['show', '--ids'], { env, cwd: dir });
  const trimmedFile = show.stdout.match(/裁剪版文件\s+(\S+)/)[1];
  const recs = fs.readFileSync(trimmedFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.uuid);
  assert.equal(recs[0].parentUuid, null);
  for (let i = 1; i < recs.length; i++) assert.equal(recs[i].parentUuid, recs[i - 1].uuid);
  const prompts = recs.filter((r) => r.type === 'user' && typeof r.message.content === 'string').map((r) => r.message.content);
  assert.deepEqual(prompts, ['B', 'C']);
});

test('sdk (-p) sessions are skipped, hook failures still exit 0', () => {
  const { root, env } = sandbox();
  const dir = makeDir(root, 'sdk');
  const t = new Transcript({ cwd: dir, entrypoint: 'sdk-cli' });
  t.turn('scripted', 'x');
  endHook(t, t.write(), env);
  assert.equal(startHook(dir, env).stdout, '');

  const bad = runCli(['hook', 'session-end'], { env, input: 'not json' });
  assert.equal(bad.code, 0);
  const missing = runCli(['hook', 'session-end'], { env, input: { transcript_path: '/nope.jsonl', cwd: dir } });
  assert.equal(missing.code, 0);
  assert.ok(fs.readFileSync(path.join(env.CCSTORE_HOME, 'hook.log'), 'utf8').includes('failed'));
});

test('resume restores a cleaned-up trimmed file and runs claude --resume in the original cwd', () => {
  const { root, env } = sandbox();
  const dir = makeDir(root, 'r');
  const t = new Transcript({ cwd: dir });
  t.turn('A', 'a').turn('B', 'b');
  endHook(t, t.write(), env);
  const show = runCli(['show', '--ids'], { env, cwd: dir });
  const trimmedFile = show.stdout.match(/裁剪版文件\s+(\S+)/)[1];
  fs.rmSync(trimmedFile);

  const fake = path.join(root, 'fake-claude.sh');
  fs.writeFileSync(fake, '#!/bin/sh\necho "ARGS=$*"\necho "CWD=$(pwd -P)"\n', { mode: 0o755 });
  const other = makeDir(root, 'elsewhere');
  const r = runCli(['resume'], { env: { ...env, CCSTORE_CLAUDE_BIN: fake }, cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(fs.existsSync(trimmedFile), 'restored from the database');
  assert.match(r.stdout, /ARGS=--resume [0-9a-f-]{36}/);
  assert.ok(r.stdout.includes(`CWD=${dir}`));
  assert.ok(other);
});

test('snapshots older than maxAgeDays are purged with their trimmed files on the next session end; prune does it by hand', () => {
  const { root, env } = sandbox();
  const db = path.join(env.CCSTORE_HOME, 'store.db');
  const dir = makeDir(root, 'age');

  const t1 = new Transcript({ cwd: dir });
  t1.turn('旧问题', '旧回答');
  endHook(t1, t1.write(), env);
  const oldFile = runCli(['show', '--ids'], { env, cwd: dir }).stdout.match(/裁剪版文件\s+(\S+)/)[1];
  assert.ok(fs.existsSync(oldFile));

  // age the row past the window, then end any session: the save path sweeps the store
  ageAllRows(db, '2026-09-01T00:00:00.000Z');
  const t2 = new Transcript({ cwd: dir });
  t2.turn('新问题', '新回答');
  endHook(t2, t2.write(), env);
  assert.ok(!fs.existsSync(oldFile), 'old trimmed file removed');
  assert.equal((runCli(['list'], { env, cwd: dir }).stdout.match(/#\d+/g) || []).length, 1);

  // manual prune: default window from config, bad --days rejected
  ageAllRows(db, '2026-09-02T00:00:00.000Z');
  assert.equal(runCli(['prune', '--days', 'x'], { env }).code, 1);
  assert.match(runCli(['prune'], { env }).stdout, /已删除 1 条 30 天前的快照（含 1 个裁剪版会话文件）/);
  assert.equal(runCli(['list'], { env, cwd: dir }).stdout.match(/#\d+/g), null);
  assert.match(runCli(['prune'], { env }).stdout, /没有 30 天前的快照/);
  assert.match(runCli(['status'], { env, cwd: dir }).stdout, /保留策略\s+每项目 50 条；超过 30 天/);
});

test('install / uninstall against settings.json', () => {
  const { env } = sandbox();
  const settings = path.join(env.CLAUDE_CONFIG_DIR, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say hi' }] }] } }));
  assert.equal(runCli(['install'], { env }).code, 0);
  assert.equal(runCli(['install'], { env }).code, 0); // idempotent
  const data = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.equal(data.theme, 'dark');
  assert.equal(data.hooks.Stop.length, 1);
  assert.equal(data.hooks.SessionStart.length, 1);
  assert.equal(data.hooks.SessionEnd.length, 1);
  assert.equal(data.hooks.SessionStart[0].matcher, 'startup');
  assert.equal(data.hooks.SessionEnd[0].hooks[0].timeout, 30);
  assert.match(runCli(['status'], { env }).stdout, /SessionStart ✓\s+SessionEnd ✓/);

  assert.equal(runCli(['uninstall', '--purge'], { env }).code, 0);
  const after = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.deepEqual(after, { theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say hi' }] }] } });
  assert.ok(!fs.existsSync(env.CCSTORE_HOME));
});

test('the installed hook command really runs', () => {
  const { root, env } = sandbox();
  runCli(['install'], { env });
  const data = JSON.parse(fs.readFileSync(path.join(env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8'));
  const dir = makeDir(root, 'h');
  const t = new Transcript({ cwd: dir });
  t.turn('X', 'x').turn('Y', 'y');
  const file = t.write();
  const run = (cmd, input) =>
    JSON.parse(JSON.stringify(require_sh(cmd, input, env)));
  run(data.hooks.SessionEnd[0].hooks[0].command, { session_id: t.sessionId, transcript_path: file, cwd: dir, reason: 'other' });
  const out = run(data.hooks.SessionStart[0].hooks[0].command, { source: 'startup', cwd: dir });
  assert.ok(JSON.parse(out).hookSpecificOutput.additionalContext.includes('用户：Y'));
});

import { spawnSync } from 'node:child_process';
function require_sh(cmd, input, env) {
  const r = spawnSync('/bin/sh', ['-c', cmd], { input: JSON.stringify(input), env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

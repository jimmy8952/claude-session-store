import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { claudeDir, configPath, envFlag, loadConfig, storeHome } from './paths.js';
import { projectKey } from './project.js';
import { formatTime, renderContext } from './render.js';
import { dbPath, openStore } from './store.js';
import { install, installState, MIN_NODE, nodeVersionOk, settingsPath, uninstall } from './install.js';
import { saveSnapshot } from './hooks.js';

const short = (id) => (id ? `${id.slice(0, 8)}…` : '—');
const oneLine = (s, n = 50) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

function lastPrompt(row) {
  try {
    const turns = JSON.parse(row.turns_json);
    return turns[turns.length - 1]?.user || '';
  } catch {
    return '';
  }
}

function pickSnapshot(store, idArg) {
  if (idArg !== undefined) {
    const row = store.get(idArg);
    if (!row) throw new Error(`找不到快照 #${idArg}`);
    return row;
  }
  const key = projectKey(process.cwd());
  const row = store.latest(key);
  if (!row) throw new Error(`当前项目（${key}）还没有快照`);
  return row;
}

export function cmdInstall() {
  const r = install();
  console.log(`已写入 ${r.file}`);
  if (r.backup) console.log(`原文件备份：${r.backup}`);
  if (r.replaced) console.log(`已替换旧版本的 ${r.replaced} 个 ccstore hook`);
  console.log('SessionStart（startup）→ 注入最近两轮；SessionEnd → 保存快照');
  console.log(`数据目录：${storeHome()}`);
  console.log('下次在项目里运行 claude 即生效。');
}

export function cmdUninstall(args) {
  const r = uninstall();
  console.log(r.removed ? `已从 ${r.file} 删除 ${r.removed} 个 ccstore hook` : '没有找到 ccstore 的 hook');
  if (r.backup) console.log(`原文件备份：${r.backup}`);
  if (args.includes('--purge')) {
    fs.rmSync(storeHome(), { recursive: true, force: true });
    console.log(`已删除数据目录 ${storeHome()}`);
  }
}

export function cmdStatus() {
  const cfg = loadConfig();
  const state = installState();
  const key = projectKey(process.cwd());
  console.log(`Node.js        ${process.versions.node}${nodeVersionOk() ? '' : `（需要 >= ${MIN_NODE.join('.')}）`}`);
  console.log(`settings.json  ${settingsPath()}`);
  console.log(`hook 安装状态  SessionStart ${state.SessionStart ? '✓' : '✗'}   SessionEnd ${state.SessionEnd ? '✓' : '✗'}`);
  console.log(`数据库         ${dbPath()}`);
  console.log(`配置           ${fs.existsSync(configPath()) ? configPath() : '默认（无 config.json）'}  turns=${cfg.turns} maxChars=${cfg.maxChars}`);
  console.log(`当前项目键     ${key}`);
  const store = openStore();
  try {
    const snap = store.latest(key);
    const willInject = state.SessionStart && cfg.enabled && !envFlag('CCSTORE_DISABLE') && snap;
    console.log(
      snap
        ? `最新快照       #${snap.id}  ${formatTime(snap.created_at)}  ${snap.turn_count} 轮  「${oneLine(lastPrompt(snap), 40)}」`
        : '最新快照       无'
    );
    console.log(`下次启动       ${willInject ? '会注入最新快照' : '不注入，正常全新启动'}`);
  } finally {
    store.close();
  }
}

export function cmdList(args) {
  const all = args.includes('--all');
  const store = openStore();
  try {
    const key = all ? null : projectKey(process.cwd());
    const rows = store.list(key, 50);
    if (!rows.length) {
      console.log(all ? '还没有任何快照' : `当前项目（${key}）还没有快照`);
      return;
    }
    let lastKey = null;
    for (const r of rows) {
      if (r.project_key !== lastKey) {
        console.log(`\n项目 ${r.project_key}`);
        lastKey = r.project_key;
      }
      console.log(
        `  #${String(r.id).padEnd(4)} ${formatTime(r.created_at)}  ${r.turn_count}轮  原始 ${short(r.source_session_id)}  裁剪版·最近${r.turn_count}轮 ${short(r.trimmed_session_id)}  「${oneLine(lastPrompt(r), 36)}」`
      );
    }
    console.log('\n完整 ID：ccstore show <编号> --ids');
  } finally {
    store.close();
  }
}

export function cmdShow(args) {
  const idArg = args.find((a) => /^\d+$/.test(a));
  const store = openStore();
  try {
    const snap = pickSnapshot(store, idArg);
    if (args.includes('--ids')) {
      console.log(`快照 #${snap.id}  ${formatTime(snap.created_at)}`);
      console.log(`项目键            ${snap.project_key}`);
      console.log(`启动目录          ${snap.cwd}`);
      console.log(`原始 session      ${snap.source_session_id}`);
      console.log(`裁剪版 session    ${snap.trimmed_session_id || '—'}  （裁剪·最近 ${snap.turn_count} 轮）`);
      console.log(`裁剪版文件        ${snap.trimmed_transcript || '—'}`);
      return;
    }
    console.log(
      renderContext(
        { turns: JSON.parse(snap.turns_json), projectKey: snap.project_key, savedAt: snap.created_at },
        loadConfig().maxChars
      )
    );
  } finally {
    store.close();
  }
}

export function restoreTrimmedFile(snap) {
  if (!snap.trimmed_session_id || !snap.trimmed_jsonl) throw new Error(`快照 #${snap.id} 没有裁剪版会话`);
  const file = snap.trimmed_transcript;
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, snap.trimmed_jsonl, { mode: 0o600 });
    return { file, restored: true };
  }
  return { file, restored: false };
}

export function cmdResume(args) {
  const idArg = args.find((a) => /^\d+$/.test(a));
  const store = openStore();
  let snap;
  try {
    snap = pickSnapshot(store, idArg);
  } finally {
    store.close();
  }
  const { restored } = restoreTrimmedFile(snap);
  if (restored) console.log('裁剪版文件已被清理，已从数据库恢复。');
  if (!fs.existsSync(snap.cwd)) throw new Error(`启动目录已不存在：${snap.cwd}`);
  console.log(`打开裁剪版会话（最近 ${snap.turn_count} 轮）${snap.trimmed_session_id}，目录 ${snap.cwd}`);
  const bin = process.env.CCSTORE_CLAUDE_BIN || 'claude';
  const child = spawn(bin, ['--resume', snap.trimmed_session_id], { cwd: snap.cwd, stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (err) => {
    console.error(`无法启动 ${bin}：${err.message}`);
    process.exit(1);
  });
}

export function cmdForget(args) {
  const key = projectKey(process.cwd());
  if (!args.includes('--yes')) {
    console.log(`将删除项目 ${key} 的全部快照。确认请运行：ccstore forget --yes`);
    return;
  }
  const store = openStore();
  try {
    console.log(`已删除 ${store.forget(key)} 条快照`);
  } finally {
    store.close();
  }
}

/** Claude Code stores sessions under projects/<cwd with every non-alphanumeric char replaced by '-'>. */
export function projectDirFor(cwd) {
  return path.join(claudeDir(), 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
}

export function cmdSave() {
  const cwd = process.cwd();
  const dir = projectDirFor(cwd);
  if (!fs.existsSync(dir)) throw new Error(`没有找到当前目录的会话记录：${dir}`);
  const store = openStore();
  let ours;
  try {
    ours = store.knownTrimmedSessionIds();
  } finally {
    store.close();
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl') && !ours.has(f.slice(0, -6)))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!files.length) throw new Error(`${dir} 下没有会话记录`);
  const transcript = path.join(dir, files[0].f);
  const r = saveSnapshot(
    { session_id: files[0].f.slice(0, -6), transcript_path: transcript, cwd, reason: 'manual' },
    { force: true }
  );
  console.log(r.saved ? `已保存快照 #${r.id}（${r.turns} 轮），来自 ${transcript}` : `没有保存：${r.reason}`);
}

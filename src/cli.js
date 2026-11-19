import { log } from './paths.js';
import { sessionEnd, sessionStart } from './hooks.js';
import { cmdForget, cmdInstall, cmdList, cmdResume, cmdSave, cmdShow, cmdStatus, cmdUninstall } from './commands.js';

const HELP = `ccstore — Claude Code 会话记忆（每个项目记住最近两轮）

用法：
  ccstore install              安装 hook 到 ~/.claude/settings.json
  ccstore uninstall [--purge]  移除 hook（--purge 同时删除数据）
  ccstore status               查看安装状态和当前项目
  ccstore list [--all]         列出当前项目（或全部项目）的快照
  ccstore show [编号] [--ids]  显示将注入的文字（--ids 显示完整 session ID）
  ccstore resume [编号]        打开备用的裁剪版会话（claude --resume）
  ccstore forget [--yes]       删除当前项目的全部快照
  ccstore save                 手动为当前目录最近的会话做一次快照

环境变量：
  CCSTORE_FRESH=1 claude       这次启动不注入
  CCSTORE_DISABLE=1            完全停用（不保存也不注入）
  CCSTORE_HOME                 数据目录，默认 ~/.claude-session-store
`;

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function runHook(event) {
  try {
    const raw = await readStdin();
    const input = raw.trim() ? JSON.parse(raw) : {};
    if (event === 'session-end') {
      sessionEnd(input);
    } else if (event === 'session-start') {
      const out = sessionStart(input);
      if (out) process.stdout.write(`${out}\n`);
    } else {
      log(`unknown hook event: ${event}`);
    }
  } catch (err) {
    log(`hook ${event} failed: ${err?.stack || err}`);
  }
  // a hook must never break Claude Code
  process.exitCode = 0;
}

export async function main(argv) {
  const [cmd, ...args] = argv;
  if (cmd === 'hook') return runHook(args[0]);
  try {
    switch (cmd) {
      case 'install':
        return cmdInstall();
      case 'uninstall':
        return cmdUninstall(args);
      case 'status':
        return cmdStatus();
      case 'list':
      case 'ls':
        return cmdList(args);
      case 'show':
        return cmdShow(args);
      case 'resume':
        return cmdResume(args);
      case 'forget':
        return cmdForget(args);
      case 'save':
        return cmdSave();
      case undefined:
      case 'help':
      case '-h':
      case '--help':
        process.stdout.write(HELP);
        return;
      case '-v':
      case '--version': {
        const { readFileSync } = await import('node:fs');
        const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
        console.log(pkg.version);
        return;
      }
      default:
        console.error(`未知命令：${cmd}\n`);
        process.stdout.write(HELP);
        process.exitCode = 1;
    }
  } catch (err) {
    console.error(`错误：${err.message}`);
    process.exitCode = 1;
  }
}

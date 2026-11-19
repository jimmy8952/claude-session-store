import { itemsToLines } from './compress.js';

function pad(n) {
  return String(n).padStart(2, '0');
}

export function formatTime(iso) {
  if (!iso) return '时间未知';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '时间未知';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export function middleTruncate(text, maxLen) {
  if (text.length <= maxLen) return text;
  const omitted0 = text.length - maxLen;
  const marker = (n) => `\n…（中间省略 ${n} 字）…\n`;
  const keep = Math.max(0, maxLen - marker(omitted0).length);
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  const omitted = text.length - head - tail;
  return text.slice(0, head) + marker(omitted) + (tail > 0 ? text.slice(text.length - tail) : '');
}

function header(projectKey, savedAt, n) {
  return (
    `<ccstore-context project="${escapeAttr(projectKey)}" saved="${formatTime(savedAt)}">\n` +
    `以下是你与用户在本项目中最近 ${n} 轮对话的记录，由 claude-session-store 在上次退出时保存，作为背景参考。` +
    '工具调用已压缩，工具输出未保留，需要时请重新读取文件或重新运行命令，不要凭记忆假设它们的内容。'
  );
}

const FOOTER = '</ccstore-context>';

const ANSWER_DROPPED = '（回答过长，已省略）';

/**
 * Build the injected text, keeping it under maxChars.
 * User prompts are never cut. Only Claude's answers shrink:
 *   1. older turns' answers, then the latest answer, each down to MIN_KEEP chars (head + tail kept);
 *   2. if still too long, older answers, then the latest answer, are dropped whole.
 * If the prompts alone exceed maxChars the text is returned over budget (see `overBudget`).
 */
export function renderContext({ turns, projectKey, savedAt }, maxChars = 9000) {
  const parts = turns.map((t) => ({
    at: t.at,
    user: t.user,
    answer: itemsToLines(t.items).join('\n'),
  }));
  const build = () =>
    [
      header(projectKey, savedAt, parts.length),
      ...parts.map(
        (p, i) => `\n### 第 ${i + 1} 轮（${formatTime(p.at)}）\n用户：${p.user}\n\nClaude：\n${p.answer || '（无文字回答）'}`
      ),
      FOOTER,
    ].join('\n');

  let text = build();
  if (text.length <= maxChars) return text;

  const MIN_KEEP = 300;
  // older turns first, the latest turn last
  const order = parts.map((_, i) => i);

  for (const i of order) {
    const over = text.length - maxChars;
    if (over <= 0) return text;
    const cur = parts[i].answer;
    const room = cur.length - MIN_KEEP;
    if (room <= 0) continue;
    parts[i].answer = middleTruncate(cur, cur.length - Math.min(room, over + 40));
    text = build();
  }
  for (const i of order) {
    if (text.length <= maxChars) return text;
    parts[i].answer = ANSWER_DROPPED;
    text = build();
  }
  return text;
}

export function overBudget(text, maxChars) {
  return text.length > maxChars;
}

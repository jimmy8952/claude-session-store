import fs from 'node:fs';
import { toolLine, toolTarget } from './compress.js';

export const CONTEXT_MARKER = '<ccstore-context';

const NOT_A_PROMPT_PREFIXES = [
  '<command-',
  '<local-command-',
  '<system-reminder>',
  '<user-prompt-submit-hook>',
  'Caveat:',
  '[Request interrupted',
];

export function parseJsonl(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === 'object') out.push(v);
    } catch {
      // skip a broken line, keep going
    }
  }
  return out;
}

export function readEntries(file) {
  return parseJsonl(fs.readFileSync(file, 'utf8'));
}

/** The branch that ends at the last written record (handles rewinds). */
export function activeChain(entries) {
  const withId = entries.filter((e) => typeof e.uuid === 'string' && !e.isSidechain);
  if (!withId.length) return [];
  const byId = new Map(withId.map((e) => [e.uuid, e]));
  const chain = [];
  const seen = new Set();
  let cur = withId[withId.length - 1];
  while (cur && !seen.has(cur.uuid)) {
    seen.add(cur.uuid);
    chain.push(cur);
    cur = cur.parentUuid ? byId.get(cur.parentUuid) : undefined;
  }
  return chain.reverse();
}

function contentOf(e) {
  return e?.message?.content;
}

export function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

export function hasToolResult(content) {
  return Array.isArray(content) && content.some((b) => b && b.type === 'tool_result');
}

export function isRealPrompt(e) {
  if (!e || e.type !== 'user' || e.isMeta || e.isCompactSummary || e.isVisibleInTranscriptOnly) return false;
  const content = contentOf(e);
  if (hasToolResult(content)) return false;
  const text = textOf(content).trim();
  if (!text) return false;
  if (NOT_A_PROMPT_PREFIXES.some((p) => text.startsWith(p))) return false;
  if (text.includes(CONTEXT_MARKER)) return false;
  return true;
}

export function isSdkSession(chain) {
  return chain.some((e) => typeof e.entrypoint === 'string' && e.entrypoint.startsWith('sdk'));
}

/** Split the active chain into turns: a real prompt plus everything until the next one. */
export function extractTurns(chain) {
  const turns = [];
  let cur = null;
  const toolsById = new Map();
  chain.forEach((e, index) => {
    if (isRealPrompt(e)) {
      cur = {
        promptUuid: e.uuid,
        sessionId: e.sessionId || null,
        at: e.timestamp || null,
        user: textOf(contentOf(e)).trim(),
        items: [],
        startIndex: index,
      };
      turns.push(cur);
      return;
    }
    if (!cur) return;
    const content = contentOf(e);
    if (e.type === 'assistant') {
      const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
      for (const b of blocks) {
        if (!b) continue;
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          cur.items.push({ kind: 'text', text: b.text.trim() });
        } else if (b.type === 'tool_use') {
          const item = {
            kind: 'tool',
            id: b.id,
            name: b.name || 'tool',
            target: toolTarget(b.name, b.input),
            isError: false,
            line: toolLine(b.name || 'tool', b.input),
            input: b.input,
          };
          toolsById.set(b.id, item);
          cur.items.push(item);
        }
      }
    } else if (e.type === 'user' && Array.isArray(content)) {
      for (const b of content) {
        if (b && b.type === 'tool_result' && b.is_error) {
          const item = toolsById.get(b.tool_use_id);
          if (item) {
            item.isError = true;
            item.line = toolLine(item.name, item.input, true);
          }
        }
      }
    }
  });
  // keep stored turns small: the raw tool input is not needed after the line is built
  for (const t of turns) {
    for (const it of t.items) delete it.input;
  }
  return turns;
}

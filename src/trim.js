import { toolLine } from './compress.js';
import { isRealPrompt, parseJsonl } from './transcript.js';

export const TITLE_PREFIX = '[裁剪版·最近';

const MAX_INPUT_STRING = 500;

function shrinkInput(value) {
  if (typeof value === 'string') return value.length > MAX_INPUT_STRING ? `${value.slice(0, MAX_INPUT_STRING)}…[已截断]` : value;
  if (Array.isArray(value)) return value.map(shrinkInput);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = shrinkInput(v);
    return out;
  }
  return value;
}

/** Records of the previous trimmed session, from the prompt `fromPromptUuid` to its end. */
export function segmentFromPrevious(prevJsonl, fromPromptUuid) {
  const records = parseJsonl(prevJsonl).filter((e) => typeof e.uuid === 'string');
  const idx = records.findIndex((e) => e.uuid === fromPromptUuid);
  return idx < 0 ? [] : records.slice(idx);
}

/**
 * Build a resumable session file holding only the kept turns.
 * prevSegment: records carried over from the previous snapshot (may be empty).
 * currentSegment: records of the current chain, starting at its first kept prompt.
 */
export function buildTrimmedJsonl({ prevSegment = [], currentSegment, newSessionId, turns, title }) {
  const records = [...prevSegment, ...currentSegment].map((e) => structuredClone(e));
  if (!records.length) return '';

  // one line per tool call, keyed by tool_use_id
  const lines = new Map();
  for (const e of records) {
    if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
      for (const b of e.message.content) {
        if (b?.type === 'tool_use') lines.set(b.id, { name: b.name, input: b.input });
      }
    }
  }

  let prevUuid = null;
  for (const e of records) {
    e.parentUuid = prevUuid;
    if ('logicalParentUuid' in e) delete e.logicalParentUuid;
    e.sessionId = newSessionId;
    delete e.toolUseResult;
    const content = e.message?.content;
    if (e.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'tool_use') b.input = shrinkInput(b.input);
      }
    }
    if (e.type === 'user' && Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'tool_result') {
          const t = lines.get(b.tool_use_id);
          b.content = t ? toolLine(t.name, t.input, !!b.is_error) : '[工具输出已省略]';
        }
      }
    }
    prevUuid = e.uuid;
  }

  const out = records.map((e) => JSON.stringify(e));
  out.push(
    JSON.stringify({
      type: 'custom-title',
      customTitle: title || `${TITLE_PREFIX}${turns}轮]`,
      sessionId: newSessionId,
    })
  );
  return `${out.join('\n')}\n`;
}

export function trimmedTitle(turnCount, lastPrompt) {
  const p = String(lastPrompt || '').replace(/\s+/g, ' ').trim();
  return `${TITLE_PREFIX}${turnCount}轮] ${p.length > 40 ? `${p.slice(0, 40)}…` : p}`;
}

/** Chain records from the given prompt to the end. */
export function segmentFromChain(chain, fromPromptUuid) {
  const idx = chain.findIndex((e) => e.uuid === fromPromptUuid && isRealPrompt(e));
  return idx < 0 ? [] : chain.slice(idx);
}

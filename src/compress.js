/** Turn a tool call into one short line; tool output itself is never kept. */

export function oneLine(value, max = 120) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function firstString(input) {
  if (!input || typeof input !== 'object') return '';
  for (const v of Object.values(input)) {
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

const FILE_VERBS = {
  Read: '读取了',
  Write: '写入了',
  Edit: '编辑了',
  MultiEdit: '编辑了',
  NotebookEdit: '编辑了',
};

export function fileVerb(name) {
  return FILE_VERBS[name] || null;
}

export function toolTarget(name, input = {}) {
  input = input || {};
  if (FILE_VERBS[name]) return oneLine(input.file_path || input.notebook_path || input.path || '');
  return '';
}

export function toolLine(name, input = {}, isError = false) {
  input = input || {};
  let body;
  if (FILE_VERBS[name]) {
    body = `${FILE_VERBS[name]}文件 ${toolTarget(name, input)}`;
  } else {
    switch (name) {
      case 'Bash':
        body = `运行了 Bash: ${oneLine(input.command)}，输出已省略`;
        break;
      case 'Grep':
      case 'Glob':
        body = `搜索了 ${oneLine(input.pattern)}${input.path ? `（${oneLine(input.path, 60)}）` : ''}`;
        break;
      case 'WebSearch':
        body = `网页搜索: ${oneLine(input.query)}`;
        break;
      case 'WebFetch':
        body = `打开了网页 ${oneLine(input.url)}`;
        break;
      case 'Task':
      case 'Agent':
        body = `派出子任务: ${oneLine(input.description || input.prompt)}`;
        break;
      case 'TodoWrite':
      case 'TaskCreate':
      case 'TaskUpdate':
      case 'TaskList':
      case 'TaskGet':
        body = '更新了任务列表';
        break;
      default: {
        const s = firstString(input);
        body = `调用了 ${name}${s ? `: ${oneLine(s, 80)}` : ''}`;
      }
    }
  }
  return `[${body}${isError ? '（出错）' : ''}]`;
}

/**
 * Render a turn's items to lines. Runs of three or more file operations with the
 * same verb collapse into one line so long read sequences stay short.
 */
export function itemsToLines(items) {
  const out = [];
  let i = 0;
  while (i < items.length) {
    const it = items[i];
    if (it.kind === 'text') {
      out.push(it.text);
      i += 1;
      continue;
    }
    const verb = fileVerb(it.name);
    if (verb && !it.isError) {
      let j = i;
      const targets = [];
      while (j < items.length && items[j].kind === 'tool' && fileVerb(items[j].name) === verb && !items[j].isError) {
        targets.push(items[j].target);
        j += 1;
      }
      if (targets.length >= 3) {
        const shown = targets.slice(0, 5).map((t) => t.split('/').pop()).join(', ');
        out.push(`[${verb} ${targets.length} 个文件: ${shown}${targets.length > 5 ? ' …' : ''}]`);
        i = j;
        continue;
      }
    }
    out.push(it.line);
    i += 1;
  }
  return out;
}

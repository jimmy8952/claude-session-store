import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { itemsToLines, toolLine } from '../src/compress.js';
import { renderContext } from '../src/render.js';
import { activeChain, extractTurns, isRealPrompt, parseJsonl } from '../src/transcript.js';
import { buildTrimmedJsonl, segmentFromChain } from '../src/trim.js';
import { addOurHooks, isOurCommand, stripOurHooks } from '../src/install.js';
import { Transcript } from './helpers.js';

const cwd = '/tmp/proj';

test('turns: tool results, commands, reminders, injected context are not prompts', () => {
  const t = new Transcript({ cwd });
  t.attachment('<ccstore-context project="x">old</ccstore-context>');
  t.user('<ccstore-context project="x">old</ccstore-context>');
  t.turn('第一个问题', '回答一', [['Bash', { command: 'npm test' }]]);
  t.command('/cost');
  t.user('<system-reminder>noise</system-reminder>');
  t.user('[Request interrupted by user]');
  t.turn('第二个问题', '回答二');
  const turns = extractTurns(activeChain(t.records));
  assert.deepEqual(turns.map((x) => x.user), ['第一个问题', '第二个问题']);
  assert.equal(turns[0].items[0].line, '[运行了 Bash: npm test，输出已省略]');
  assert.equal(turns[0].items[1].text, '回答一');
});

test('meta and compact-summary user records are not prompts', () => {
  assert.equal(isRealPrompt({ type: 'user', isMeta: true, message: { content: 'x' } }), false);
  assert.equal(isRealPrompt({ type: 'user', isCompactSummary: true, message: { content: 'x' } }), false);
  assert.equal(isRealPrompt({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } }), true);
});

test('active chain follows the last branch after a rewind and passes through attachments', () => {
  const t = new Transcript({ cwd });
  t.turn('A', 'a');
  const afterA = t.last;
  t.turn('B-abandoned', 'b');
  t.rewindTo(afterA);
  t.attachment('something');
  t.turn('C', 'c');
  const turns = extractTurns(activeChain(t.records));
  assert.deepEqual(turns.map((x) => x.user), ['A', 'C']);
});

test('broken jsonl lines are skipped', () => {
  const out = parseJsonl('{"a":1}\nnot json\n\n{"b":2}');
  assert.equal(out.length, 2);
});

test('tool lines', () => {
  assert.equal(toolLine('Read', { file_path: '/a/b.ts' }), '[读取了文件 /a/b.ts]');
  assert.equal(toolLine('Edit', { file_path: 'x.js' }, true), '[编辑了文件 x.js（出错）]');
  assert.equal(toolLine('WebFetch', { url: 'https://x.dev' }), '[打开了网页 https://x.dev]');
  assert.equal(toolLine('mcp__github__get_issue', { repo: 'a/b', n: 3 }), '[调用了 mcp__github__get_issue: a/b]');
  assert.ok(toolLine('Bash', { command: 'x'.repeat(300) }).includes('…'));
});

test('error results are marked on the tool line', () => {
  const t = new Transcript({ cwd });
  t.user('q');
  t.tool('Bash', { command: 'false' }, 'exit 1', true);
  t.assistantText('done');
  const [turn] = extractTurns(activeChain(t.records));
  assert.equal(turn.items[0].line, '[运行了 Bash: false，输出已省略（出错）]');
});

test('runs of 3+ reads collapse to one line', () => {
  const items = ['a.ts', 'b.ts', 'c.ts'].map((f) => ({ kind: 'tool', name: 'Read', target: `/src/${f}`, line: 'x' }));
  assert.deepEqual(itemsToLines(items), ['[读取了 3 个文件: a.ts, b.ts, c.ts]']);
});

test('render stays under maxChars and shrinks the older answer first', () => {
  const turns = [
    { at: '2026-11-19T06:00:00Z', user: '旧问题', items: [{ kind: 'text', text: '旧'.repeat(8000) }] },
    { at: '2026-11-19T07:00:00Z', user: '新问题', items: [{ kind: 'text', text: '新'.repeat(3000) }] },
  ];
  const text = renderContext({ turns, projectKey: '/p', savedAt: '2026-11-19T07:01:00Z' }, 9000);
  assert.ok(text.length <= 9000, `length ${text.length}`);
  assert.ok(text.startsWith('<ccstore-context'));
  assert.ok(text.endsWith('</ccstore-context>'));
  assert.ok(text.includes('新'.repeat(3000)), 'latest answer kept whole');
  assert.ok(text.includes('中间省略'));
});

test('prompts are never cut; answers are dropped older first when shrinking is not enough', () => {
  const q1 = `Q1-${'问'.repeat(3000)}-END1`;
  const q2 = `Q2-${'问'.repeat(3000)}-END2`;
  const turns = [
    { at: null, user: q1, items: [{ kind: 'text', text: '旧'.repeat(4000) }] },
    { at: null, user: q2, items: [{ kind: 'text', text: '新'.repeat(4000) }] },
  ];
  // room for both prompts plus a little: older answer goes first
  const a = renderContext({ turns, projectKey: '/p', savedAt: null }, 6800);
  assert.ok(a.includes(q1) && a.includes(q2), 'prompts intact');
  assert.ok(a.length <= 6800, `length ${a.length}`);
  assert.ok(a.includes('（回答过长，已省略）'));
  assert.ok(a.indexOf('（回答过长，已省略）') < a.indexOf(q2), 'the older answer is the one dropped');
  assert.ok(a.includes('新'.repeat(100)), 'latest answer still partly there');

  // prompts alone exceed the budget: answers dropped, prompts still whole, over budget allowed
  const b = renderContext({ turns, projectKey: '/p', savedAt: null }, 3000);
  assert.ok(b.includes(q1) && b.includes(q2));
  assert.equal((b.match(/（回答过长，已省略）/g) || []).length, 2);
});

test('trimmed jsonl: relinked chain, new session id, paired compressed tools, title', () => {
  const t = new Transcript({ cwd });
  t.turn('one', 'a1');
  t.turn('two', 'a2', [['Write', { file_path: 'f.txt', content: 'z'.repeat(5000) }]]);
  t.turn('three', 'a3', [['Bash', { command: 'ls' }, 'secret output']]);
  const chain = activeChain(t.records);
  const turns = extractTurns(chain);
  const newId = randomUUID();
  const jsonl = buildTrimmedJsonl({
    currentSegment: segmentFromChain(chain, turns[1].promptUuid),
    newSessionId: newId,
    turns: 2,
    title: '[裁剪版·最近2轮] three',
  });
  const recs = parseJsonl(jsonl);
  const body = recs.filter((r) => r.uuid);
  assert.equal(body[0].parentUuid, null);
  for (let i = 1; i < body.length; i++) assert.equal(body[i].parentUuid, body[i - 1].uuid);
  assert.ok(body.every((r) => r.sessionId === newId));
  assert.ok(!jsonl.includes('secret output'));
  assert.ok(!jsonl.includes('z'.repeat(600)));
  assert.ok(!body.some((r) => 'toolUseResult' in r));
  const uses = body.flatMap((r) => (r.type === 'assistant' ? r.message.content.filter((b) => b.type === 'tool_use').map((b) => b.id) : []));
  const results = body.flatMap((r) => (Array.isArray(r.message?.content) ? r.message.content.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id) : []));
  assert.deepEqual(uses, results);
  assert.deepEqual(extractTurns(activeChain(recs)).map((x) => x.user), ['two', 'three']);
  const title = recs.at(-1);
  assert.equal(title.type, 'custom-title');
  assert.equal(title.customTitle, '[裁剪版·最近2轮] three');
  assert.equal(title.sessionId, newId);
});

test('install merge keeps foreign hooks and strip removes only ours', () => {
  const data = { model: 'x', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } };
  addOurHooks(data, { injectOnClear: false });
  assert.equal(data.hooks.SessionStart.length, 2);
  assert.ok(isOurCommand(data.hooks.SessionEnd[0].hooks[0].command));
  assert.equal(data.hooks.SessionStart[1].matcher, 'startup');
  assert.equal(stripOurHooks(data), 2);
  assert.deepEqual(data, { model: 'x', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } });
});

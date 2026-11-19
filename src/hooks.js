import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { envFlag, loadConfig, log } from './paths.js';
import { projectKey } from './project.js';
import { renderContext } from './render.js';
import { openStore } from './store.js';
import { activeChain, extractTurns, isSdkSession, readEntries } from './transcript.js';
import { buildTrimmedJsonl, segmentFromChain, segmentFromPrevious, trimmedTitle } from './trim.js';

function disabled(cfg) {
  return !cfg.enabled || envFlag('CCSTORE_DISABLE');
}

/** Deletes snapshots older than cfg.maxAgeDays across all projects, together with their trimmed session files. */
export function purgeExpired(store, cfg, days) {
  const cutoff = new Date(Date.now() - (days ?? cfg.maxAgeDays) * 24 * 60 * 60 * 1000).toISOString();
  const rows = store.purgeOlderThan(cutoff);
  let files = 0;
  for (const r of rows) {
    if (r.trimmed_transcript) {
      try {
        fs.unlinkSync(r.trimmed_transcript);
        files++;
      } catch {
        // already gone or never written
      }
    }
  }
  return { rows: rows.length, files };
}

/**
 * Save a snapshot for a finished session. Returns { saved, reason, id? }.
 * Used by the SessionEnd hook and by `ccstore save`.
 */
export function saveSnapshot({ session_id, transcript_path, cwd, reason }, { force = false } = {}) {
  const cfg = loadConfig();
  if (disabled(cfg) && !force) return { saved: false, reason: 'disabled' };
  if (!transcript_path || !fs.existsSync(transcript_path)) return { saved: false, reason: 'no transcript' };

  const entries = readEntries(transcript_path);
  const chain = activeChain(entries);
  if (!chain.length) return { saved: false, reason: 'empty transcript' };
  if (isSdkSession(chain) && !force) return { saved: false, reason: 'non-interactive (sdk) session' };

  const startCwd = cwd || chain.find((e) => e.cwd)?.cwd || process.cwd();
  const key = projectKey(startCwd);
  const turns = extractTurns(chain);
  if (!turns.length) return { saved: false, reason: 'no prompts' };

  const store = openStore();
  try {
    purgeExpired(store, cfg);

    const known = store.knownPromptUuids(key);
    if (!turns.some((t) => !known.has(t.promptUuid))) return { saved: false, reason: 'no new prompts' };

    const N = cfg.turns;
    const kept = turns.slice(-N);
    let carried = [];
    const prev = store.latest(key);
    if (kept.length < N && prev) {
      const mine = new Set(turns.map((t) => t.promptUuid));
      const prevTurns = JSON.parse(prev.turns_json).filter((t) => !mine.has(t.promptUuid));
      carried = prevTurns.slice(-(N - kept.length));
    }
    const all = [...carried, ...kept].map(({ startIndex, ...t }) => t);

    let trimmedSessionId = null;
    let trimmedTranscript = null;
    let trimmedJsonl = null;
    if (cfg.writeTrimmedSession) {
      const prevSegment = carried.length && prev?.trimmed_jsonl ? segmentFromPrevious(prev.trimmed_jsonl, carried[0].promptUuid) : [];
      const currentSegment = segmentFromChain(chain, kept[0].promptUuid);
      trimmedSessionId = randomUUID();
      const turnCount = (prevSegment.length ? carried.length : 0) + kept.length;
      trimmedJsonl = buildTrimmedJsonl({
        prevSegment,
        currentSegment,
        newSessionId: trimmedSessionId,
        turns: turnCount,
        title: trimmedTitle(turnCount, kept[kept.length - 1].user),
      });
      trimmedTranscript = path.join(path.dirname(transcript_path), `${trimmedSessionId}.jsonl`);
      try {
        fs.writeFileSync(trimmedTranscript, trimmedJsonl, { mode: 0o600 });
      } catch (err) {
        log(`could not write trimmed session file: ${err.message}`);
      }
    }

    const promptUuids = [...new Set([...turns.map((t) => t.promptUuid), ...carried.map((t) => t.promptUuid)])];
    const id = store.insert({
      projectKey: key,
      cwd: startCwd,
      sourceSessionId: session_id || path.basename(transcript_path, '.jsonl'),
      sourceTranscript: transcript_path,
      trimmedSessionId,
      trimmedTranscript,
      trimmedJsonl,
      turns: all,
      promptUuids,
      endReason: reason || null,
      claudeVersion: [...chain].reverse().find((e) => e.version)?.version || null,
    });
    store.prune(key, cfg.keepPerProject);
    return { saved: true, id, projectKey: key, turns: all.length, trimmedSessionId };
  } finally {
    store.close();
  }
}

export function sessionEnd(input) {
  const r = saveSnapshot(input);
  log(`SessionEnd ${input.session_id || '?'} (${input.reason || '?'}): ${r.saved ? `saved #${r.id}` : `skipped, ${r.reason}`}`);
  return r;
}

/** Returns the hook's stdout (a JSON string) or null when nothing is injected. */
export function sessionStart(input) {
  const cfg = loadConfig();
  if (disabled(cfg) || envFlag('CCSTORE_FRESH')) return null;
  const allowed = new Set(['startup', ...(cfg.injectOnClear ? ['clear'] : [])]);
  // resume / continue / fork / compact already carry real history: never inject there
  if (!allowed.has(input.source)) return null;
  const key = projectKey(input.cwd || process.cwd());
  const store = openStore();
  try {
    const snap = store.latest(key);
    if (!snap) return null;
    const text = renderContext(
      { turns: JSON.parse(snap.turns_json), projectKey: key, savedAt: snap.created_at },
      cfg.maxChars
    );
    log(
      `SessionStart ${input.session_id || '?'}: injected snapshot #${snap.id} (${text.length} chars)` +
        (text.length > cfg.maxChars ? ` — over maxChars ${cfg.maxChars}: the prompts alone are too long, they are never cut` : '')
    );
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } });
  } finally {
    store.close();
  }
}

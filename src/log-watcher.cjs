/**
 * Tails Claude Code transcript JSONL files (`~/.claude/projects/.../*.jsonl`)
 * and infers current session state from the last conversational entry.
 *
 * Pure functions `inferState` and `splitComplete` are exported for unit
 * testing; the watcher machinery (`startWatching` / `stopWatching` /
 * `stopAll`) wraps them with fs.watch + incremental file reads.
 */

const fs = require("fs");

// transcriptPath -> { chatId, watcher, position, leftover, pending, dirty }
const watchers = new Map();

// Walk the JSONL lines backwards; return { state, model, inputTokens } inferred
// from the conversational entries (user/assistant with a valid content array).
// Entries with unknown `type` (attachment, file-history-snapshot, system,
// permission-mode, last-prompt, queue-operation) are skipped so we don't
// confuse metadata with real activity.
//
// `state` comes from the most recent conversational entry (closest-to-newest wins).
// `model` and `inputTokens` come from the most recent assistant entry with a
// `usage` block — the input-side token count is what the model actually saw
// on the last turn (what matters for deciding when to /compact). Missing values
// are left as null so callers can preserve prior state for that field.
// Returns null only if nothing useful was found.
function inferState(jsonLines) {
  let state = null;
  let model = null;
  let inputTokens = null;
  let lastBlockType = null;

  for (let i = jsonLines.length - 1; i >= 0; i--) {
    let obj;
    try { obj = JSON.parse(jsonLines[i]); } catch { continue; }
    const type = obj && obj.type;
    if (type !== "user" && type !== "assistant") continue;
    const msg = obj.message;
    const content = msg && Array.isArray(msg.content) ? msg.content : null;
    if (!content) continue;

    if (lastBlockType === null && content.length > 0) {
      const last = content[content.length - 1];
      if (last && typeof last.type === "string") lastBlockType = last.type;
    }

    // Only capture model/usage from MAIN-session assistant entries produced
    // by a real Claude model. Skipped:
    //   • `isSidechain: true` — Task/Explore sub-agents with their own context windows.
    //   • `model: "<synthetic>"` (and anything that isn't "claude-*") — Claude Code
    //     inserts synthetic error-message entries that otherwise clobber the
    //     dashboard's window-size lookup → a red flash → a snap back to the
    //     correct color on the next real response.
    if (type === "assistant" && !obj.isSidechain) {
      if (model === null && typeof msg.model === "string" && msg.model.startsWith("claude-")) {
        model = msg.model;
      }
      if (inputTokens === null && msg.usage && typeof msg.usage === "object") {
        const u = msg.usage;
        const input = typeof u.input_tokens === "number" ? u.input_tokens : 0;
        const cc = typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : 0;
        const cr = typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0;
        if (input || cc || cr) inputTokens = input + cc + cr;
      }
    }

    if (state === null) {
      const hasToolUse = content.some((b) => b && b.type === "tool_use");
      const hasToolResult = content.some((b) => b && b.type === "tool_result");
      const hasText = content.some((b) => b && b.type === "text" && typeof b.text === "string" && b.text.trim());
      if (hasToolUse || hasToolResult) state = "working";
      else if (type === "user" && hasText) state = "working";
      else if (type === "assistant" && hasText) state = "done";
    }

    if (state !== null && model !== null && inputTokens !== null && lastBlockType !== null) break;
  }

  if (state === null && model === null && inputTokens === null && lastBlockType === null) return null;
  return { state, model, inputTokens, lastBlockType };
}

// Given any bytes-of-JSONL that may straddle line boundaries, return the
// complete lines and what remains (to be prepended to the next chunk).
function splitComplete(leftover, chunk) {
  const combined = leftover + chunk;
  const lastNewline = combined.lastIndexOf("\n");
  if (lastNewline === -1) return { lines: [], leftover: combined };
  const complete = combined.slice(0, lastNewline);
  const newLeftover = combined.slice(lastNewline + 1);
  const lines = complete.split("\n").filter((l) => l.trim());
  return { lines, leftover: newLeftover };
}

function drain(entry, onStateChange, onError) {
  if (entry.pending) { entry.dirty = true; return; }
  entry.pending = true;
  entry.dirty = false;
  fs.stat(entry.transcriptPath, (err, stat) => {
    if (err) {
      entry.pending = false;
      onError({ chatId: entry.chatId, transcriptPath: entry.transcriptPath, phase: "stat", error: err.message });
      return;
    }
    if (stat.size < entry.position) { entry.position = 0; entry.leftover = ""; }
    if (stat.size === entry.position) {
      entry.pending = false;
      if (entry.dirty) drain(entry, onStateChange, onError);
      return;
    }
    const stream = fs.createReadStream(entry.transcriptPath, { start: entry.position, end: stat.size - 1 });
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("error", (e) => {
      entry.pending = false;
      onError({ chatId: entry.chatId, transcriptPath: entry.transcriptPath, phase: "read", error: e.message });
    });
    stream.on("end", () => {
      entry.position = stat.size;
      const chunk = Buffer.concat(chunks).toString("utf8");
      const split = splitComplete(entry.leftover, chunk);
      entry.leftover = split.leftover;
      if (split.lines.length) {
        try {
          const update = inferState(split.lines);
          if (update) {
            if (entry.initialRead) {
              entry.initialRead = false;
              onStateChange(entry.chatId, { state: null, model: update.model, inputTokens: update.inputTokens, lastBlockType: update.lastBlockType });
            } else {
              onStateChange(entry.chatId, update);
            }
          }
        } catch (e) {
          onError({ chatId: entry.chatId, transcriptPath: entry.transcriptPath, phase: "infer", error: e.message });
        }
      }
      entry.pending = false;
      if (entry.dirty) drain(entry, onStateChange, onError);
    });
  });
}

function startWatching(chatId, transcriptPath, onStateChange, onError) {
  if (typeof transcriptPath !== "string" || !transcriptPath) return;
  const existing = watchers.get(transcriptPath);
  if (existing) { existing.chatId = chatId; return; }

  // Leave position at 0 so the initial drain reads any pre-existing content —
  // needed on widget restart or session resume, where the transcript already
  // has usage/model data we want to surface immediately. The `initialRead`
  // flag suppresses the inferred *state* from that first drain: the hook owns
  // the current state (e.g. `idle` on SessionStart), while the transcript's
  // last assistant text would otherwise derive `done` from prior activity.
  const entry = { chatId, transcriptPath, position: 0, leftover: "", watcher: null, pending: false, dirty: false, initialRead: true };

  try {
    fs.statSync(transcriptPath);
  } catch (err) {
    onError({ chatId, transcriptPath, phase: "initial-stat", error: err.message, code: err.code });
    return;
  }

  try {
    entry.watcher = fs.watch(transcriptPath, (eventType) => {
      if (eventType === "change") drain(entry, onStateChange, onError);
    });
    entry.watcher.on("error", (err) => {
      onError({ chatId: entry.chatId, transcriptPath, phase: "watch", error: err.message });
    });
  } catch (err) {
    onError({ chatId, transcriptPath, phase: "watch-init", error: err.message });
    return;
  }

  watchers.set(transcriptPath, entry);
  drain(entry, onStateChange, onError);
}

function stopWatching(transcriptPath) {
  const entry = watchers.get(transcriptPath);
  if (!entry) return;
  if (entry.watcher) {
    try { entry.watcher.close(); } catch {}
  }
  watchers.delete(transcriptPath);
}

function stopAll() {
  for (const entry of watchers.values()) {
    try { entry.watcher && entry.watcher.close(); } catch {}
  }
  watchers.clear();
}

// Merge a watcher `update` into an `existing` chat row, returning { next, changed }.
// Pure function — no side effects, no Date.now() call (caller sets .updated if wanted).
// The `now` parameter is injectable for test determinism.
//
// Policy: watcher can only transition state to "working". Other terminal
// states (done/idle/awaiting/error) are hook-authoritative. The watcher
// often reads text-in-flight as "done" before the Stop hook fires — allowing
// that downgrade would flip rows back to done during fresh turns.
const WATCHER_ALLOWED_TRANSITIONS = new Set(["working"]);

function mergeWatcherUpdate(existing, update, now = Date.now()) {
  const next = { ...existing };
  let changed = false;
  if (
    update.state &&
    WATCHER_ALLOWED_TRANSITIONS.has(update.state) &&
    existing.status !== update.state
  ) {
    next.status = update.state;
    next.statusChangedAt = now;
    changed = true;
  }
  if (update.model && existing.model !== update.model) {
    next.model = update.model;
    changed = true;
  }
  if (typeof update.inputTokens === "number" && existing.inputTokens !== update.inputTokens) {
    next.inputTokens = update.inputTokens;
    changed = true;
  }
  return { next, changed };
}

module.exports = { startWatching, stopWatching, stopAll, inferState, splitComplete, mergeWatcherUpdate };

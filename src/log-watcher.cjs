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

// Walk the JSONL lines backwards; return state inferred from the last
// conversational entry (user/assistant with a valid content array). Entries
// with unknown `type` (attachment, file-history-snapshot, system,
// permission-mode, last-prompt, queue-operation) are skipped so we don't
// confuse metadata with real activity. Returns null if no decision is possible.
function inferState(jsonLines) {
  for (let i = jsonLines.length - 1; i >= 0; i--) {
    let obj;
    try { obj = JSON.parse(jsonLines[i]); } catch { continue; }
    const type = obj && obj.type;
    if (type !== "user" && type !== "assistant") continue;
    const msg = obj.message;
    const content = msg && Array.isArray(msg.content) ? msg.content : null;
    if (!content) continue;
    const hasToolUse = content.some((b) => b && b.type === "tool_use");
    const hasToolResult = content.some((b) => b && b.type === "tool_result");
    const hasText = content.some((b) => b && b.type === "text" && typeof b.text === "string" && b.text.trim());
    if (hasToolUse || hasToolResult) return "working";
    if (type === "user" && hasText) return "working";
    if (type === "assistant" && hasText) return "done";
  }
  return null;
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
          const state = inferState(split.lines);
          if (state) onStateChange(entry.chatId, state);
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

  const entry = { chatId, transcriptPath, position: 0, leftover: "", watcher: null, pending: false, dirty: false };

  try {
    entry.position = fs.statSync(transcriptPath).size;
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

module.exports = { startWatching, stopWatching, stopAll, inferState, splitComplete };

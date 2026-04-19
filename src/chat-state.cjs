/**
 * Pure helpers for chat-state merging from /api/status POSTs.
 *
 * `originalPrompt` is the sticky label for the current task — the user's
 * last substantive prompt. It survives awaiting / error cycles and short
 * continuation inputs like "y", and it also survives a `done` so the
 * just-finished row still shows what the task was (not a stale awaiting
 * label like "needs approval: Bash"). Only `idle` clears it; the next
 * `working` after `done`/`idle` replaces it with the new prompt.
 */

function nextOriginalPrompt(existing, msg) {
  if (msg.status === "idle") return undefined;
  const prev = existing ? existing.originalPrompt : undefined;
  if (msg.status === "working" && typeof msg.label === "string" && msg.label.trim()) {
    const prevStatus = existing ? existing.status : null;
    // Set on fresh chats, on done/idle → working boundaries, and whenever
    // the prompt is not yet recorded — the watcher can promote a row to
    // `working` before the hook's UserPromptSubmit POST lands, so the hook
    // must still be able to populate an empty slot.
    if (!prev || prevStatus === "done" || prevStatus === "idle") {
      return msg.label;
    }
  }
  return prev;
}

module.exports = { nextOriginalPrompt };

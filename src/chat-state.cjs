/**
 * Pure helpers for chat-state merging from /api/status POSTs.
 *
 * `originalPrompt` is the sticky label for the current task — the user's
 * last substantive prompt, preserved across intra-task awaiting/error
 * cycles and short continuation inputs like "y". Cleared on task-boundary
 * states (done/idle) so the next `working` starts a fresh task.
 */

function nextOriginalPrompt(existing, msg) {
  if (msg.status === "done" || msg.status === "idle") return undefined;
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

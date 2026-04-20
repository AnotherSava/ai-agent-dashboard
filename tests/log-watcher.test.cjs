const { test } = require("node:test");
const assert = require("node:assert");
const { inferState, splitComplete, mergeWatcherUpdate } = require("../src/log-watcher.cjs");

const userText = (text) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
const assistantText = (text) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const assistantToolUse = () => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Read" }] } });
const userToolResult = () => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } });
const meta = (type) => JSON.stringify({ type });
const assistantWithUsage = (model, input, cc, cr) => JSON.stringify({
  type: "assistant",
  message: {
    role: "assistant",
    model,
    content: [{ type: "text", text: "answer" }],
    usage: { input_tokens: input, cache_creation_input_tokens: cc, cache_read_input_tokens: cr },
  },
});

test("inferState: user text → working", () => {
  assert.equal(inferState([userText("hello")]).state, "working");
});

test("inferState: assistant tool_use → working", () => {
  assert.equal(inferState([assistantToolUse()]).state, "working");
});

test("inferState: user tool_result → working", () => {
  assert.equal(inferState([userToolResult()]).state, "working");
});

test("inferState: assistant text only → done", () => {
  assert.equal(inferState([assistantText("here you go")]).state, "done");
});

test("inferState: skips trailing metadata to find last conversational", () => {
  assert.equal(
    inferState([assistantText("hi"), meta("permission-mode"), meta("last-prompt")]).state,
    "done",
  );
});

test("inferState: tool_use wins over later metadata", () => {
  assert.equal(inferState([assistantToolUse(), meta("file-history-snapshot")]).state, "working");
});

test("inferState: returns null when no conversational entry", () => {
  assert.equal(inferState([meta("permission-mode"), meta("last-prompt")]), null);
});

test("inferState: malformed JSON lines are skipped", () => {
  assert.equal(inferState([assistantToolUse(), "{ not json }"]).state, "working");
});

test("inferState: empty assistant text doesn't register as done", () => {
  const emptyAssistant = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "   " }] } });
  assert.equal(inferState([emptyAssistant]).state, null);
});

test("inferState: extracts model and summed input-side tokens from assistant usage", () => {
  const r = inferState([assistantWithUsage("claude-opus-4-7", 100, 2000, 40000)]);
  assert.equal(r.state, "done");
  assert.equal(r.model, "claude-opus-4-7");
  assert.equal(r.inputTokens, 42100);
});

test("inferState: state from newest entry, model/tokens from older assistant turn", () => {
  const r = inferState([assistantWithUsage("claude-opus-4-7", 10, 0, 500), userText("follow-up")]);
  assert.equal(r.state, "working");
  assert.equal(r.model, "claude-opus-4-7");
  assert.equal(r.inputTokens, 510);
});

test("inferState: assistant entry without usage leaves tokens/model null", () => {
  const r = inferState([assistantText("hi")]);
  assert.equal(r.state, "done");
  assert.equal(r.model, null);
  assert.equal(r.inputTokens, null);
});

test("inferState: synthetic assistant entry is ignored for model", () => {
  const synthetic = JSON.stringify({
    type: "assistant",
    isSidechain: false,
    message: {
      role: "assistant",
      model: "<synthetic>",
      content: [{ type: "text", text: "api error" }],
      usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  });
  const main = assistantWithUsage("claude-opus-4-7", 100, 2000, 40000);
  const r = inferState([main, synthetic]);
  assert.equal(r.model, "claude-opus-4-7");
  assert.equal(r.inputTokens, 42100);
});

test("inferState: sidechain assistant entry is ignored for model/tokens", () => {
  const sidechain = JSON.stringify({
    type: "assistant",
    isSidechain: true,
    message: {
      role: "assistant",
      model: "claude-haiku-4-5",
      content: [{ type: "text", text: "sub-agent answer" }],
      usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 500 },
    },
  });
  const main = assistantWithUsage("claude-opus-4-7", 100, 2000, 40000);
  // main entry is older, sidechain is newest — main's values must still win
  const r = inferState([main, sidechain]);
  assert.equal(r.model, "claude-opus-4-7");
  assert.equal(r.inputTokens, 42100);
});

test("inferState: partial usage — missing cache fields default to 0", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: { role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 50 } },
  });
  const r = inferState([line]);
  assert.equal(r.inputTokens, 50);
  assert.equal(r.model, "claude-sonnet-4-6");
});

test("splitComplete: partial line becomes leftover, no complete lines", () => {
  const r = splitComplete("", "no newline yet");
  assert.deepEqual(r.lines, []);
  assert.equal(r.leftover, "no newline yet");
});

test("splitComplete: joins leftover with next chunk", () => {
  const r = splitComplete("par", "tial\ncomplete\n");
  assert.deepEqual(r.lines, ["partial", "complete"]);
  assert.equal(r.leftover, "");
});

test("splitComplete: last trailing line without newline stays as leftover", () => {
  const r = splitComplete("", "one\ntwo\npart");
  assert.deepEqual(r.lines, ["one", "two"]);
  assert.equal(r.leftover, "part");
});

test("splitComplete: empty-lines-between-content are dropped", () => {
  const r = splitComplete("", "a\n\nb\n");
  assert.deepEqual(r.lines, ["a", "b"]);
  assert.equal(r.leftover, "");
});

test("splitComplete: empty chunk and empty leftover", () => {
  const r = splitComplete("", "");
  assert.deepEqual(r.lines, []);
  assert.equal(r.leftover, "");
});

// Transcript edge cases that drive state derivation across turn boundaries.
// These specifically exercise the race where a fresh turn appears in the
// transcript before the UserPromptSubmit hook's POST arrives at the widget.

test("inferState: past assistant text + new user text — newest wins (working)", () => {
  // Simulates: prior response completed, user just submitted a new prompt.
  assert.equal(inferState([assistantText("previous answer"), userText("new prompt")]).state, "working");
});

test("inferState: user text followed by partial assistant text returns done", () => {
  // Simulates the race: Claude started streaming a response while the
  // UserPromptSubmit hook was still in flight. inferState sees the partial
  // assistant text and classifies as done — which is why the widget must NOT
  // treat this as authoritative (see mergeWatcherUpdate tests below).
  assert.equal(inferState([userText("go"), assistantText("starting...")]).state, "done");
});

test("inferState: tool_use after text — tool_use wins (working)", () => {
  assert.equal(inferState([userText("do X"), assistantText("ok"), assistantToolUse()]).state, "working");
});

test("inferState: lastBlockType reflects newest content block", () => {
  const thinking = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "…" }] } });
  assert.equal(inferState([thinking]).lastBlockType, "thinking");
  assert.equal(inferState([assistantToolUse()]).lastBlockType, "tool_use");
  assert.equal(inferState([userText("hi")]).lastBlockType, "text");
});

// mergeWatcherUpdate: the watcher-to-widget state policy. Watcher can upgrade
// to working; hooks own done/idle/awaiting/error.

test("mergeWatcherUpdate: upgrades done → working", () => {
  const { next, changed } = mergeWatcherUpdate(
    { status: "done", model: null, inputTokens: null },
    { state: "working" },
    1000,
  );
  assert.equal(next.status, "working");
  assert.equal(next.statusChangedAt, 1000);
  assert.equal(changed, true);
});

test("mergeWatcherUpdate: does NOT downgrade working → done (the race-fix)", () => {
  const { next, changed } = mergeWatcherUpdate(
    { status: "working", model: null, inputTokens: null },
    { state: "done" },
  );
  assert.equal(next.status, "working");
  assert.equal(changed, false);
});

test("mergeWatcherUpdate: does NOT override awaiting (hook-authoritative)", () => {
  const { next, changed } = mergeWatcherUpdate(
    { status: "awaiting" },
    { state: "done" },
  );
  assert.equal(next.status, "awaiting");
  assert.equal(changed, false);
});

test("mergeWatcherUpdate: error → working IS allowed (working is watcher-allowed)", () => {
  // The allow-list checks the INCOMING state, not the existing one. Any existing
  // state can be promoted to working by the watcher (e.g. Claude recovered
  // from error and a tool_use appeared in the transcript).
  const { next, changed } = mergeWatcherUpdate(
    { status: "error" },
    { state: "working" },
  );
  assert.equal(next.status, "working");
  assert.equal(changed, true);
});

test("mergeWatcherUpdate: ignores null state (initial-read case)", () => {
  const { next, changed } = mergeWatcherUpdate(
    { status: "idle", model: null, inputTokens: null },
    { state: null, model: "claude-opus-4-7", inputTokens: 500 },
  );
  assert.equal(next.status, "idle");
  assert.equal(next.model, "claude-opus-4-7");
  assert.equal(next.inputTokens, 500);
  assert.equal(changed, true);
});

test("mergeWatcherUpdate: no-op when everything matches", () => {
  const { changed } = mergeWatcherUpdate(
    { status: "working", model: "claude-opus-4-7", inputTokens: 100 },
    { state: "working", model: "claude-opus-4-7", inputTokens: 100 },
  );
  assert.equal(changed, false);
});

test("mergeWatcherUpdate: model-only change counts as change", () => {
  const { next, changed } = mergeWatcherUpdate(
    { status: "working", model: null, inputTokens: 100 },
    { state: null, model: "claude-sonnet-4-6", inputTokens: 100 },
  );
  assert.equal(next.model, "claude-sonnet-4-6");
  assert.equal(changed, true);
});

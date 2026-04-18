const { test } = require("node:test");
const assert = require("node:assert");
const { inferState, splitComplete } = require("../src/log-watcher.cjs");

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
  assert.equal(inferState([emptyAssistant]), null);
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

const { test } = require("node:test");
const assert = require("node:assert");
const { inferState, splitComplete } = require("../src/log-watcher.cjs");

const userText = (text) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
const assistantText = (text) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const assistantToolUse = () => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Read" }] } });
const userToolResult = () => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } });
const meta = (type) => JSON.stringify({ type });

test("inferState: user text → working", () => {
  assert.equal(inferState([userText("hello")]), "working");
});

test("inferState: assistant tool_use → working", () => {
  assert.equal(inferState([assistantToolUse()]), "working");
});

test("inferState: user tool_result → working", () => {
  assert.equal(inferState([userToolResult()]), "working");
});

test("inferState: assistant text only → done", () => {
  assert.equal(inferState([assistantText("here you go")]), "done");
});

test("inferState: skips trailing metadata to find last conversational", () => {
  assert.equal(
    inferState([assistantText("hi"), meta("permission-mode"), meta("last-prompt")]),
    "done",
  );
});

test("inferState: tool_use wins over later metadata", () => {
  assert.equal(inferState([assistantToolUse(), meta("file-history-snapshot")]), "working");
});

test("inferState: returns null when no conversational entry", () => {
  assert.equal(inferState([meta("permission-mode"), meta("last-prompt")]), null);
});

test("inferState: malformed JSON lines are skipped", () => {
  assert.equal(inferState([assistantToolUse(), "{ not json }"]), "working");
});

test("inferState: empty assistant text doesn't register as done", () => {
  const emptyAssistant = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "   " }] } });
  assert.equal(inferState([emptyAssistant]), null);
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

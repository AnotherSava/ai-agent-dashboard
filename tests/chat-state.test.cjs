const { test } = require("node:test");
const assert = require("node:assert");
const { nextOriginalPrompt } = require("../src/chat-state.cjs");

const make = (status, originalPrompt) => ({ status, originalPrompt });

test("fresh chat + working + label → sets originalPrompt", () => {
  assert.equal(nextOriginalPrompt(null, { status: "working", label: "fix the bug" }), "fix the bug");
});

test("fresh chat + working + no label → stays undefined", () => {
  assert.equal(nextOriginalPrompt(null, { status: "working" }), undefined);
});

test("fresh chat + working + whitespace-only label → stays undefined", () => {
  assert.equal(nextOriginalPrompt(null, { status: "working", label: "   " }), undefined);
});

test("fresh chat + awaiting + label → stays undefined (only working populates)", () => {
  assert.equal(nextOriginalPrompt(null, { status: "awaiting", label: "has a question" }), undefined);
});

test("done → working + label → replaces (new task boundary)", () => {
  assert.equal(
    nextOriginalPrompt(make("done", undefined), { status: "working", label: "next task" }),
    "next task",
  );
});

test("idle → working + label → replaces (new task boundary)", () => {
  assert.equal(
    nextOriginalPrompt(make("idle", undefined), { status: "working", label: "first task" }),
    "first task",
  );
});

test("awaiting → working + 'y' → preserves original (the core fix)", () => {
  assert.equal(
    nextOriginalPrompt(make("awaiting", "big task"), { status: "working", label: "y" }),
    "big task",
  );
});

test("error → working + label → preserves original (retry keeps task context)", () => {
  assert.equal(
    nextOriginalPrompt(make("error", "big task"), { status: "working", label: "retry" }),
    "big task",
  );
});

test("working → working + new label → preserves (no boundary crossed)", () => {
  assert.equal(
    nextOriginalPrompt(make("working", "task A"), { status: "working", label: "task B" }),
    "task A",
  );
});

test("thinking → working + label → preserves (no boundary crossed)", () => {
  assert.equal(
    nextOriginalPrompt(make("thinking", "task A"), { status: "working", label: "task B" }),
    "task A",
  );
});

test("working (no originalPrompt yet) + working + label → sets it", () => {
  // Watcher can promote to working before the hook's UserPromptSubmit lands,
  // leaving originalPrompt empty. The hook's follow-up POST must still fill it.
  assert.equal(
    nextOriginalPrompt(make("working", undefined), { status: "working", label: "hook-provided prompt" }),
    "hook-provided prompt",
  );
});

test("any status → done → clears originalPrompt", () => {
  assert.equal(nextOriginalPrompt(make("working", "big task"), { status: "done" }), undefined);
  assert.equal(nextOriginalPrompt(make("awaiting", "big task"), { status: "done" }), undefined);
  assert.equal(nextOriginalPrompt(make("error", "big task"), { status: "done" }), undefined);
});

test("any status → idle → clears originalPrompt", () => {
  assert.equal(nextOriginalPrompt(make("working", "big task"), { status: "idle" }), undefined);
  assert.equal(nextOriginalPrompt(make("awaiting", "big task"), { status: "idle" }), undefined);
});

test("awaiting → awaiting (notification refresh) → preserves original", () => {
  assert.equal(
    nextOriginalPrompt(make("awaiting", "big task"), { status: "awaiting", label: "needs approval: Bash" }),
    "big task",
  );
});

test("error → error → preserves original", () => {
  assert.equal(
    nextOriginalPrompt(make("error", "big task"), { status: "error", label: "..." }),
    "big task",
  );
});

test("full approval cycle: done → working → awaiting → working('y') → done", () => {
  // Fresh chat (simulating SessionStart with idle as prev).
  let chat = make("idle", undefined);

  // 1. User submits prompt.
  let prompt = nextOriginalPrompt(chat, { status: "working", label: "implement feature X" });
  chat = { status: "working", originalPrompt: prompt };
  assert.equal(chat.originalPrompt, "implement feature X");

  // 2. Claude needs permission.
  prompt = nextOriginalPrompt(chat, { status: "awaiting", label: "needs approval: Bash" });
  chat = { status: "awaiting", originalPrompt: prompt };
  assert.equal(chat.originalPrompt, "implement feature X");

  // 3. User types "y".
  prompt = nextOriginalPrompt(chat, { status: "working", label: "y" });
  chat = { status: "working", originalPrompt: prompt };
  assert.equal(chat.originalPrompt, "implement feature X");

  // 4. Task finishes.
  prompt = nextOriginalPrompt(chat, { status: "done" });
  chat = { status: "done", originalPrompt: prompt };
  assert.equal(chat.originalPrompt, undefined);

  // 5. New task starts.
  prompt = nextOriginalPrompt(chat, { status: "working", label: "next feature" });
  assert.equal(prompt, "next feature");
});

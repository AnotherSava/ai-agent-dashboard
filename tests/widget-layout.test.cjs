/**
 * Regression tests for widget layout invariants.
 *
 * These are text-based checks against `src/widget.html` — not a real layout
 * engine (no JSDOM, no Playwright). They lock in the specific CSS rules and
 * DOM structure that have been broken and rebuilt multiple times. Each test
 * documents a concrete past bug so future-you knows what breaks if it fails.
 */

const fs = require("fs");
const path = require("path");
const { test } = require("node:test");
const assert = require("node:assert");

const WIDGET_HTML = fs.readFileSync(path.join(__dirname, "..", "src", "widget.html"), "utf8");

function ruleBody(css, selector) {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}");
  const m = css.match(re);
  return m ? m[1] : null;
}

test("layout: .chat is display: grid (no flex fallback — label never sits inline with name)", () => {
  // The only two layouts are both grid-based. Label is never on the same row as name.
  const body = ruleBody(WIDGET_HTML, ".chat");
  assert(body, "no .chat rule found");
  assert.match(body, /display:\s*grid/);
  assert.doesNotMatch(body, /flex-wrap:\s*wrap/);
});

test("layout: no .chat.inline-label rule exists (label never inlined with name)", () => {
  // Past iteration: there was a flex-based inline mode where label sat next to
  // name on line 1. User clarified: prompt should NEVER share a line with name.
  assert.doesNotMatch(WIDGET_HTML, /\.chat\.inline-label\b/, "inline-label mode was removed — label always below name");
});

test("layout (default): .chat-label occupies column 1 of row 2 only", () => {
  // Default = short label. Label sits in column 1, leaving column 2 for the
  // state cluster (which spans both rows via align-self: center).
  const body = ruleBody(WIDGET_HTML, ".chat-label");
  assert(body, "no .chat-label rule found");
  assert.match(body, /grid-column:\s*1\b/);
  assert.match(body, /grid-row:\s*2/);
  assert.doesNotMatch(body, /grid-column:\s*1\s*\/\s*-1/, "default label must NOT span both columns — that's the wrap-label override only");
});

test("layout (wrap): .chat.wrap-label .chat-label spans both columns on row 2", () => {
  // Wrap mode = long label. It takes over row 2 entirely, and the state cluster
  // has to move up (see next test).
  const body = ruleBody(WIDGET_HTML, ".chat.wrap-label .chat-label");
  assert(body, "no .chat.wrap-label .chat-label rule found");
  assert.match(body, /grid-column:\s*1\s*\/\s*-1/);
});

test("layout (default): .chat-right spans rows 1–2, vertically centered", () => {
  // Default: state cluster is centered vertically across both rows. Use
  // `1 / span 2` — `1 / -1` does NOT span implicit rows without grid-template-rows.
  const body = ruleBody(WIDGET_HTML, ".chat-right");
  assert(body, "no .chat-right rule found");
  assert.match(body, /grid-column:\s*2/);
  assert.match(body, /grid-row:\s*1\s*\/\s*span\s*2/);
  assert.match(body, /align-self:\s*center/);
});

test("layout (wrap): .chat.wrap-label .chat-right is on row 1 only", () => {
  // Wrap: state cluster vacates row 2 (label takes it), stays on row 1.
  const body = ruleBody(WIDGET_HTML, ".chat.wrap-label .chat-right");
  assert(body, "no .chat.wrap-label .chat-right rule found");
  assert.match(body, /grid-row:\s*1\b/);
});

test("makeChat wraps badge + chat-tail + context-tokens in a .chat-right container", () => {
  // Past bug: badge/tail/tokens were separate flex children of .chat, which
  // prevented treating them as a single vertically-centered unit and broke
  // grid layout when chat-right was referenced in CSS.
  const fn = WIDGET_HTML.match(/function makeChat\b[\s\S]*?\n\}/);
  assert(fn, "makeChat function not found");
  const body = fn[0];
  assert.match(body, /className\s*=\s*['"]chat-right['"]/, "chat-right wrapper must be created");

  // badge, tail, tokens must be appended to the right-cluster container,
  // NOT directly to the outer chat row.
  const badgeAppend = body.match(/(\w+)\.appendChild\(badge\)/);
  assert(badgeAppend, "badge must be appended to something");
  assert.notStrictEqual(badgeAppend[1], "el", "badge must be appended to chat-right, not to .chat directly");

  const tailAppend = body.match(/(\w+)\.appendChild\(tail\)/);
  assert(tailAppend, "tail must be appended to something");
  assert.notStrictEqual(tailAppend[1], "el", "tail must be appended to chat-right, not to .chat directly");
});

test("makeChat appends chat-label after the state cluster (so grid-row: 2 is reachable)", () => {
  // Label must be a direct child of .chat (row 2), not nested inside chat-right.
  const fn = WIDGET_HTML.match(/function makeChat\b[\s\S]*?\n\}/);
  assert(fn);
  const body = fn[0];
  const labelAppend = body.match(/(\w+)\.appendChild\(lbl\)/);
  assert(labelAppend, "label (lbl) must be appended");
  assert.strictEqual(labelAppend[1], "el", "label must be appended to the outer .chat element to land in grid row 2");
});

test("adjustLabelWraps: toggles wrap-label via shouldWrapLabel (pixel-measurement)", () => {
  const fn = WIDGET_HTML.match(/function adjustLabelWraps\b[\s\S]*?\n\}/);
  assert(fn, "adjustLabelWraps function not found");
  const body = fn[0];
  assert.match(body, /classList\.toggle\(['"]wrap-label['"].*shouldWrapLabel/);
  assert.doesNotMatch(body, /inline-label/, "inline-label class was removed — must not appear in the toggle logic");
});

test("shouldWrapLabel: wrap iff label width > (content − state − 1 gap)", () => {
  // The criterion: label fits in column 1 of the grid IF its natural pixel
  // width is less than or equal to (content width − state cluster width − 1 column gap).
  // Only ONE gap here — the column-gap between col 1 (label) and col 2 (state).
  const fn = WIDGET_HTML.match(/function shouldWrapLabel\b[\s\S]*?\n\}/);
  assert(fn, "shouldWrapLabel function not found");
  const body = fn[0];
  assert.match(body, /measureLabelWidth\(/);
  assert.match(body, /right\.offsetWidth/, "must subtract state cluster width");
  assert.match(body, /chatEl\.clientWidth/);
  assert.match(body, /measureLabelWidth\([^)]*\)\s*>\s*col1Available/, "return condition must be label width > col 1 available");
});

test("measureTextWidth: canvas-based, font per call", () => {
  assert.match(WIDGET_HTML, /_measureCtx\s*=\s*_measureCanvas\.getContext\(['"]2d['"]\)/);
  assert.match(WIDGET_HTML, /const LABEL_FONT\s*=\s*["'][^"']*9px[^"']*["']/);
  const fn = WIDGET_HTML.match(/function measureTextWidth\b[\s\S]*?\n\}/);
  assert(fn, "measureTextWidth function not found");
  assert.match(fn[0], /_measureCtx\.font\s*=\s*font/);
  assert.match(fn[0], /_measureCtx\.measureText/);
});

test("resize listener re-runs adjustLabelWraps on window resize", () => {
  // Widget is resizable. The threshold depends on actual content width, so
  // the layout must re-evaluate when the window resizes.
  assert.match(WIDGET_HTML, /window\.addEventListener\(['"]resize['"],\s*adjustLabelWraps\)/);
});

test("JS state policy: mergeWatcherUpdate exists and is wired into widget.cjs", () => {
  // Past bug: the log-watcher's derived "done" would race with the UserPromptSubmit
  // hook and downgrade a fresh working row back to done. The fix lives in
  // log-watcher's mergeWatcherUpdate — make sure widget.cjs still calls it.
  const widgetCjs = fs.readFileSync(path.join(__dirname, "..", "src", "widget.cjs"), "utf8");
  assert.match(widgetCjs, /mergeWatcherUpdate/, "widget.cjs must delegate watcher updates through mergeWatcherUpdate (otherwise watcher-downgrade bug returns)");
});

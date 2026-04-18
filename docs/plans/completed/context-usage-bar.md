# Context-usage bar for the dashboard

## Context

The dashboard currently shows per-chat status (`idle | working | thinking | done | error`) but gives the user no signal about how full the conversation's context window is — which is exactly the moment where `/compact` or `/clear` matters most. Claude Code's transcript JSONL already carries this data on every assistant turn (`message.model` + `message.usage`), and `src/log-watcher.cjs` already tails that file.

Goal: surface current context usage as a vertical bar on the far-right of each chat row. Bar height = percent used (0% bottom → 100% top). Bar color interpolates between user-defined threshold colors in config. Both the model→window-size map and the threshold→color map live in `config/config.json` so they can be tuned without code changes.

## Design

### 1. Config extension

Add two fields to `config/config.example.json` (and merge into `loadConfig` defaults in `src/widget.cjs:16-25`):

```json
{
  "widget_url": "http://127.0.0.1:9077/api/status",
  "projects_root": "d:/projects",
  "show_source_icon": true,
  "context_window_tokens": {
    "claude-opus-4-7":    1000000,
    "claude-sonnet-4-6":  1000000,
    "claude-haiku-4-5":    200000,
    "default":             200000
  },
  "context_bar_thresholds": {
    "0":  "#3fb950",
    "60": "#f0883e",
    "85": "#f85149"
  }
}
```

Both maps are plain JSON, no schema validation beyond the existing `{...defaults, ...loaded}` merge. Defaults assume the 1M-context variant where the model family offers one (Opus 4.7, Sonnet 4.6); Haiku stays at 200k. Users running the standard (non-`[1m]`) Opus/Sonnet can drop those entries to `200000` in their own `config.json`. Missing model → fall back to `default` (200k, the conservative choice).

### 2. Log-watcher extension (`src/log-watcher.cjs`)

Today `inferState` returns a bare state string. Extend the reverse-walk loop at `src/log-watcher.cjs:20-37` to also capture the model + input-side token count from the most recent `assistant` entry that has a `usage` block.

- Change `inferState` to return `{ state, model, inputTokens } | null` (state may still be null if no conversational entry found; model/tokens may be null if no assistant turn has usage yet).
- `inputTokens = usage.input_tokens + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0)` — this is what the model actually saw on the last turn, which is what the user cares about for "should I compact?".
- Update the unit tests in `tests/` to cover the new return shape.

Propagate through the `drain` callback. Change `onStateChange(chatId, state)` signature at `src/log-watcher.cjs:82` to `onStateChange(chatId, update)` where `update = { state, model, inputTokens }`. Update the one caller in `src/widget.cjs` (the `onWatcherStateChange` function noted at ~`src/widget.cjs:46-52`) to merge model/tokens into the chat object even when state is unchanged.

### 3. Chat object + SSE broadcast (`src/widget.cjs`)

Extend the chat shape stored in the `chats` Map:

```js
{ id, status, label, source, updated, transcript_path, model?, inputTokens? }
```

No changes needed to `broadcast()` — it already serializes the full chat object, so the new fields flow to SSE clients automatically. No changes needed to the hook POST path (`claude_hook.py` stays as-is); context data arrives purely via the log-watcher.

### 4. Renderer (`src/widget.html`)

**DOM** — In `makeChat()` (around `src/widget.html:513-560`), append a `.context-bar` element as the last flex child of the chat row, after `.chat-close`:

```html
<div class="context-bar" title="{pct}% of {window} tokens"><div class="context-bar-fill"></div></div>
```

**CSS** — new rule:
```css
.context-bar {
  width: 3px;
  height: 100%;
  align-self: stretch;
  background: #21262d;
  border-radius: 2px;
  flex-shrink: 0;
  overflow: hidden;
  position: relative;
}
.context-bar-fill {
  position: absolute;
  left: 0; right: 0; bottom: 0;
  background: var(--ctx-color, #3fb950);
  height: 0%;
  transition: height 0.3s ease, background 0.3s ease;
}
```

The fill grows from bottom up. Color is set inline per-row via `style="--ctx-color: rgb(r,g,b); height: N%"` computed in the renderer.

**Gradient logic** — add a small helper in the renderer script (where `SOURCE_LABELS` lives):

```js
function contextColor(pct, thresholds) {
  const stops = Object.entries(thresholds)
    .map(([k, v]) => [Number(k), v])
    .sort((a, b) => a[0] - b[0]);
  if (pct <= stops[0][0]) return stops[0][1];
  if (pct >= stops.at(-1)[0]) return stops.at(-1)[1];
  for (let i = 0; i < stops.length - 1; i++) {
    const [x0, c0] = stops[i], [x1, c1] = stops[i + 1];
    if (pct >= x0 && pct <= x1) {
      const t = (pct - x0) / (x1 - x0);
      return lerpHex(c0, c1, t);
    }
  }
}
// lerpHex: parse #rrggbb → rgb → lerp each channel → return rgb(r,g,b)
```

**Wiring** — in `makeChat()`, read `window.widget.config.context_window_tokens` and `.context_bar_thresholds` (already on `window.widget.config` via the existing preload bridge at `src/preload.cjs:6`). Compute:

```js
const windowSize = config.context_window_tokens[chat.model] ?? config.context_window_tokens.default;
const pct = chat.inputTokens && windowSize ? Math.min(100, (chat.inputTokens / windowSize) * 100) : 0;
const color = contextColor(pct, config.context_bar_thresholds);
```

If `chat.inputTokens` is null/undefined (no assistant turn yet), render the bar with `height: 0%` — a thin empty track, consistent with "no context used yet".

### 5. Files to modify

| File | Change |
|---|---|
| `config/config.example.json` | Add `context_window_tokens` + `context_bar_thresholds` |
| `src/widget.cjs` | Merge new defaults in `loadConfig`; update `onWatcherStateChange` to handle new update shape |
| `src/log-watcher.cjs` | `inferState` returns `{ state, model, inputTokens }`; drain callback passes object |
| `src/widget.html` | Add `.context-bar` DOM + CSS + `contextColor` helper + `makeChat` wiring |
| `tests/test_log_watcher.js` (or wherever inferState is tested) | Cover new return shape and usage extraction |

No changes needed to:
- `package.json` `build.files` — no new runtime files
- `src/preload.cjs` — config already bridged
- `integrations/claude_hook.py` — watcher is the sole source of token data
- `src/server.js` (MCP) — no MCP tool changes

## Verification

1. **Unit tests**: `npm run test:js` — new cases for `inferState` returning `{state, model, inputTokens}` from transcript fixtures with `usage` blocks (including entries with partial usage data).
2. **Manual end-to-end**:
   - Edit `config/config.json` to include the two new maps.
   - `npm start` — widget launches, existing chats render as before (bar hidden/empty because no watcher data yet).
   - Start a Claude Code session in this repo; ask a question. After the first assistant response, the context bar should fill to a small percentage with green.
   - Keep the conversation long enough to cross 60% of whatever `context_window_tokens` is set to (easy way to verify: set `"default": 1000` in config temporarily) — bar should shift toward orange, then red past 85%.
   - Override `"claude-opus-4-7": 200000` in config (simulating the non-1M variant), restart, confirm the bar fills 5× faster.
3. **Gradient sanity**: pct = 30 with stops `{0:green, 60:orange}` should render roughly halfway between those colors (visible by eye; no unit test needed).
4. **Regression**: confirm `done`/`working`/`thinking` states still transition correctly — log-watcher signature change must not break state inference.

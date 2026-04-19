---
layout: default
title: Data Flow
---

[Home](..) | [Claude Code](claude-code) | [Other Tools](other-tools) | [Development](development) | [Data Flow](data-flow)

---

This document traces how external activity — hook firings, MCP tool calls, transcript writes, HTTP POSTs from third-party integrations — reaches the dashboard and fans out to its renderers. It is intended as a reference for anyone adding a new integration or changing the widget's internal contracts.

## Components

### ***Dashboard Widget***

The long-running Electron main process. Hosts a localhost HTTP/SSE hub on `127.0.0.1:9077`, owns the in-memory chat state, paints the always-on-top BrowserWindow, and manages the tray icon. Every external trigger eventually lands here. No persistence — state is lost on restart.

Key files:
- `src/widget.cjs` — Electron main + HTTP server + tray + state store (`chats` Map and `sseClients` Set)
- `src/preload.cjs` — `contextBridge` exposing minimize/close IPC and config snapshot to the renderer
- `config/config.json` — user-local settings (widget URL, projects root, show-source-icon toggle, context window sizes, threshold→color map); `config.example.json` is the committed template

### ***Renderer***

The BrowserWindow's HTML UI. Pure DOM + ES5 script. Subscribes to the widget's SSE stream, renders the chat list, and POSTs back to `/api/status` for user actions (dismiss, settings toggles, external link opens). Reads the config snapshot once at load via the preload bridge.

Key files:
- `src/widget.html` — DOM + CSS + renderer script (SSE client, settings UI, `makeChat`, `render`, `contextColor`)

### ***Log Watcher***

Runs inside the *Dashboard Widget* process. Tails Claude Code transcript JSONL files whenever the hook forwards a `transcript_path`. Infers current state from the last conversational entry and extracts model + input-side token counts from the most recent `usage` block.

Key files:
- `src/log-watcher.cjs` — `fs.watch` + incremental reads + `inferState` + `splitComplete`

### ***MCP Server***

A stdio MCP server spawned by Claude Code per session. Exposes two tools and forwards every call as an HTTP POST to the *Dashboard Widget*. Locks its `chat_id` on first `set_status` call so one session cannot spawn multiple dashboard entries. All outcomes log to `mcp.log`.

Key files:
- `src/server.js` — `McpServer` registration + `postStatus` HTTP forwarder + JSON-lines logger

### ***Claude Code Hook***

Python script invoked by Claude Code on five lifecycle events. Reads the hook payload from stdin, derives a `chat_id` from the cwd (or session id), and POSTs to the widget. Swallows network failure silently — a missing widget is the expected steady state.

Key files:
- `integrations/claude_hook.py` — `derive_chat_id`, `build_body`, `post`

### ***Third-Party Integrations***

Independent client scripts. Each speaks only the widget's HTTP contract — they do not share state with each other or with the MCP/hook paths. All swallow network errors on the assumption that the widget may not be running.

Key files:
- `integrations/openwebui_function.py` — OpenWebUI Filter with `inlet`/`outlet` lifecycle hooks
- `integrations/codex_hook.sh` — bash `codex()` wrapper function using `curl`
- `integrations/status_client.py` — minimal Python `status()` helper for arbitrary scripts

## Protocols

### HTTP (port 9077, bound to 127.0.0.1)

| Method | Path           | Direction            | Purpose                                       |
|--------|----------------|----------------------|-----------------------------------------------|
| GET    | `/events`      | Widget → any client  | Server-Sent Events stream of the full chat list (sent on connect and on every mutation) |
| POST   | `/api/status`  | Any client → Widget  | Mutate chat state or trigger a main-process config action |

`POST /api/status` is dispatched by the `action` field:

| `action`  | Required fields                                      | Effect                                                                                   |
|-----------|------------------------------------------------------|------------------------------------------------------------------------------------------|
| `"set"`   | `id`, `status` (enum: idle/working/thinking/awaiting/done/error); optional `label`, `source`, `updated`, `transcript_path` | Creates or updates a chat; if `transcript_path` is present, the *Log Watcher* begins tailing it |
| `"clear"` | `id`                                                 | Deletes the chat and stops watching its transcript                                       |
| `"config"`| `key` (`"alwaysOnTop"` \| `"position"` \| `"openUrl"`), `value` | Drives a main-process side effect (window z-order, reposition, shell.openExternal) — not persisted |

A CSRF guard rejects any POST whose `Origin` header is set to a real http/https origin. Requests with no `Origin` (curl, Node, Python) and `null` origin (the file-loaded renderer) are accepted.

### MCP tools (stdio, one server per Claude Code session)

| Tool            | Args                              | Behavior                                                                                 |
|-----------------|-----------------------------------|------------------------------------------------------------------------------------------|
| `set_status`    | `chat_id`, `status`, `label?`     | POSTs `{action: "set", ...}` to the widget. First call locks `chat_id` for the lifetime of the MCP process; later calls reuse the locked id |
| `clear_status`  | `chat_id`                         | POSTs `{action: "clear", id: lockedChatId ?? chat_id}`                                   |

### Electron IPC (renderer ↔ main)

| Channel       | Direction         | Purpose                                                       |
|---------------|-------------------|---------------------------------------------------------------|
| `get-config`  | Renderer → main (sync) | Returns the merged config object for the renderer snapshot |
| `minimize`    | Renderer → main   | Hide the BrowserWindow                                        |
| `close`       | Renderer → main   | Quit the app                                                  |

## Serialization

- HTTP request/response bodies are JSON with `Content-Type: application/json`.
- SSE frames are `data: <json>\n\n` where `<json>` is a JSON array of chat objects.
- Chat objects on the wire: `{ id, status, label, source, updated, transcript_path?, model?, inputTokens? }`.
- MCP frames are JSON-RPC 2.0 over stdio, handled by `@modelcontextprotocol/sdk`.

## External trigger flows

### A. Claude Code lifecycle hooks

Claude Code fires one of five hook events per session stage. A single Python entrypoint dispatches on its first CLI argument and POSTs to the widget. The cwd-derived `chat_id` means all five events target the same dashboard row.

**Triggers:**
- `SessionStart` → `python claude_hook.py idle`
- `UserPromptSubmit` → `python claude_hook.py working`
- `Notification` → `python claude_hook.py idle` (Claude Code waiting on user)
- `Stop` → `python claude_hook.py done`
- `SessionEnd` → `python claude_hook.py clear`

---

***Claude Code CLI***

1. Spawn the hook script with the event keyword as argv[1]
2. Write the hook payload JSON to the script's stdin

```
⇩   payload on stdin:
⇩   { session_id, cwd, transcript_path, prompt?, message? }
```

***Claude Code Hook***

1. Load `config/config.json` via `claude_hook.load_config()` — strict: raises if the file is missing, malformed, or any of `widget_url` / `projects_root` / `benign_closers` are absent. The hook exits with stderr diagnostics on failure.
2. Derive `chat_id` from cwd relative to `projects_root` via `claude_hook.derive_chat_id()`, falling back to folder basename or `claude-<short-session-id>`
3. Build the request body via `claude_hook.build_body()`:
    - For `working`, flatten whitespace in the user prompt (newlines/tabs → spaces, runs collapsed) and forward the full text as `label` — the widget ellipsizes via CSS on display
    - For `done` / `idle_prompt`, walk the transcript: if the last assistant text ends with `?` AND is not one of the configured `benign_closers` (e.g. "What's next?"), emit `awaiting` with `label: "has a question"`; otherwise `done`
    - For `idle` from a Notification, use the notification `message` as `label`
    - For `idle` from SessionStart and for `done`, omit `label` so the widget preserves its prior value
    - For `clear`, emit `{action: "clear", id}` only
    - Forward `transcript_path` from the payload when present
4. POST the body via `claude_hook.post()` (2s timeout, errors swallowed)

```
⇩   POST /api/status:
⇩   {action: "set"|"clear", id, status, source: "claude", updated, label?, transcript_path?}
```

***Dashboard Widget***

1. HTTP handler in `widget.cjs` parses the body, validates the status enum, and merges into the `chats` Map via `widget.onSet`-style logic inline at the POST handler
2. If `transcript_path` is present, call `logWatcher.startWatching(id, transcript_path, onWatcherStateChange, onWatcherError)`
3. If `action === "clear"`, stop watching the prior transcript via `logWatcher.stopWatching()` and delete the entry
4. Call `widget.broadcast()` to fan out to all SSE clients

### B. MCP tool invocation

Claude Code spawns the MCP server as a child process at session start. The model can call `set_status` or `clear_status` at any point during a turn — most commonly mid-response to surface `thinking` or `error` states the lifecycle hooks don't see.

**Triggers:**
- Model invokes `set_status` tool
- Model invokes `clear_status` tool

---

***Claude Code CLI***

1. Route the tool call to the running MCP server over stdio (JSON-RPC 2.0)

```
⇩   JSON-RPC call:
⇩   { method: "tools/call", params: { name: "set_status"|"clear_status", arguments: {...} } }
```

***MCP Server***

1. Zod-validate the arguments against the registered tool schema
2. For `set_status`: if `lockedChatId` is unset, lock to the incoming `chat_id`; otherwise ignore the incoming value and use the locked id
3. Log the invocation to `mcp.log` via `server.log()`
4. Forward to the widget via `server.postStatus()` (2s timeout, errors logged but never surfaced to the MCP client)
5. Return a human-readable confirmation string to Claude Code

```
⇩   POST /api/status:
⇩   {action: "set", id: lockedChatId, status, label, source: "claude", updated}
⇩   — or —
⇩   {action: "clear", id: lockedChatId}
```

***Dashboard Widget***

1. Same HTTP handler as flow A — merge into `chats` Map and `widget.broadcast()`

### C. Transcript file mutation → log watcher

Once the *Claude Code Hook* has forwarded a `transcript_path`, the watcher tails the JSONL and pushes incremental state + token updates without any further external messaging. This is the only flow where the trigger is a filesystem event rather than an HTTP/RPC call.

**Triggers:**
- Claude Code appends a new line to the session's transcript JSONL (any user message, assistant message, tool call, or metadata row)

---

***Claude Code CLI*** (as side effect of its normal operation)

1. Append one or more JSON lines to `~/.claude/projects/<slug>/<session>.jsonl`

```
⇩   (filesystem append — no message boundary with the widget)
```

***Log Watcher***

1. `fs.watch` fires a `"change"` event for the tracked path
2. `logWatcher.drain()` stats the file, reads bytes from the last-known position to the current size, and hands them to `logWatcher.splitComplete()` to separate complete JSON lines from a trailing partial
3. `logWatcher.inferState()` walks the new lines backwards and extracts:
    - `state` — `"working"` if the newest conversational entry has `tool_use`/`tool_result`/user text; `"done"` if it is an assistant text entry; `null` if only metadata
    - `model` — from the most recent assistant entry's `message.model`
    - `inputTokens` — `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` from the most recent assistant entry's `message.usage`
4. If any field is non-null, invoke the `onStateChange` callback registered by the widget

```
⇩   onStateChange(chatId, { state, model, inputTokens }):
⇩   (state/model/inputTokens may each be null if not found in this chunk)
```

***Dashboard Widget***

1. `widget.onWatcherStateChange()` looks up the existing chat; returns early if not present
2. Merge each non-null field if it differs from the stored value (status, model, inputTokens)
3. On any change, update `updated` and call `widget.broadcast()`

On parse error or unreadable transcript, `logWatcher.drain()` emits an error to `widget.onWatcherError()` instead, which — except for an expected `ENOENT` during the SessionStart race — creates a synthetic error row with `id: "watcher-error"`, `source: "watcher"` and appends a line to `widget.log`.

### D. OpenWebUI filter lifecycle

OpenWebUI invokes user-registered Filter functions' `inlet` before the model sees a request and `outlet` after the response is generated. The dashboard integration maps those to `working`/`done`.

**Triggers:**
- User sends a message in OpenWebUI (`inlet`)
- Model response completes in OpenWebUI (`outlet`)

---

***OpenWebUI***

1. Call `Filter.inlet(body, __user__)` before dispatching to the model
2. Call `Filter.outlet(body, __user__)` after the model returns

```
⇩   body (OpenWebUI-native):
⇩   { chat_id, model, messages, ... }
```

***OpenWebUI Filter***

1. Truncate `body["chat_id"]` to 20 chars
2. `inlet`: build a `{action: "set", status: "working", label: model, source: "openwebui"}` payload and POST via `Filter._post_status()`
3. `outlet`: build a `{action: "set", status: "done", source: "openwebui"}` payload and POST
4. Return `body` unchanged so the OpenWebUI pipeline continues
5. Swallow any network error — dashboard may not be running

```
⇩   POST /api/status:
⇩   {action: "set", id, status: "working"|"done", label, source: "openwebui", updated}
```

***Dashboard Widget***

1. Same merge + broadcast path as flow A

### E. Codex shell wrapper

Invoked when the user types `codex <task>` after sourcing `codex_hook.sh` in their shell. The function wraps the real `codex` binary with before/after curl POSTs.

**Triggers:**
- User runs the wrapped `codex` shell function

---

***User shell***

1. Call the `codex()` function (a bash wrapper over the real codex binary)

***Codex Shell Hook***

1. Build `task_id` as `codex-$$` (shell PID) and `label` as the first 40 chars of args
2. POST `{action: "set", status: "working", source: "codex"}` via `curl` (backgrounded with `&`, stderr suppressed)
3. Exec the real `codex` binary with the user's args
4. On exit code 0, POST `{status: "done"}`; on non-zero, POST `{status: "error", label: "exit N"}`

```
⇩   POST /api/status (×2, one on start, one on completion):
⇩   {action: "set", id: "codex-<pid>", status, label, source: "codex", updated}
```

***Dashboard Widget***

1. Same merge + broadcast path as flow A

### F. Generic Python client

For scripts, notebooks, or agents that don't fit the other integrations. No session lifecycle — the caller decides when to report and which labels to use.

**Triggers:**
- Any Python code that imports and calls `status_client.status()`

---

***User script***

1. `from status_client import status; status(chat_id, state, label, source)`

***Generic Python Client***

1. Build `{action: "set", id: chat_id, status: state, label, source, updated}`
2. POST to the configured URL (default `http://127.0.0.1:9077/api/status`) with a 2s timeout
3. Swallow any network error

```
⇩   POST /api/status:
⇩   {action: "set", id, status, label, source, updated}
```

***Dashboard Widget***

1. Same merge + broadcast path as flow A

### G. Renderer user actions

Clicks inside the widget window. The renderer cannot talk to main memory directly for state changes — it uses the same HTTP endpoint as every other client, plus a small set of Electron IPC channels for window-level operations that must happen in main.

**Triggers:**
- User clicks the per-chat `×` dismiss button
- User toggles Always-on-top, Notifications, or Auto-dismiss
- User changes the Position dropdown
- User clicks the GitHub link
- User clicks the titlebar minimize/close buttons

---

<table>
<tr>
<th valign="top">Dismiss button</th>
<th valign="top">Settings toggle / link</th>
<th valign="top">Window controls</th>
</tr>
<tr>
<td valign="top">

***Renderer***

1. `widget.dismissChat(id)` fetches `POST /api/status` with `{action: "clear", id}`

</td>
<td valign="top">

***Renderer***

1. Update local toggle class / select value
2. `fetch('/api/status', { action: 'config', key, value })` where `key` is `alwaysOnTop`, `position`, or `openUrl`
3. (Notifications and Auto-dismiss update renderer-local state only; no POST)

</td>
<td valign="top">

***Renderer***

1. `window.widget.minimize()` or `window.widget.close()` sends IPC via the preload bridge

</td>
</tr>
<tr>
<td valign="top">

```
⇩   POST /api/status:
⇩   {action: "clear", id}
```

</td>
<td valign="top">

```
⇩   POST /api/status:
⇩   {action: "config", key, value}
```

</td>
<td valign="top">

```
⇩   ipcRenderer.send("minimize" | "close")
```

</td>
</tr>
<tr>
<td valign="top">

***Dashboard Widget***

1. Same handler as flow A — stop watching the transcript and delete the chat, then `widget.broadcast()`

</td>
<td valign="top">

***Dashboard Widget***

1. Dispatch on `msg.key`:
    - `alwaysOnTop` → `win.setAlwaysOnTop(value, "floating")`
    - `position` → `widget.reposition(value)` (recomputes coords via `widget.getPosition()` and calls `win.setPosition()`)
    - `openUrl` → `widget.safeOpenUrl()` validates protocol and delegates to `shell.openExternal()`
2. No chat state change, no broadcast

</td>
<td valign="top">

***Dashboard Widget***

1. `minimize` IPC → `win.hide()`
2. `close` IPC → `app.quit()` (triggers `app.on("before-quit")` → `logWatcher.stopAll()`)

</td>
</tr>
</table>

### H. Tray icon

**Triggers:**
- User left-clicks the system tray icon
- User selects an item from the tray context menu

---

***OS***

1. Deliver the tray `click` or menu-item `click` event to the Electron main process

***Dashboard Widget***

1. Tray `click` → toggle `win.isVisible()`; on hide, call `win.hide()`; on show, call `win.show()` + `win.focus()`; if the window was destroyed, call `widget.createWindow()` to rebuild it
2. Position submenu items → `widget.reposition(pos)` directly
3. Quit item → `app.quit()`

No external HTTP or IPC is involved — tray events drive window and process lifecycle directly.

## Internal fan-out

Every mutation to the `chats` Map in the *Dashboard Widget* calls `widget.broadcast()`.

***Dashboard Widget***

1. Serialize `Array.from(chats.values())` to JSON
2. For each connection in `sseClients`, write `data: <json>\n\n` — dead connections are removed on `req.on("close")` during their setup

```
⇩   SSE frame to every connected renderer:
⇩   data: [{id, status, label, source, updated, transcript_path?, model?, inputTokens?}, ...]
```

***Renderer***

1. `EventSource.onmessage` parses the JSON array and calls `widget.render()` (script-local)
2. `render()` sorts by status priority (working → thinking → error → idle → done) then by `updated` desc
3. For each chat, `makeChat()` builds the DOM row — source icon, pulsing dot, name/label, status badge, dismiss button, and context-usage bar (height = `inputTokens / context_window_tokens[model] * 100`, color linearly interpolated between the configured `context_bar_thresholds` stops)
4. `notify()` fires a desktop Notification on `done`/`error` transitions when the in-renderer notifications flag is on

## Error propagation and retry

| Boundary                             | On failure                                                                                        |
|--------------------------------------|--------------------------------------------------------------------------------------------------|
| Any integration → widget HTTP POST   | Client swallows the error (2s timeout on the Python/Node variants; backgrounded curl in bash). Widget-missing is the expected steady state; nothing is retried |
| MCP server → widget HTTP POST        | Logged to `mcp.log` with the action, status, and elapsed ms. Never surfaced as a tool error — would show up as noise in Claude Code |
| Renderer ↔ widget SSE                | On `EventSource.onerror`, the renderer closes, sleeps `retryDelay` (starts at 1000ms, multiplies by 1.5 on each failure, capped at 10000ms), and reconnects. Successful messages reset the delay to 1000ms |
| Log watcher: `stat`/`read`/`infer`   | `widget.onWatcherError()` logs to `widget.log` and inserts a synthetic `{id: "watcher-error", status: "error", source: "watcher"}` row. ENOENT during SessionStart is expected and not surfaced — the next hook event retries implicitly by re-POSTing `transcript_path` |
| Hook payload stdin                   | Malformed JSON is caught and replaced with `{}`; the hook still POSTs with just the cwd-derived chat_id |
| Config file read                     | Missing or malformed `config.json`, or missing required keys, fails loudly: widget shows an error dialog and exits; `claude_hook.py` prints to stderr and exits 1. No silent fallback to defaults |

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm start` — launch the Electron widget (runs `src/widget.cjs`). This starts both the BrowserWindow and the HTTP/SSE server on `127.0.0.1:9077`.
- `npm run build` — produce a Windows portable build via `electron-builder` (output artifact: `AI-Agent-Dashboard.exe`).
- `npm test` — run both test suites (Python + Node). Individual runners: `npm run test:py` and `npm run test:js`.

There is no linter configured.

## Layout

```
src/           Electron main + renderer (widget.cjs, widget.html, preload.cjs, log-watcher.cjs, chat-state.cjs)
assets/        Static assets (icon, screenshot)
config/        config.example.json (committed) and config.json (git-ignored, user-local)
integrations/  Hook scripts and example HTTP clients (paths hardcoded in user's ~/.claude/settings.json)
tests/         Python unittest + Node node:test suites
```

Root stays small: `launch.vbs` (Windows launcher) plus `package.json` / docs. Both `src/widget.cjs` and `integrations/claude_hook.py` read `config/config.json` resolved relative to their own location. The widget writes `widget.log` at repo root (git-ignored).

## Architecture

The widget is a single Electron process that also listens on **localhost HTTP on port 9077**. This port is hardcoded in `src/widget.cjs`, `src/widget.html`, and the integration scripts — changing it requires updating all of them.

### 1. Widget process (`src/widget.cjs`)

The Electron main process is also the HTTP hub. It:
- Listens on `127.0.0.1:9077` with three endpoints:
  - `POST /api/status` — accepts `{action: "set"|"clear"|"config", ...}` messages.
  - `GET /events` — Server-Sent Events stream of the full chat list; the renderer (`widget.html`) connects here and reconnects with exponential backoff on error.
- Owns the in-memory `chats` Map (keyed by `id`) and broadcasts the full list to all SSE clients on every mutation. There is no persistence — state is lost on restart.
- Renders `src/widget.html` in a frameless always-on-top BrowserWindow and creates a system tray icon. `src/preload.cjs` bridges `minimize`/`close` IPC from renderer to main.
- The `config` action is how the renderer's settings UI reaches back into the main process (e.g. toggling `alwaysOnTop`, repositioning the window, opening external URLs) — this is the reverse of the normal data flow and worth understanding before adding new settings.
- `src/chat-state.cjs` owns the sticky-prompt rule. `nextOriginalPrompt(existing, msg)` is called from the `/api/status` POST handler and decides whether the incoming label becomes the row's new `originalPrompt` or the existing one is preserved: set at task boundaries (fresh chat / previous status `done` or `idle` / not yet recorded), cleared on `idle`, otherwise preserved. The renderer reads `originalPrompt || label` for every state except `awaiting` and `idle`, so a short `y` to a permission prompt does not overwrite the task title and a `done` row still shows the task that just ran (instead of the stale `needs approval: ...` label left in the `label` slot from the preceding `awaiting`).
- `src/log-watcher.cjs` tails Claude Code transcript JSONL files when the hook forwards `transcript_path`. It fills in state between hook events (notably: resumed-after-notification, intermediate tool steps) **and** extracts the current model + input-side token count from the most recent main-session assistant `usage` block — this drives the per-row context indicator. Sidechain entries (sub-agents) and synthetic `<synthetic>` entries are skipped so they don't override the main session's model. Watcher-to-widget merging goes through `mergeWatcherUpdate()`: the watcher can only **promote** state to `working`; `done`/`idle`/`awaiting`/`error` are hook-authoritative. This prevents a partial assistant text in the transcript from flipping a fresh `working` row back to `done` before the `Stop` hook has a chance to fire. Model/token updates always propagate. The first drain after `startWatching` suppresses inferred state entirely (via the `initialRead` flag) so a stale transcript tail doesn't override the hook's initial `idle`. Parse failures surface as a `status: "error"` row with `id: "watcher-error"` / `source: "watcher"` and also log to `widget.log` — never silent.

### 2. Integrations (`integrations/`)

`claude_hook.py` is the primary integration — Python script that Claude Code invokes on `SessionStart` / `UserPromptSubmit` / `Notification` / `Stop` / `SessionEnd`, reading the hook payload from stdin and POSTing to `/api/status`. It reads `config/config.json` (`projects_root` controls the cwd-to-chat_id mapping; `widget_url` is the POST target; `benign_closers` is a list of conversational question-endings like `"What's next?"` that are treated as `done` rather than `awaiting`). Config loading is **strict** — missing keys or malformed JSON raise and the hook exits with a stderr diagnostic; there are no silent defaults. Tests live in `tests/test_claude_hook.py`.

Other files in `integrations/` (`openwebui_function.py`, `codex_hook.sh`, `status_client.py`) are unverified example clients kept as references. They all POST to the same `/api/status` endpoint.

### Source identity convention

The renderer's `SOURCE_LABELS` map (`claude` → C, `codex` → X, `openwebui` → W, else `?`) drives icon color and letter. When adding a new first-class integration, update both the renderer's `SOURCE_LABELS` and the `.source-icon.<name>` CSS rule in `src/widget.html`, plus the README source table. Unknown sources render with the first uppercase letter of the source string against a gray badge.

### Status enum

`idle | working | awaiting | done | error` — validated in `src/widget.cjs` (`VALID_STATUSES`), referenced by color/badge CSS classes in `src/widget.html`, and documented in the README. Adding a new status requires touching all three. `awaiting` specifically means "Claude is blocked on user input" (asked a question, hit a permission prompt, waiting on plan approval) and is produced by the `claude_hook.py` classifier using the `?`-heuristic on the transcript's last assistant text.

## Conventions specific to this repo

- The project is `"type": "module"`, but the Electron main process and preload are `.cjs` because Electron's main process loader currently expects CommonJS.
- `build.files` in `package.json` is an **explicit allowlist** for electron-builder. Any new runtime asset (new HTML, icon, JS file loaded at runtime) must be added there or it won't ship in the packaged exe.

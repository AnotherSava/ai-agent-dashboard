---
layout: default
title: Development
---

[Home](..) | [Claude Code](claude-code) | [Other Tools](other-tools) | [Development](development) | [Data Flow](data-flow)

---

## Setup

### Prerequisites

- Node.js 18+ (tested on 24)
- Python 3 (for the Claude Code hook and the Python test suite)
- Windows 10+, macOS, or Linux

### Install

```bash
git clone https://github.com/AnotherSava/ai-agent-dashboard.git
cd ai-agent-dashboard
npm install
cp config/config.example.json config/config.json   # optional
```

### Run from source

```bash
npm start
```

Launches the Electron widget. It binds `127.0.0.1:9077` and opens a frameless always-on-top window in the bottom-right corner.

### Build a portable exe

```bash
npm run build
```

Output: `dist/AI-Agent-Dashboard.exe`, single-file Windows portable (~90 MB). First build downloads Electron + NSIS + winCodeSign (~150 MB total) into the electron-builder cache; subsequent builds are ~10 seconds.

## Commands

- `npm start` — launch the Electron widget (`src/widget.cjs`). Starts the BrowserWindow and the HTTP/SSE hub on `127.0.0.1:9077`.
- `npm run build` — produce the portable Windows exe via electron-builder.
- `npm test` — both test suites. `npm run test:py` / `npm run test:js` run them individually.

There is no linter configured.

## Architecture

The widget is a single Electron process that also hosts the localhost HTTP hub on port 9077. The port is hardcoded — changing it requires editing `src/widget.cjs`, `src/widget.html`, and every integration script.

**Electron widget** (`src/widget.cjs`) is the HTTP hub. It owns the in-memory chat Map, accepts POSTs to `/api/status`, streams Server-Sent Events on `/events`, renders `src/widget.html` in a frameless always-on-top BrowserWindow, and manages a system tray icon. It also embeds the log watcher (`src/log-watcher.cjs`) that tails Claude Code transcript JSONL files to refine state between hook events.

State is in-memory only. Widget restart loses all rows. The Claude Code hook re-populates on the next session event; other integrations repopulate on their next POST.

## Project structure

```
src/
  widget.cjs           Electron main + HTTP/SSE hub + tray/window management
  widget.html          Renderer — DOM-built chat list, settings tab, SSE client
  preload.cjs          IPC bridge: minimize / close buttons from renderer → main
  log-watcher.cjs      Tails Claude Code transcript JSONL, infers state from last conversational entry
  chat-state.cjs       Sticky-prompt rule (originalPrompt) for /api/status merges
integrations/
  claude_hook.py       Primary integration: Claude Code hook, POSTs to /api/status
  codex_hook.sh        Bash wrapper around the `codex` CLI
  openwebui_function.py  OpenWebUI Filter function (unverified example)
  status_client.py     30-line stdlib Python helper for ad-hoc scripts
assets/
  ai-agent-dashboard.ico   Electron app icon + tray icon
config/
  config.example.json  Committed template
  config.json          Git-ignored, user-local overrides
tests/
  test_claude_hook.py      Python unittest (build_body, derive_chat_id, load_config)
  log-watcher.test.cjs     node:test (inferState, splitComplete, mergeWatcherUpdate)
  chat-state.test.cjs      node:test (nextOriginalPrompt state machine)
  widget-layout.test.cjs   node:test (layout invariants via regex on widget.html)
launch.vbs             Windows launcher that starts the widget without a console window
```

### Key conventions

- Project is `"type": "module"`, but the Electron main process and preload are `.cjs` because Electron's main loader expects CommonJS.
- `build.files` in `package.json` is an **explicit allowlist** for electron-builder — any new runtime asset must be added there or it won't ship in the packaged exe.
- Both `src/widget.cjs` and `integrations/claude_hook.py` resolve `config/config.json` relative to their own file location, not the current working directory.
- Logs: the widget writes JSON-lines to `widget.log` at the repo root (git-ignored by `*.log`).

### Status enum

`idle | working | awaiting | done | error` — validated in `src/widget.cjs` (`VALID_STATUSES`), referenced by color/badge CSS classes in `src/widget.html`, and documented on the [Other Tools](other-tools) page. Adding a new status requires touching all three.

### Source identity convention

The renderer's `SOURCE_LABELS` map (`claude` → C, `codex` → X, `openwebui` → W, else `?`) drives icon color and letter. When adding a new first-class integration, update the `SOURCE_LABELS` map, the `.source-icon.<name>` CSS rule in `src/widget.html`, and the source table on the [Other Tools](other-tools) page. Unknown sources render with the first uppercase letter against a gray badge.

## Testing

```bash
npm test
```

Python suite (`tests/test_claude_hook.py`) covers `build_body`, `derive_chat_id`, `load_config`, the `classify` dispatcher, and the `last_assistant_ends_with_question` transcript heuristic in the Claude Code hook — 40 tests exercising payload construction, config loading, and Notification / Stop classification.

Node suite (`tests/log-watcher.test.cjs`) covers the pure helpers `inferState` and `splitComplete` in `src/log-watcher.cjs` — 20 tests for transcript parsing, partial-line buffering, model/token extraction, and sidechain/synthetic-entry filtering. The `fs.watch` machinery is not unit-tested; changes there need manual verification.

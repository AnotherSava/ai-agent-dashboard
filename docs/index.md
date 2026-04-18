---
layout: default
title: AI Agent Dashboard
---

[Home](.) | [Claude Code](pages/claude-code) | [Other Tools](pages/other-tools) | [Development](pages/development) | [Data Flow](pages/data-flow)

---

*A real-time desktop widget that shows what your AI coding agents are doing.*

Anything that can POST JSON to localhost can report its status. Each session appears as a row in a compact always-on-top window, with a color-coded icon identifying the source tool and a live status badge that transitions between idle / working / thinking / awaiting / done / error.

![AI Agent Dashboard](screenshots/screenshot.png)

## Install

```bash
git clone https://github.com/AnotherSava/ai-agent-dashboard.git
cd ai-agent-dashboard
npm install
npm start
```

A Windows portable build is also available via `npm run build` — output: `dist/AI-Agent-Dashboard.exe`.

## Supported tools

Click a heading for full setup instructions and feature details.

### [Claude Code](pages/claude-code)

First-class integration via lifecycle hooks in `~/.claude/settings.json`. Each Claude Code session becomes a row named after its working directory, with state tracked through SessionStart / UserPromptSubmit / Notification / Stop / SessionEnd events. A log watcher tails the session's transcript JSONL to fill in state between hook events. An optional MCP server lets Claude signal `thinking` or `error` mid-response.

### [Other Tools](pages/other-tools)

Codex (shell wrapper), OpenWebUI (Filter function), and a generic HTTP API for anything else. The raw API is the universal fallback — a three-line curl reports status for any tool you can glue together.

## Usage

1. Launch the widget with `npm start` or the packaged exe. A small window pins to the bottom-right corner; a tray icon stays in the system tray.
2. Configure your AI tool to report status — see the [Claude Code](pages/claude-code) or [Other Tools](pages/other-tools) pages.
3. The widget shows one row per active session. Color-coded dots animate while `working` / `thinking` / `awaiting`, settle green on `done`, flash red on `error`.
4. Minimize to tray via the `–` button, toggle notifications with `N`, quit with `×`. Right-click the tray icon for position controls.

## Acknowledgments

Initially based on [claude-status-dashboard](https://github.com/Idevelopusefulstuff/claude-status-dashboard) by ExPLiCiT.

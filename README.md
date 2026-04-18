# AI Agent Dashboard

*A real-time desktop widget that shows what your AI coding agents are doing.*

Anything that can POST JSON to localhost can report its status. Each session appears as a row in a compact always-on-top window, with a color-coded icon identifying the source tool and a live badge that transitions between idle / working / thinking / done / error.

![AI Agent Dashboard](docs/screenshots/screenshot.png)

**[Claude Code](https://anothersava.github.io/ai-agent-dashboard/pages/claude-code)** — First-class integration via lifecycle hooks in `~/.claude/settings.json`. Each Claude Code session becomes a row named after its working directory, with state tracked through SessionStart / UserPromptSubmit / Notification / Stop / SessionEnd events. A log watcher tails the session's transcript JSONL to fill in state between hook events. An optional MCP server lets Claude signal `thinking` or `error` mid-response.

**[Other Tools](https://anothersava.github.io/ai-agent-dashboard/pages/other-tools)** — Codex (shell wrapper), OpenWebUI (Filter function), and a generic HTTP API for anything else. The raw API is the universal fallback — a three-line curl reports status for any tool you can glue together.

---

```bash
git clone https://github.com/AnotherSava/ai-agent-dashboard.git
cd ai-agent-dashboard
npm install
npm start
```

See full project documentation at **[anothersava.github.io/ai-agent-dashboard](https://anothersava.github.io/ai-agent-dashboard/)**:

- [Installation and usage](https://anothersava.github.io/ai-agent-dashboard/)
  - [Claude Code](https://anothersava.github.io/ai-agent-dashboard/pages/claude-code)
  - [Other Tools](https://anothersava.github.io/ai-agent-dashboard/pages/other-tools)
- [Developer guide](https://anothersava.github.io/ai-agent-dashboard/pages/development)

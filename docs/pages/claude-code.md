---
layout: default
title: Claude Code
---

[Home](..) | [Claude Code](claude-code) | [Other Tools](other-tools) | [Development](development) | [Data Flow](data-flow)

---

The widget tracks [Claude Code](https://claude.com/product/claude-code) sessions by registering as Claude Code hooks. Each session becomes a row in the dashboard, named after its working directory (e.g. a session started in `D:/projects/ai-agent-dashboard` shows up as `ai-agent-dashboard`).

### How sessions appear

A fresh Claude Code session shows as `idle` the moment you launch it. The moment you submit a prompt it flips to `working` with the first 60 characters of your prompt as the row's label. When Claude finishes responding with a report, the row marks `done`; when Claude finishes by asking you a question, it marks `awaiting` — distinguished by inspecting the transcript's last assistant text (ends with `?` ⇒ `awaiting`). Permission prompts and plan-approval notifications also show `awaiting` with the specific tool / prompt label. When you `/exit`, the row is cleared. The row also shows a colored token count (e.g. `82k`) whenever the watcher has seen an assistant turn, so you can see context growth at a glance.

![Widget showing a Claude Code session](../screenshots/screenshot.png)

### Setup

Add these five hooks to `~/.claude/settings.json` (merge with any existing `hooks` block). Replace `<repo>` with the absolute path to your clone.

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "async": true,
          "command": "python3 <repo>/integrations/claude_hook.py idle" } ] }
    ],
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "async": true,
          "command": "python3 <repo>/integrations/claude_hook.py working" } ] }
    ],
    "Notification": [
      { "hooks": [ { "type": "command", "async": true,
          "command": "python3 <repo>/integrations/claude_hook.py idle" } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "async": true,
          "command": "python3 <repo>/integrations/claude_hook.py done" } ] }
    ],
    "SessionEnd": [
      { "hooks": [ { "type": "command", "async": true,
          "command": "python3 <repo>/integrations/claude_hook.py clear" } ] }
    ]
  }
}
```

Restart any open Claude Code sessions — hooks are loaded at session start, so existing sessions stay silent until relaunched.

Requires Python 3 on PATH (the hook is a Python script).

### Live state tracking

Beyond the hook-driven transitions, the widget watches the Claude Code transcript JSONL file for the active session and updates state when new conversational entries appear. This catches cases hooks don't observe:

- Long tool loops where the hook fires once but activity continues for a while.
- Resumption after a permission prompt — as soon as Claude writes a new tool use or text block, the row flips back to `working`.
- Intermediate reasoning steps.

Transcripts are read-only — the widget never writes to them. If parsing fails (unknown entry shape, unreadable file), the widget surfaces a red `watcher-error` row with the failure reason and writes a JSON-lines entry to `widget.log`. Never silent.

### Readable session names

Claude Code sessions are identified by their working directory's basename. For projects nested under a common root, set `projects_root` in `config/config.json` to get human-readable names:

```json
{ "projects_root": "d:/projects" }
```

With that, a session in `d:/projects/bga/assistant` shows up as `bga assistant` rather than just `assistant`. Slashes, dashes, and underscores in the relative path all become spaces.

### Features

- **Five lifecycle hooks**: SessionStart → idle, UserPromptSubmit → working, Notification → awaiting (with tool / message label), Stop → done or awaiting (classified from the transcript's last assistant text), SessionEnd → clear.
- **Transcript watcher**: tails `~/.claude/projects/<project>/<session>.jsonl`. Infers state from the last conversational entry (tool_use / tool_result → working; assistant text → done) and extracts the current model + input-side token count from the most recent assistant `usage` block to drive the context indicator.
- **Context-usage indicator**: colored token count on the right of each row. Window sizes and threshold colors are configurable in `config/config.json` (`context_window_tokens`, `context_bar_thresholds`) — defaults assume the 1M-context variants of Opus 4.7 / Sonnet 4.6.
- **Prompt-as-label**: the user prompt displays under the session name for the life of the task — through `working`, the `done` that follows it, and any `error` — and stays sticky across `awaiting`/approval cycles, so a short `y` to a permission prompt doesn't overwrite the task title. `awaiting` rows show what's blocking instead (e.g. `needs approval: Bash`). Long prompts truncate with an ellipsis or wrap onto a full-width row depending on available space.
- **Readable session IDs**: cwd basename by default, subpath-under-`projects_root` if configured.
- **Loud-but-not-silent error surface**: transcript parse failures show as a red row plus a line in `widget.log`, so missed state is never invisible.

### Standard features

- **Desktop notifications** on done/error transitions (toggleable via the `N` button).
- **Always on top** by default, toggleable from the Settings tab.
- **Configurable position**: four corners, chosen from the Settings tab or the tray right-click menu.
- **System tray icon**: click to show/hide, right-click for position menu and quit.
- **Auto-dismiss done sessions**: toggleable from Settings — done rows fade out after 30 s.
- **Auto-reconnect renderer**: the widget's UI reconnects to the HTTP hub on network blip with exponential backoff.

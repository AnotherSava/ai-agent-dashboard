# AI Status Dashboard

A real-time desktop widget that shows what your AI sessions are doing. Works with **Claude Code**, **OpenAI Codex**, **OpenWebUI**, or any tool that can POST JSON.

![Widget Preview](https://img.shields.io/badge/electron-41+-blue) ![MCP](https://img.shields.io/badge/MCP-compatible-green) ![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

![AI Status Dashboard](screenshot.png)

## How It Works

```
Any AI tool ──HTTP POST──▶ widget.cjs ──SSE──▶ widget.html
                :7890        (Electron)        (renderer)
```

Any tool that can send an HTTP POST can report status. The widget shows each session with a color-coded source icon:

| Source | Icon | Color |
|--------|------|-------|
| Claude Code | **C** | Terracotta |
| Codex | **X** | Green |
| OpenWebUI | **W** | Blue |
| Other | **?** | Gray |

## Setup

### 1. Install

```bash
git clone https://github.com/Idevelopusefulstuff/claude-status-dashboard.git
cd claude-status-dashboard
npm install
npm start
```

### 2. Connect Your Tools

#### Claude Code (MCP)

Add the MCP server to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "claude-status": {
      "command": "node",
      "args": ["/full/path/to/claude-status-dashboard/server.js"]
    }
  }
}
```

Add to your `CLAUDE.md`:

```markdown
## Status Dashboard (MCP: claude-status)
- Call `mcp__claude-status__set_status` at the start and end of every response
- Start: `status: "working"`, `label: "what you're doing"`
- End: `status: "done"`
- Pick a short `chat_id` on first response, reuse it for the whole conversation
```

#### OpenWebUI (Filter Function)

1. In OpenWebUI, go to **Workspace > Functions > Add**
2. Paste the contents of `integrations/openwebui_function.py`
3. Enable it as a global filter, or attach it to specific models
4. Set the `dashboard_url` valve (default: `http://host.docker.internal:7890`)

#### Codex (Shell Wrapper)

```bash
source integrations/codex_hook.sh
codex "fix the bug"   # auto-reports working/done
```

#### Any Tool (HTTP API)

```bash
# Set status
curl -X POST http://127.0.0.1:7890/api/status \
  -H "Content-Type: application/json" \
  -d '{"action":"set","id":"my-task","status":"working","label":"doing stuff","source":"mytool","updated":1234567890000}'

# Clear
curl -X POST http://127.0.0.1:7890/api/status \
  -H "Content-Type: application/json" \
  -d '{"action":"clear","id":"my-task"}'
```

Or use the Python client:

```python
from integrations.status_client import status
status("my-task", "working", "doing stuff", source="mytool")
status("my-task", "done")
```

## API

**POST** `http://127.0.0.1:7890/api/status`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | `"set"` or `"clear"` | yes | Set or remove a session |
| `id` | string | yes | Unique session identifier |
| `status` | enum | for set | `idle`, `working`, `thinking`, `done`, `error` |
| `label` | string | no | Short description of activity |
| `source` | string | no | Tool name: `claude`, `codex`, `openwebui`, or custom |
| `updated` | number | no | Unix timestamp in milliseconds |

**GET** `http://127.0.0.1:7890/events` — SSE stream of all sessions

## Status Colors

| Status | Color | Meaning |
|--------|-------|---------|
| `working` | Orange | Actively executing |
| `thinking` | Purple | Planning or researching |
| `done` | Green | Response complete |
| `error` | Red | Something went wrong |
| `idle` | Gray | Session idle |

## Widget Controls

| Button | Action |
|--------|--------|
| **N** | Toggle desktop notifications |
| **--** | Minimize to tray |
| **x** | Quit |

## Auto-Start (Windows)

Use `launch.vbs` or add a shortcut to your Startup folder:

```
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
```

## License

MIT

---
layout: default
title: Other Tools
---

[Home](..) | [Claude Code](claude-code) | [Other Tools](other-tools) | [Development](development) | [Data Flow](data-flow)

---

The widget is source-agnostic: anything that can POST JSON to `127.0.0.1:9077` shows up as a row. The `integrations/` folder ships starter scripts for Codex and OpenWebUI, and the raw HTTP API is the universal fallback for anything else.

### Codex

The [OpenAI Codex](https://github.com/openai/codex) CLI can be wrapped with a Bash function that reports working/done around every call:

```bash
source integrations/codex_hook.sh
codex "fix the bug"   # widget shows working → done automatically
```

See [`integrations/codex_hook.sh`](https://github.com/AnotherSava/ai-agent-dashboard/blob/main/integrations/codex_hook.sh) for the source. It's a 30-line Bash function that shadows the `codex` command, emits a `working` POST before the real call, and a `done` POST after (or `error` on non-zero exit).

### OpenWebUI

Paste [`integrations/openwebui_function.py`](https://github.com/AnotherSava/ai-agent-dashboard/blob/main/integrations/openwebui_function.py) into OpenWebUI → *Workspace → Functions → Add*. Enable it as a global filter or attach to specific models. The `dashboard_url` valve defaults to `http://host.docker.internal:9077` — change it if OpenWebUI runs outside Docker and needs to reach a host-side widget.

The filter hooks OpenWebUI's `inlet` (emits `working`) and `outlet` (emits `done`) per model invocation.

### Any tool (HTTP API)

The widget listens on `127.0.0.1:9077`. A minimal interaction uses curl:

```bash
# Set working status
curl -X POST http://127.0.0.1:9077/api/status \
  -H "Content-Type: application/json" \
  -d '{"action":"set","id":"my-task","status":"working","label":"doing stuff","source":"mytool"}'

# Clear when done
curl -X POST http://127.0.0.1:9077/api/status \
  -H "Content-Type: application/json" \
  -d '{"action":"clear","id":"my-task"}'
```

For Python scripts, `integrations/status_client.py` is a 30-line stdlib-only helper:

```python
from integrations.status_client import status
status("my-task", "working", "doing stuff", source="mytool")
status("my-task", "done")
```

### API reference

**POST** `/api/status`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | `"set"` or `"clear"` | yes | Set or remove a session |
| `id` | string | yes | Unique session identifier |
| `status` | enum | for `set` | `idle`, `working`, `awaiting`, `done`, `error` |
| `label` | string | no | Short description of current activity |
| `source` | string | no | Tool name — `claude`, `codex`, `openwebui`, or anything else |
| `updated` | number | no | Unix timestamp in milliseconds |
| `transcript_path` | string | no | Claude-Code-only: path to a JSONL transcript for the widget to tail |

**GET** `/events` — Server-Sent Events stream of all current sessions.

### Source icons

| Source | Icon | Color |
|--------|------|-------|
| `claude` | **C** | Terracotta |
| `codex` | **X** | Green |
| `openwebui` | **W** | Blue |
| anything else | first uppercase letter of the `source` value | Gray |

### CSRF / origin guard

The POST endpoint rejects cross-origin browser requests (those carrying `Origin: http(s)://…`). Local clients without an `Origin` header — curl, Node, Python — pass through. This stops a webpage you visit from triggering widget state changes or surfacing arbitrary URLs via the `openUrl` config action.

### Maintenance status

| Integration | Status |
|---|---|
| `integrations/claude_hook.py` | Actively maintained — see [Claude Code](claude-code). |
| `integrations/codex_hook.sh` | Shipped working, not re-verified since the rebrand. PR if broken. |
| `integrations/openwebui_function.py` | Unverified example. PR if broken. |
| `integrations/status_client.py` | Used as a template — 30 lines, stdlib only. |

### Features

- **Source-agnostic state API**: any tool can write status with three fields (`action`, `id`, `status`) — the rest is optional.
- **Server-Sent Events broadcast**: renderers receive live updates without polling.
- **First-class source icons** for known tools, auto-generated letter-on-gray for unknown sources.
- **CSRF protection** via origin header validation at the POST layer.
- **Status enum enforcement**: invalid status values are rejected with HTTP 400 rather than silently corrupting state.

### Standard features

- **Desktop notifications** on done/error transitions (toggleable via the `N` button).
- **Always on top** by default, toggleable from the Settings tab.
- **Configurable position**: four corners, chosen from the Settings tab or the tray right-click menu.
- **System tray icon**: click to show/hide, right-click for position menu and quit.
- **Auto-dismiss done sessions**: toggleable from Settings — done rows fade out after 30 s.
- **Auto-reconnect renderer**: the widget's UI reconnects to the HTTP hub on network blip with exponential backoff.

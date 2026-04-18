#!/usr/bin/env python3
"""
Claude Code hook -- reports lifecycle events to the AI Agent Dashboard widget.

Reads the hook payload JSON from stdin, derives a chat_id from the session's
cwd (or falls back to session_id), and POSTs the given status to the widget.

Configure in ~/.claude/settings.json:
    {
      "hooks": {
        "UserPromptSubmit": [{"hooks": [{"type": "command",
            "command": "python <repo>/integrations/claude_hook.py working"}]}],
        "Stop": [{"hooks": [{"type": "command",
            "command": "python <repo>/integrations/claude_hook.py done"}]}],
        "SessionEnd": [{"hooks": [{"type": "command",
            "command": "python <repo>/integrations/claude_hook.py clear"}]}],
        "SessionStart": [{"hooks": [{"type": "command",
            "command": "python <repo>/integrations/claude_hook.py idle"}]}]
      }
    }

Per-user settings (widget URL, projects root) live in <repo>/config.json --
see config.example.json for the shape.
"""
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

DEFAULT_CONFIG = {
    "widget_url": "http://127.0.0.1:9077/api/status",
    # e.g. "d:/projects" -- when set, a cwd underneath this root becomes a
    # spaced relative path as chat_id. When null, falls back to folder basename.
    "projects_root": None,
}


def default_config_path() -> Path:
    return Path(__file__).resolve().parent.parent / "config" / "config.json"


def load_config(config_path: Path) -> dict:
    config = dict(DEFAULT_CONFIG)
    if config_path.exists():
        try:
            with open(config_path) as f:
                loaded = json.load(f)
            if isinstance(loaded, dict):
                config.update(loaded)
        except Exception:
            pass
    return config


def derive_chat_id(cwd, session_id: str, projects_root) -> str:
    if isinstance(cwd, str) and cwd.strip():
        normalized = cwd.replace("\\", "/").rstrip("/")
        if isinstance(projects_root, str) and projects_root.strip():
            root = projects_root.replace("\\", "/").rstrip("/")
            if normalized.lower().startswith(root.lower() + "/"):
                rel = normalized[len(root) + 1:]
                if rel:
                    return rel.translate(str.maketrans("/-_", "   "))
        return os.path.basename(normalized) or normalized[:20]
    return f"claude-{session_id[:8] or 'unknown'}"


def build_body(arg: str, payload: dict, chat_id: str) -> dict:
    if arg == "clear":
        return {"action": "clear", "id": chat_id}
    body = {
        "action": "set",
        "id": chat_id,
        "status": arg,
        "source": "claude",
        "updated": int(time.time() * 1000),
    }
    # Forward transcript_path so the widget's log watcher can tail it.
    transcript_path = payload.get("transcript_path")
    if isinstance(transcript_path, str) and transcript_path.strip():
        body["transcript_path"] = transcript_path
    # "working" uses the user's prompt as label.
    # "idle" from a Notification (waiting for user) uses the notification message.
    # "idle" from SessionStart (no message) and "done" omit the label so the
    # widget preserves whatever was there.
    prompt = payload.get("prompt")
    message = payload.get("message")
    if arg == "working" and isinstance(prompt, str) and prompt.strip():
        body["label"] = prompt.strip().splitlines()[0][:60]
    elif arg == "idle" and isinstance(message, str) and message.strip():
        body["label"] = message.strip().splitlines()[0][:60]
    return body


def post(url: str, body: dict) -> None:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=2)
    except Exception:
        pass  # widget may not be running -- swallow


def main() -> None:
    if len(sys.argv) < 2:
        return
    arg = sys.argv[1]
    try:
        payload = json.load(sys.stdin)
    except Exception:
        payload = {}
    config = load_config(default_config_path())
    chat_id = derive_chat_id(
        payload.get("cwd"),
        payload.get("session_id") or "",
        config.get("projects_root"),
    )
    body = build_body(arg, payload, chat_id)
    post(config["widget_url"], body)


if __name__ == "__main__":
    main()

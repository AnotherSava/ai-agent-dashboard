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


def last_assistant_ends_with_question(transcript_path) -> bool:
    """Walk the transcript JSONL and return True if the latest assistant text block ends with '?'.

    Used to distinguish "truly done" (Stop / idle_prompt without a trailing question)
    from "awaiting user response" (Claude asked the user something and is blocked).
    See ~/.claude/learnings/claude-code-integration.md for the full rationale.
    """
    if not isinstance(transcript_path, str) or not transcript_path.strip():
        return False
    try:
        last_text = ""
        with open(transcript_path, "r", encoding="utf-8") as f:
            for line in f:
                try:
                    msg = json.loads(line).get("message", {}) or {}
                except Exception:
                    continue
                if msg.get("role") != "assistant":
                    continue
                content = msg.get("content", "")
                if isinstance(content, str) and content.strip():
                    last_text = content.strip()
                elif isinstance(content, list):
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "text":
                            text = block.get("text", "")
                            if isinstance(text, str) and text.strip():
                                last_text = text.strip()
        return last_text.endswith("?")
    except OSError:
        return False


def _notification_label(payload: dict) -> str:
    notif_type = payload.get("notification_type", "")
    message = payload.get("message", "") or ""
    if notif_type == "permission_prompt":
        tool = message.rsplit("use ", 1)[-1] if "use " in message else "tool"
        return f"needs approval: {tool}"
    if notif_type == "plan_approval":
        return "plan approval"
    return message


def classify(arg: str, payload: dict) -> tuple[str, str | None]:
    """Map hook argv + payload to (status, label).

    label=None means "don't set the label on the wire" (widget preserves prior value).
    """
    transcript_path = payload.get("transcript_path")
    if arg == "working":
        prompt = payload.get("prompt")
        if isinstance(prompt, str) and prompt.strip():
            return "working", prompt.strip().splitlines()[0][:60]
        return "working", None
    if arg == "done":
        if last_assistant_ends_with_question(transcript_path):
            return "awaiting", "has a question"
        return "done", None
    if arg == "idle":
        notif_type = payload.get("notification_type")
        message = payload.get("message")
        if not notif_type and not (isinstance(message, str) and message.strip()):
            return "idle", None
        if notif_type == "idle_prompt":
            if last_assistant_ends_with_question(transcript_path):
                return "awaiting", "has a question"
            return "done", None
        label = _notification_label(payload)
        label = label.strip().splitlines()[0][:60] if isinstance(label, str) and label.strip() else None
        return "awaiting", label
    return arg, None


def build_body(arg: str, payload: dict, chat_id: str) -> dict:
    if arg == "clear":
        return {"action": "clear", "id": chat_id}
    status, label = classify(arg, payload)
    body = {
        "action": "set",
        "id": chat_id,
        "status": status,
        "source": "claude",
        "updated": int(time.time() * 1000),
    }
    transcript_path = payload.get("transcript_path")
    if isinstance(transcript_path, str) and transcript_path.strip():
        body["transcript_path"] = transcript_path
    if label:
        body["label"] = label
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

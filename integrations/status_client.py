"""
Minimal status client — use from any Python script/agent.

Usage:
    from status_client import status
    status("my-task", "working", "doing stuff")
    # ... do work ...
    status("my-task", "done")
"""

import json
import time
import urllib.request


def status(chat_id: str, state: str, label: str = "", source: str = "script", url: str = "http://127.0.0.1:7890"):
    data = json.dumps({
        "action": "set",
        "id": chat_id,
        "status": state,
        "label": label,
        "source": source,
        "updated": int(time.time() * 1000),
    }).encode()
    req = urllib.request.Request(f"{url}/api/status", data=data, headers={"Content-Type": "application/json"}, method="POST")
    try:
        urllib.request.urlopen(req, timeout=2)
    except Exception:
        pass

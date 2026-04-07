"""
title: AI Status Dashboard
author: ExPLiCiT
version: 1.0.0
description: Reports model activity to the AI Status Dashboard widget. Drop this into OpenWebUI as a Filter function.
"""

import json
import urllib.request
from pydantic import BaseModel, Field


class Filter:
    class Valves(BaseModel):
        dashboard_url: str = Field(
            default="http://host.docker.internal:7890",
            description="Status dashboard URL (use host.docker.internal from Docker)",
        )

    def __init__(self):
        self.valves = self.Valves()

    def _post_status(self, chat_id: str, status: str, label: str = ""):
        data = json.dumps({
            "action": "set",
            "id": chat_id,
            "status": status,
            "label": label,
            "source": "openwebui",
            "updated": __import__("time").time() * 1000,
        }).encode()
        req = urllib.request.Request(
            f"{self.valves.dashboard_url}/api/status",
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            urllib.request.urlopen(req, timeout=2)
        except Exception:
            pass  # dashboard may not be running

    def inlet(self, body: dict, __user__: dict = None) -> dict:
        chat_id = body.get("chat_id", "openwebui")[:20]
        model = body.get("model", "unknown")
        self._post_status(chat_id, "working", f"{model}")
        return body

    def outlet(self, body: dict, __user__: dict = None) -> dict:
        chat_id = body.get("chat_id", "openwebui")[:20]
        self._post_status(chat_id, "done")
        return body

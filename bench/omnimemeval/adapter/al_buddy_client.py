"""al-buddy-memory, through a local sidecar: one SQLite store per user.

al-buddy-memory is a Node library, so this client calls a sidecar on localhost
(``bench/omnimemeval/server.mjs`` in the al-buddy-memory repository), which
holds one ``SqliteMemoryStore`` per ``user_id``.

Nothing is extracted, summarised or rewritten at write, and no model is
called: every message becomes one memory, as said, valid from its
``chat_time``, and is embedded on the device (all-MiniLM-L6-v2). A search runs
the library's hybrid recall (a keyword list and a vector list fused, with the
question's time cues read against the question's date, or the last date the
user's memory holds) and returns the ``top_k`` messages, best first, each led
by its date.

Configurable env vars:
    AL_BUDDY_URL      - the sidecar (required), e.g. http://127.0.0.1:8765
    AL_BUDDY_TIMEOUT  - seconds per call (default 900; ingestion embeds on CPU)

Only the standard library is used, so the client needs no SDK.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

from .base_client import env_float, require_env


class AlBuddyError(RuntimeError):
    """The sidecar refused or failed a call; the message is the sidecar's own."""


class AlBuddyClient:
    def __init__(self):
        self._url = require_env("AL_BUDDY_URL").rstrip("/")
        self._timeout = env_float("AL_BUDDY_TIMEOUT", 900.0, min_value=1.0)

    def _call(self, path: str, payload: dict) -> dict:
        body = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            f"{self._url}{path}",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        # The sidecar is on this machine: never send it through a proxy.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(request, timeout=self._timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            try:
                detail = json.loads(detail).get("error", detail)
            except (ValueError, AttributeError):
                pass
            raise AlBuddyError(f"al-buddy sidecar {path} failed ({exc.code}): {detail}") from exc
        except urllib.error.URLError as exc:
            raise AlBuddyError(f"al-buddy sidecar unreachable at {self._url}: {exc.reason}") from exc

    def add(self, messages, user_id, *args, **kwargs):
        """Store each message as one memory in ``user_id``'s store."""
        if not messages:
            return {"added": 0, "skippedEmpty": 0}
        rows = []
        for message in messages:
            if not isinstance(message, dict):
                message = {"role": "user", "content": str(message)}
            row = {
                "role": message.get("role") or "user",
                "content": message.get("content") or "",
            }
            for key in ("name", "chat_time"):
                if message.get(key):
                    row[key] = str(message[key])
            rows.append(row)
        return self._call("/add", {"user_id": user_id, "messages": rows})

    def search(self, query, user_id, top_k=20, question_date=None, **kwargs):
        """The ``top_k`` best memories for ``query``, best first, as text."""
        payload = {"user_id": user_id, "query": query, "top_k": int(top_k)}
        if question_date:
            payload["question_date"] = str(question_date)
        result = self._call("/search", payload)
        memories = result.get("memories")
        if not isinstance(memories, list):
            raise AlBuddyError(f"al-buddy sidecar /search returned no memories list: {result!r}"[:300])
        return [str(m) for m in memories]

    def delete(self, user_id):
        """Close and remove ``user_id``'s store; other users' stores are untouched."""
        return self._call("/delete", {"user_id": user_id})

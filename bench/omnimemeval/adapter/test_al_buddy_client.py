"""Unit tests for the al-buddy-memory client: configuration, registration, add/search/delete, user
isolation, the search dispatch, and failures.

The sidecar is replaced by a small stand-in HTTP server on localhost with the same three routes, so
these tests run offline and need neither Node nor a store.
"""

import json
import os
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from client_factory.registry import SUPPORTED_LIBS, create_client

MEMORY = {}
CALLS = []


class StandIn(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _reply(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        CALLS.append((self.path, payload))
        user = payload.get("user_id")
        if self.path == "/add":
            if payload["messages"][0]["content"] == "FAIL":
                return self._reply(500, {"error": "embedding failed"})
            MEMORY.setdefault(user, []).extend(payload["messages"])
            return self._reply(200, {"added": len(payload["messages"]), "skippedEmpty": 0})
        if self.path == "/search":
            if user not in MEMORY:
                return self._reply(404, {"error": f"no memory for user {user}"})
            words = payload["query"].lower().split()
            found = [m["content"] for m in MEMORY[user] if any(w in m["content"].lower() for w in words)]
            return self._reply(200, {"memories": found[: payload["top_k"]]})
        if self.path == "/delete":
            return self._reply(200, {"deleted": MEMORY.pop(user, None) is not None})
        return self._reply(404, {"error": "no such route"})


class AlBuddyClientTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), StandIn)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        MEMORY.clear()
        CALLS.clear()
        self.env = mock.patch.dict(os.environ, {"AL_BUDDY_URL": self.url}, clear=False)
        self.env.start()

    def tearDown(self):
        self.env.stop()

    def test_registered_with_a_template(self):
        self.assertIn("al_buddy", SUPPORTED_LIBS)
        template = Path(__file__).resolve().parents[3] / "env_examples/.env.al_buddy"
        text = template.read_text()
        self.assertIn("AL_BUDDY_URL=", text)
        self.assertNotIn("sk-", text)

    def test_url_is_required(self):
        with mock.patch.dict(os.environ, {"AL_BUDDY_URL": ""}):
            with self.assertRaises(ValueError):
                create_client("al_buddy")

    def test_add_search_delete(self):
        client = create_client("al_buddy")
        client.add(
            [
                {"role": "user", "name": "Ana", "content": "Ana: I adopted a puppy.", "chat_time": "2023-05-08T13:56:00Z"},
                {"role": "assistant", "content": "Lovely!"},
            ],
            "u1",
        )
        sent = CALLS[0][1]["messages"]
        self.assertEqual(sent[0], {"role": "user", "content": "Ana: I adopted a puppy.", "name": "Ana", "chat_time": "2023-05-08T13:56:00Z"})
        self.assertEqual(sent[1], {"role": "assistant", "content": "Lovely!"})
        self.assertEqual(client.search("puppy", "u1", 5), ["Ana: I adopted a puppy."])
        self.assertEqual(client.delete("u1"), {"deleted": True})
        with self.assertRaisesRegex(RuntimeError, "no memory for user u1"):
            client.search("puppy", "u1", 5)

    def test_question_date_is_passed_on(self):
        client = create_client("al_buddy")
        client.add([{"role": "user", "content": "I moved to Lisbon."}], "u1")
        client.search("Lisbon", "u1", 3, question_date="2023/05/30 (Tue) 23:40")
        self.assertEqual(CALLS[-1][1]["question_date"], "2023/05/30 (Tue) 23:40")

    def test_users_are_isolated(self):
        client = create_client("al_buddy")
        client.add([{"role": "user", "content": "the red kite"}], "a")
        client.add([{"role": "user", "content": "the blue kite"}], "b")
        client.delete("a")
        self.assertEqual(client.search("kite", "b", 5), ["the blue kite"])

    def test_empty_add_makes_no_call(self):
        create_client("al_buddy").add([], "u1")
        self.assertEqual(CALLS, [])

    def test_failures_raise_with_the_sidecar_message(self):
        client = create_client("al_buddy")
        with self.assertRaisesRegex(RuntimeError, "embedding failed"):
            client.add([{"role": "user", "content": "FAIL"}], "u1")

    def test_unreachable_sidecar_raises(self):
        with mock.patch.dict(os.environ, {"AL_BUDDY_URL": "http://127.0.0.1:9"}):
            client = create_client("al_buddy")
            with self.assertRaisesRegex(RuntimeError, "unreachable"):
                client.add([{"role": "user", "content": "x"}], "u1")

    def test_search_dispatch_passes_the_question_date(self):
        from utils.search_helpers import DEFAULT_SEARCH_DISPATCH, dispatch_search

        self.assertEqual(DEFAULT_SEARCH_DISPATCH["al_buddy"].__name__, "al_buddy_search")
        client = create_client("al_buddy")
        client.add([{"role": "user", "content": "I moved to Lisbon."}], "u1")
        context, _ms, reflect, raw = dispatch_search("al_buddy", client, "Lisbon", "u1", 3, question_date="2023/05/30")
        self.assertIsNone(reflect)
        self.assertEqual(raw, "I moved to Lisbon.")
        self.assertIn("I moved to Lisbon.", context)
        self.assertEqual(CALLS[-1][1]["question_date"], "2023/05/30")

    def test_locomo_shares_one_store_per_conversation(self):
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "locomo"))
        import locomo_search

        client = create_client("al_buddy")
        client.add([{"role": "user", "content": "Ana: I adopted a puppy."}], "a_user")
        _context, _ms, _reflect, raw = locomo_search.search_query(
            client, "puppy",
            {"speaker_a": "Ana", "speaker_b": "Ben", "speaker_a_user_id": "a_user", "speaker_b_user_id": "b_user"},
            "al_buddy", top_k=5,
        )
        self.assertEqual(raw, "Ana: I adopted a puppy.")
        self.assertEqual([c[1]["user_id"] for c in CALLS if c[0] == "/search"], ["a_user"])

    def test_chat_time_is_injected(self):
        from datetime import datetime, timezone
        from utils.ingest_helpers import inject_time

        messages = [{"role": "user", "content": "x"}]
        self.assertEqual(inject_time(messages, datetime(2023, 5, 8, 13, 56, tzinfo=timezone.utc), "al_buddy"), {})
        self.assertTrue(messages[0]["chat_time"].startswith("2023-05-08T13:56"))


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Contract for scripts/broker_protocol.py — the shared broker wire layer.

Both brokers delegate framing, byte caps and the socket lifecycle to this
module, but nothing executed it directly: the existing broker contracts drive
envelope validation through a broker's own `dispatch`, which never reaches
`read_request_line`, `prepare_socket_path` or `serve`. Those are exactly the
parts a maintainer cannot see failing — an overlong request that resets the
connection instead of answering, a socket left world-readable, or a stale
socket inode that makes the next start die on EADDRINUSE.
"""

from __future__ import annotations

import importlib.util
import json
import os
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).parents[1]
PROTOCOL_PATH = REPO_ROOT / "scripts" / "broker_protocol.py"


def load_module():
    spec = importlib.util.spec_from_file_location("broker_protocol", PROTOCOL_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


protocol = load_module()


class FakeConnection:
    """Feeds `read_request_line` a scripted sequence of recv() results."""

    def __init__(self, chunks):
        self.chunks = list(chunks)
        self.recv_calls = 0

    def recv(self, _size):
        self.recv_calls += 1
        if not self.chunks:
            return b""
        return self.chunks.pop(0)


class FramingTests(unittest.TestCase):
    def test_request_ends_at_the_first_newline_and_the_rest_is_not_read(self):
        connection = FakeConnection([b'{"action":"status"}\n{"action":"next"}\n'])
        self.assertEqual(protocol.read_request_line(connection), b'{"action":"status"}')

    def test_request_split_across_recv_calls_is_reassembled(self):
        connection = FakeConnection([b'{"act', b'ion":"st', b'atus"}\n'])
        self.assertEqual(protocol.read_request_line(connection), b'{"action":"status"}')

    def test_peer_that_connects_and_leaves_is_not_a_request(self):
        self.assertIsNone(protocol.read_request_line(FakeConnection([])))

    def test_empty_line_is_a_request_and_gets_a_protocol_error(self):
        connection = FakeConnection([b"\n"])
        raw = protocol.read_request_line(connection)
        self.assertEqual(raw, b"")
        with self.assertRaises(protocol.Rejected) as rejection:
            protocol.decode_request(raw, session="session-a", actions=("status",))
        self.assertEqual(rejection.exception.code, "bad-request")

    def test_overlong_request_is_capped_one_byte_past_the_limit_so_it_can_be_refused(self):
        oversized = b"x" * (protocol.MAX_REQUEST_BYTES * 2) + b"\n"
        raw = protocol.read_request_line(FakeConnection([oversized]))
        # One byte past the cap is what makes the length check fail; keeping
        # the whole line instead would mean buffering whatever was sent.
        self.assertEqual(len(raw), protocol.MAX_REQUEST_BYTES + 1)
        with self.assertRaises(protocol.Rejected) as rejection:
            protocol.decode_request(raw, session="session-a", actions=("status",))
        self.assertEqual(rejection.exception.code, "bad-request")

    def test_newline_less_flood_stops_draining_at_the_drain_cap(self):
        megabyte = b"x" * (1024 * 1024)
        connection = FakeConnection([megabyte] * 16)
        raw = protocol.read_request_line(connection)
        self.assertEqual(len(raw), protocol.MAX_REQUEST_BYTES + 1)
        # It gave up rather than reading all sixteen megabytes.
        self.assertLessEqual(connection.recv_calls, 5)
        self.assertTrue(connection.chunks)


class ResponseTests(unittest.TestCase):
    def test_json_line_is_deterministic_and_newline_terminated(self):
        line = protocol.json_line({"b": 1, "a": 2})
        self.assertEqual(line, b'{"a":2,"b":1}\n')

    def test_error_payload_is_versioned_not_ok_and_detail_bounded(self):
        payload = protocol.error_payload("bad-request", "d" * 1000)
        self.assertEqual(payload["version"], protocol.PROTOCOL_VERSION)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"], "bad-request")
        self.assertEqual(len(payload["detail"]), 240)

    def test_response_within_the_cap_is_passed_through(self):
        data = protocol.bounded_response({"version": 1, "ok": True, "state": "READY"})
        self.assertEqual(json.loads(data), {"version": 1, "ok": True, "state": "READY"})
        self.assertTrue(data.endswith(b"\n"))

    def test_oversized_response_degrades_to_a_well_formed_error(self):
        data = protocol.bounded_response(
            {"version": 1, "ok": True, "evidence": "x" * (protocol.MAX_RESPONSE_BYTES + 1)}
        )
        self.assertLessEqual(len(data), protocol.MAX_RESPONSE_BYTES)
        answer = json.loads(data)
        self.assertFalse(answer["ok"])
        self.assertEqual(answer["error"], "response-too-large")


class SocketPathTests(unittest.TestCase):
    def test_parent_directory_is_created_private(self):
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, "nested", "broker.sock")
            protocol.prepare_socket_path(path)
            mode = stat.S_IMODE(os.stat(os.path.dirname(path)).st_mode)
            self.assertEqual(mode, 0o700)

    def test_stale_inode_from_a_killed_run_is_removed(self):
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, "broker.sock")
            stale = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.addCleanup(stale.close)
            stale.bind(path)
            stale.close()
            self.assertTrue(os.path.exists(path))
            protocol.prepare_socket_path(path)
            self.assertFalse(os.path.exists(path))

    def test_existing_directory_is_accepted(self):
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, "broker.sock")
            protocol.prepare_socket_path(path)
            protocol.prepare_socket_path(path)


SERVER_SCRIPT = textwrap.dedent(
    """
    import importlib.util, json, sys, types
    spec = importlib.util.spec_from_file_location("broker_protocol", sys.argv[1])
    protocol = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = protocol
    spec.loader.exec_module(protocol)

    socket_path, stopped_marker = sys.argv[2], sys.argv[3]
    context = types.SimpleNamespace(session="session-a")
    ACTIONS = ("status",)

    def dispatch(context, raw):
        try:
            request = protocol.decode_request(raw, session=context.session, actions=ACTIONS)
        except protocol.Rejected as rejected:
            return protocol.error_payload(rejected.code, rejected.detail)
        return {"version": 1, "ok": True, "action": request["action"]}

    def on_stop(_context):
        with open(stopped_marker, "w") as handle:
            handle.write("stopped")

    sys.exit(protocol.serve(socket_path, context, dispatch, on_stop=on_stop))
    """
)


class ServeLifecycleTests(unittest.TestCase):
    """`serve` is the whole broker runtime; nothing else executes it."""

    def start_server(self, root):
        socket_path = os.path.join(root, "broker.sock")
        stopped_marker = os.path.join(root, "stopped")
        process = subprocess.Popen(
            [sys.executable, "-c", SERVER_SCRIPT, str(PROTOCOL_PATH), socket_path, stopped_marker],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.addCleanup(self.stop_server, process)
        ready = process.stdout.readline()
        self.assertTrue(ready, "broker exited before announcing readiness")
        self.assertEqual(
            json.loads(ready),
            {"version": protocol.PROTOCOL_VERSION, "ready": True, "session": "session-a"},
        )
        return socket_path, stopped_marker, process

    def stop_server(self, process):
        if process.poll() is None:
            process.kill()
            process.wait(timeout=10)
        for stream in (process.stdout, process.stderr):
            if stream is not None:
                stream.close()

    def call(self, socket_path, payload):
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.settimeout(10)
        try:
            client.connect(socket_path)
            client.sendall(payload)
            chunks = []
            while b"\n" not in b"".join(chunks):
                chunk = client.recv(8192)
                if not chunk:
                    break
                chunks.append(chunk)
        finally:
            client.close()
        return json.loads(b"".join(chunks))

    def test_socket_is_owner_only_and_answers_then_unlinks_on_sigterm(self):
        with tempfile.TemporaryDirectory() as root:
            socket_path, stopped_marker, process = self.start_server(root)

            mode = stat.S_IMODE(os.stat(socket_path).st_mode)
            self.assertEqual(mode, 0o600, "a broker socket must not be reachable by other users")

            answer = self.call(
                socket_path,
                protocol.json_line({"version": 1, "action": "status", "session": "session-a"}),
            )
            self.assertEqual(answer, {"version": 1, "ok": True, "action": "status"})

            # A second caller is served after the first: the request loop is
            # not single-shot.
            answer = self.call(
                socket_path,
                protocol.json_line({"version": 1, "action": "teardown", "session": "session-a"}),
            )
            self.assertEqual(answer["error"], "unknown-action")

            process.send_signal(signal.SIGTERM)
            self.assertEqual(process.wait(timeout=30), 0)
            self.assertFalse(
                os.path.exists(socket_path),
                "a stopped broker must not leave an inode the next start dies on",
            )
            self.assertTrue(os.path.exists(stopped_marker), "on_stop must run on shutdown")

    def test_overlong_request_is_answered_rather_than_reset(self):
        with tempfile.TemporaryDirectory() as root:
            socket_path, _stopped_marker, _process = self.start_server(root)
            flood = protocol.json_line(
                {
                    "version": 1,
                    "action": "status",
                    "session": "session-a",
                    "padding": "x" * (protocol.MAX_REQUEST_BYTES * 2),
                }
            )
            answer = self.call(socket_path, flood)
            self.assertFalse(answer["ok"])
            self.assertEqual(answer["error"], "bad-request")

    def test_connecting_and_leaving_does_not_kill_the_broker(self):
        with tempfile.TemporaryDirectory() as root:
            socket_path, _stopped_marker, process = self.start_server(root)
            drive_by = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            drive_by.connect(socket_path)
            drive_by.close()
            time.sleep(0.5)
            self.assertIsNone(process.poll(), "a client that leaves must not stop the broker")
            answer = self.call(
                socket_path,
                protocol.json_line({"version": 1, "action": "status", "session": "session-a"}),
            )
            self.assertTrue(answer["ok"])

    def test_stale_socket_from_a_previous_run_does_not_block_a_start(self):
        with tempfile.TemporaryDirectory() as root:
            stale = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            stale.bind(os.path.join(root, "broker.sock"))
            stale.close()
            socket_path, _stopped_marker, _process = self.start_server(root)
            answer = self.call(
                socket_path,
                protocol.json_line({"version": 1, "action": "status", "session": "session-a"}),
            )
            self.assertTrue(answer["ok"])


if __name__ == "__main__":
    unittest.main()

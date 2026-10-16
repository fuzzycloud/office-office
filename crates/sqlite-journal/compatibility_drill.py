#!/usr/bin/env python3
"""Compare old/new storage using disposable offices; never uses a live database."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


class Server:
    def __init__(self, binary, database, directory):
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        sock.close()
        self.base = f"http://127.0.0.1:{port}"
        env = os.environ.copy()
        env.update(
            ADDR=f"127.0.0.1:{port}",
            OFFICE_DATABASE_PATH=str(database),
            OFFICE_DEMO_MODE="false",
            OFFICE_ALLOW_REMOTE="false",
            OFFICE_LITESTREAM_ENABLED="false",
        )
        env.pop("OFFICE_FILES_BUCKET", None)
        env.pop("OFFICE_MCP_ALLOWED_HOSTS", None)
        self.log = open(directory / f"server-{port}.log", "wb")
        self.process = subprocess.Popen(
            [str(binary)], env=env, stdout=self.log, stderr=self.log
        )
        for _ in range(100):
            if self.process.poll() is not None:
                self.stop()
                raise RuntimeError("Disposable server exited; private fixture logs suppressed")
            try:
                with urllib.request.urlopen(self.base + "/healthz", timeout=2) as response:
                    if response.read().strip() == b"ok":
                        return
            except (urllib.error.URLError, TimeoutError):
                pass
            time.sleep(0.1)
        self.stop()
        raise RuntimeError("Disposable server did not become healthy")

    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
            self.process.wait(timeout=20)
        self.log.close()

    def rpc(self, method, body=None, token=None, expected=200):
        headers = {"Content-Type": "application/json", "Connect-Protocol-Version": "1"}
        if token:
            headers["Authorization"] = "Bearer " + token
        request = urllib.request.Request(
            self.base + "/rpc/office.v1.OfficeService/" + method,
            data=json.dumps(body or {}).encode(),
            headers=headers,
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                status, content = response.status, response.read()
        except urllib.error.HTTPError as error:
            status, content = error.code, error.read()
        if status != expected:
            raise RuntimeError(f"{method}: expected HTTP {expected}, got {status}; body suppressed")
        return json.loads(content)


def snapshot(path):
    with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as db:
        return {
            "schema": db.execute("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").fetchall(),
            "version": db.execute("PRAGMA user_version").fetchone(),
            "events": db.execute("SELECT * FROM events ORDER BY sequence").fetchall(),
            "passwords": db.execute("SELECT * FROM passwords ORDER BY member_id").fetchall(),
            "agent_secrets": db.execute("SELECT * FROM agent_secrets ORDER BY key_id").fetchall(),
            "private_config": db.execute("SELECT * FROM private_config ORDER BY id").fetchall(),
        }


def copy_database(source, destination):
    with sqlite3.connect(f"file:{source}?mode=ro", uri=True) as src:
        with sqlite3.connect(destination) as dst:
            src.backup(dst)
    os.chmod(destination, 0o600)


def sqlx_shape_check(source, destination, migration):
    """Exercise the mapping, not SQLx runtime/transaction-hook integration."""
    copy_database(source, destination)
    original = snapshot(source)
    with sqlite3.connect(destination) as db:
        db.executescript(migration.read_text().replace("{{name}}", "office"))
        with db:
            for sequence, event_id, kind, version, occurred_at, payload in original["events"]:
                timestamp = datetime.fromtimestamp(occurred_at, timezone.utc).isoformat().replace("+00:00", "Z")
                metadata = json.dumps({"legacy_sequence": sequence, "legacy_event_version": version})
                db.execute(
                    "INSERT INTO office_events(id,stream_id,version,name,data,metadata,created_utc) VALUES(?,?,?,?,?,?,?)",
                    (event_id, "workspace", sequence - 1, kind, payload, metadata, timestamp),
                )
            if original["events"]:
                db.execute(
                    "INSERT INTO office_streams VALUES(?,?,?)",
                    ("workspace", len(original["events"]) - 1, timestamp),
                )
        recovered = []
        for event_id, version, kind, payload, metadata, timestamp in db.execute(
            "SELECT id,version,name,data,metadata,created_utc FROM office_events ORDER BY version"
        ):
            metadata = json.loads(metadata)
            assert version == metadata["legacy_sequence"] - 1
            recovered.append((metadata["legacy_sequence"], event_id, kind,
                              metadata["legacy_event_version"],
                              int(datetime.fromisoformat(timestamp).timestamp()), payload))
        assert recovered == original["events"]
        assert db.execute("PRAGMA integrity_check").fetchone() == ("ok",)
    converted = snapshot(destination)
    for name in ("events", "passwords", "agent_secrets", "private_config", "version"):
        assert converted[name] == original[name]
    print(f"SQLx layout dry run: {len(recovered)} event envelopes mapped reversibly; private tables unchanged.")


def identity_shape_check(source, destination):
    """Check account extraction only; this is not an application migration."""
    copy_database(source, destination)
    original = snapshot(source)
    members, keys = {}, {}
    for _, _, kind, _, _, payload in original["events"]:
        record = json.loads(payload)
        if kind == "member":
            members[record["id"]] = record
        elif kind == "agent_key":
            keys[record["id"]] = record

    def extract(db, fail=False):
        # JSON snapshots exercise lossless extraction, not a production schema.
        db.execute("CREATE TABLE account_members (id TEXT PRIMARY KEY, record TEXT NOT NULL)")
        db.execute("CREATE TABLE account_keys (id TEXT PRIMARY KEY, record TEXT NOT NULL)")
        for table, records in (("account_members", members), ("account_keys", keys)):
            db.executemany(f"INSERT INTO {table} VALUES (?, ?)",
                           [(identifier, json.dumps(record)) for identifier, record in records.items()])
        db.execute("PRAGMA user_version = 2")
        if fail:
            raise RuntimeError("deliberate local migration failure")

    with sqlite3.connect(destination) as db:
        try:
            with db:
                db.execute("BEGIN IMMEDIATE")
                extract(db, fail=True)
        except RuntimeError:
            pass
        assert snapshot(destination) == original, "Failed extraction did not roll back"
        with db:
            db.execute("BEGIN IMMEDIATE")
            extract(db)
        restored_members = dict((identifier, json.loads(record)) for identifier, record in
                                db.execute("SELECT id,record FROM account_members"))
        restored_keys = dict((identifier, json.loads(record)) for identifier, record in
                             db.execute("SELECT id,record FROM account_keys"))
        assert restored_members == members and restored_keys == keys
        assert any(member.get("bio") for member in restored_members.values())
        assert any(key.get("revoked") for key in restored_keys.values())
        for member_id, _ in original["passwords"]:
            assert member_id in restored_members
        for key_id, _, owner_id in original["agent_secrets"]:
            assert owner_id in restored_members and key_id in restored_keys
            assert not restored_keys[key_id].get("revoked", False)
        assert db.execute("PRAGMA integrity_check").fetchone() == ("ok",)
    converted = snapshot(destination)
    for name in ("events", "passwords", "agent_secrets", "private_config"):
        assert converted[name] == original[name]
    assert converted["version"] == (2,)
    assert snapshot(source) == original
    print(f"Account extraction dry run: {len(members)} members and {len(keys)} key records copied losslessly; failure rollback passed.")
    print("Legacy history and credentials retained; application cutover and post-cutover writes NOT implemented.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("legacy_binary", type=Path)
    parser.add_argument("prototype_binary", type=Path)
    parser.add_argument("--sqlx-schema", type=Path, required=True)
    args = parser.parse_args()
    args.legacy_binary = args.legacy_binary.resolve()
    args.prototype_binary = args.prototype_binary.resolve()
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix="office-journal-compatibility-") as temporary:
        directory = Path(temporary)
        legacy_db, candidate_db = directory / "legacy.db", directory / "candidate.db"
        server = Server(args.legacy_binary, legacy_db, directory)
        try:
            bootstrap = server.rpc("BootstrapAdmin", {
                "name": "Compatibility admin", "email": "compatibility@example.test",
                "password": "disposable-compatibility-password-123",
                "workspaceName": "Disposable compatibility office", "loadDemoData": True,
            })
            admin = bootstrap["token"]
            agent = server.rpc("SaveMember", {"member": {
                "name": "Compatibility agent", "kind": "agent", "role": "member", "status": "active",
            }}, admin)
            raw_key = agent["secret"]
            agent_token = server.rpc("ExchangeAgentKey", {"key": raw_key})["token"]
            revoked = server.rpc("SaveMember", {"member": {
                "name": "Revoked compatibility agent", "kind": "agent", "role": "viewer", "status": "active",
            }}, admin)
            server.rpc("RevokeAgentKey", {"id": revoked["agentKey"]["id"]}, admin)
            workspace = server.rpc("GetWorkspace", token=admin)
            task = workspace["tasks"][0]
            server.rpc("SaveTaskComment", {"taskId": task["id"], "body": "Compatibility finding."}, agent_token)
            server.rpc("SaveProfile", {"bio": "A real pipeline, with disposable fixture records."}, agent_token)
            notification = server.rpc("CreateNotification", {
                "requestId": "compatibility-request", "title": "Review the task", "kind": "response_request",
                "recipientIds": [agent["member"]["id"]], "sourceKind": "task", "sourceId": task["id"],
            }, admin)["notifications"][0]
            server.rpc("UpdateNotification", {
                "id": notification["id"], "expectedRevision": 1,
                "action": "claim", "claimId": "compatibility-claim",
            }, agent_token)
            expected_workspace = server.rpc("GetWorkspace", token=admin)
            expected_poll = server.rpc("PollNotifications", {"afterCursor": "0"}, agent_token)
        finally:
            server.stop()
        original = snapshot(legacy_db)
        copy_database(legacy_db, candidate_db)
        server = Server(args.prototype_binary, candidate_db, directory)
        try:
            assert server.rpc("GetWorkspace", token=admin) == expected_workspace
            assert server.rpc("PollNotifications", {"afterCursor": "0"}, agent_token) == expected_poll
            server.rpc("Login", {"email": "compatibility@example.test", "password": "disposable-compatibility-password-123"})
            server.rpc("ExchangeAgentKey", {"key": raw_key})
            server.rpc("ExchangeAgentKey", {"key": revoked["secret"]}, expected=401)
            assert snapshot(candidate_db) == original, "Opening/reading changed saved state"
            server.rpc("SaveCustomer", {"customer": {
                "name": "New compatibility customer", "company": "Example fixtures", "status": "active",
            }}, admin)
            after_write = server.rpc("GetWorkspace", token=admin)
        finally:
            server.stop()
        new_snapshot = snapshot(candidate_db)
        assert new_snapshot["events"][:len(original["events"])] == original["events"]
        for key in ("schema", "version", "passwords", "agent_secrets", "private_config"):
            assert new_snapshot[key] == original[key]
        server = Server(args.legacy_binary, candidate_db, directory)
        try:
            assert server.rpc("GetWorkspace", token=admin) == after_write
            assert server.rpc("PollNotifications", {"afterCursor": "0"}, agent_token) == expected_poll
        finally:
            server.stop()
        assert snapshot(legacy_db) == original, "Source database changed"
        print(f"Rusqlite extraction: {len(original['events'])} legacy events preserved exactly; no row/schema conversion.")
        print("Password login, existing human/AI JWTs, active/revoked AI keys and notification cursor/claim replay passed.")
        print("Prototype append and old-binary reopen passed; original source stayed unchanged.")
        sqlx_shape_check(legacy_db, directory / "sqlx-shape.db", args.sqlx_schema)
        identity_shape_check(legacy_db, directory / "account-shape.db")
    print("Only temporary local offices were used and removed; hosted office untouched.")


if __name__ == "__main__":
    main()

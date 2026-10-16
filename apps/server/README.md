# Office Office server

Run from the repository root with `just server` or `cargo run -p office-server`. The binary binds to `127.0.0.1:8080` by default, serves ConnectRPC at `/rpc`, health at `/healthz`, and the built web app from `apps/web/dist` when present. The default mode opens `data/office-office.sqlite3`; `OFFICE_DATABASE_PATH` selects another database file.

## Durable default

The public async `OfficePreviewService::open(path)` opens SQLite storage and replays its event log into the in-memory read projection. A new database starts with an empty workspace; the first visitor creates an administrator through `BootstrapAdmin`. Passwords are Argon2 hashes, AI key secrets are stored as digests, and the JWT signing key and setup state live in private SQLite tables. Sessions and workspace records therefore persist across server restarts when the database file is retained.

Katha supplies the event aggregate and replayable event log. Kathputli serializes commands through one actor. SQLite uses WAL mode and `synchronous=FULL`, with an exclusive process lock for the database file. The rusqlite adapter writes domain events, activity events and credential state in one transaction. RPC success follows commit; a failed save rolls back the staged in-memory state. It deliberately does not use `katha-sqlx`, because the credential tables and events need the same transaction boundary.

The service closes the actor and storage after Axum graceful shutdown. Run only one process per database. Protect the database, its lock file and backups because they contain the signing key and account data. No provider secrets are stored. Retention, export, throttling, public authentication controls and hosted recovery monitoring are still deferred; durable storage alone does not make this a production-ready service.

## Explicit in-memory demo

Set `OFFICE_DEMO_MODE=true` to select `OfficePreviewService::new()` and temporary in-memory storage. No records are inserted before registration. The first-admin screen preselects **Start with sample office data**, which can be unchecked; the `load_demo_data` request flag runs the scenario through typed engine commands. The same checkbox can populate a persistent SQLite office. Temporary accounts/records reset on restart, while SQLite-backed samples persist. Sample mode is independent of remote binding and never contacts external services.

`execute(token, EngineCommand)` is the transport-free command entry point; RPC record writes use it too. `bootstrap`, `authenticate` and `workspace` support a direct test harness. All of these still enter the actor and normal authorization/event/persistence path. See [starter data and engine testing](../../docs/demo.md).

The typed `office.v1.OfficeService` exposes setup, login, workspace read, and per-record save methods for team members, customers, projects, research reports, social queue records and settings. Reports have dedicated paginated list and detail methods; saves check the current revision before appending events. Human and agent clients use the same domain policy. Projects have multiple boards and tasks. Create an AI user in Team to generate its member-bound login key; the key inherits the user's current fixed role and has no separate scopes. MCP accepts that key directly or a short-lived access token; see [MCP setup](../../docs/mcp.md). Saving a queued post records a plan; it never publishes or sends anything to a provider.

## Network and container

A non-loopback `ADDR` requires `OFFICE_ALLOW_REMOTE=true`. This acknowledges remote ingress only; protect bootstrap behind a private ingress and do not expose the preview publicly. The container sets `ADDR=0.0.0.0:8080`, `OFFICE_ALLOW_REMOTE=true` and `OFFICE_DATABASE_PATH=/data/office-office.sqlite3`. It runs as UID 10001 and creates `/data` with mode `0700`. Mount persistent storage there and preserve it across restarts.

The container bundles pinned Litestream 0.5.17, disabled by default. When enabled with `OFFICE_LITESTREAM_ENABLED=true`, its supervisor runs the server and handles replication and missing-database restore; see [storage and recovery](../../docs/storage.md). Local file-backend and isolated S3-compatible upload/restore drills passed integrity and content checks. Hosted-office migration and ongoing backup monitoring remain operator responsibilities.

# Office Office preview server

Run from the repository root with `just server` or `cargo run -p office-server`. No token or data-path environment variable is required. The server binds to `127.0.0.1:8080` by default, serves ConnectRPC at `/rpc`, health at `/healthz`, and the built web app from `apps/web/dist` when present. Binding to a non-loopback address requires `OFFICE_DEMO_MODE=true`.

This is an **in-memory demo**. It seeds clearly marked sample records, but no login account. The first visitor creates an administrator through `BootstrapAdmin`; subsequent users can log in only after an admin gives them a temporary password. Passwords are Argon2-hashed, sessions are 15-minute HS256 JWTs signed by a random per-process key, and permissions are checked against the current account state on every RPC. Restarting the server erases accounts, edits, and sessions.

The typed `office.v1.OfficeService` exposes setup, login, workspace read, and per-record save methods for team members, customers, projects, social queue records, and settings. Human and agent clients use the same domain policy. Projects have multiple boards and tasks. The Streamable HTTP MCP endpoint at `/mcp` accepts scoped AI keys issued in Settings; see [MCP setup](../../docs/mcp.md). Social connections are disconnected samples. Saving a queued post records a plan; it never publishes or sends anything to a provider. There are no provider credentials in this preview.

The preview uses a `kathputli` actor to serialize commands and a `katha` aggregate plus append-only in-memory events to project workspace state. Credentials and the JWT key stay outside those events. Durable SQLite storage with Litestream recovery is planned for the next phase; this server does not claim persistence or real integrations.

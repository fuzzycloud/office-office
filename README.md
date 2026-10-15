# Office Office

A shared daily office workspace for humans and AI. Office Office is building toward a clear view of targets, strategy, projects, pricing history and progress. It is independent open-source software, inspired by the Hindi sitcom [Office Office](https://en.wikipedia.org/wiki/Office_Office), and is not affiliated with the show or its creators.

Office Office owns office records and its social publishing queue. External clients and runtimes, such as Hermes, execute agents and manage their conversations. Office Office does not provide another agent runtime.

## Current phase

The default server stores workspace events and private authentication state in SQLite at `data/office-office.sqlite3`. Katha supplies the event aggregate and replayable events; kathputli serializes commands through one actor. SQLite uses WAL mode and `synchronous=FULL`. One process holds an exclusive lock for a database file. A command's domain events, activity record and authentication state commit in one transaction; the RPC succeeds only after commit, and a failed transaction rolls the staged state back. The in-memory read projection is rebuilt by replaying the event log at startup.

The initial durable workspace is empty. Bootstrap creates the first administrator using a workspace name, name, email and password. Passwords use Argon2 hashes. AI keys are shown once and only their digests are stored. The JWT signing key and setup state live in private SQLite tables so sessions remain valid across a restart. Roles are `admin`, `manager`, `member` and `viewer`; fixed role permissions cover team, customers, projects, reports, social and settings. The server checks permissions on every RPC. Workspace settings include timezone and the full set of 35 daisyUI themes.

On the first-admin screen, optionally select **Start with sample office data**. The server runs an explicit starter scenario through the same typed commands, validation, permissions, actor and events as normal writes. It creates labeled sample teammates, customers, a project with boards and tasks, a research report, and a disconnected social channel with a draft post. The administrator chooses their own password; sample teammates have no shared login credentials. Bootstrap and the complete scenario commit atomically.

This is optional starter content for testing and exploring the app. With normal SQLite storage the samples survive restarts and remain ordinary editable records. `OFFICE_DEMO_MODE=true` instead selects temporary in-memory storage and preselects the sample option on registration; the choice can still be unchecked. No mode sends posts, invitations or provider requests. A non-loopback `ADDR` separately requires `OFFICE_ALLOW_REMOTE=true`; protect the initial setup behind a private ingress.

## Run locally

Prerequisites: Rust with edition 2024 support, Node 24, pnpm 12 (pinned in `package.json`), Buf CLI, and `protoc` if required by the Rust code generator.

```sh
pnpm install
just generate
just server
```

In another terminal, run `just web` and open the Vite URL. The durable server creates the `data` directory and database as needed. Choose the workspace and first admin credentials on the bootstrap screen. Keep local use on loopback unless you have deliberately configured and protected an ingress.

For a container, mount persistent storage at `/data`; the image runs as UID 10001, stores the database at `/data/office-office.sqlite3`, and restricts the directory to owner access. Preserve that volume across restarts. Container networking sets `OFFICE_ALLOW_REMOTE=true`; put the service behind a private ingress and do not expose its bootstrap endpoint publicly.

## Development

The protobuf service is the shared domain boundary for the browser and agents. Project workspaces support multiple boards with custom columns and tasks, owners, priorities and due dates. Task details include comments and a separate activity timeline for humans and agents. Comments support revision-checked edits and event-based soft deletion. See [tasks and discussions](docs/tasks.md). The MCP adapter uses the same actor commands and permission checks. Sample records are created by an explicit engine-command scenario, not by pre-filling projections, direct database inserts or frontend fixtures. Tests can call the typed engine without starting an HTTP server. See [starter data and engine testing](docs/demo.md). Run `just check` for the repository's full check suite; `just generate` lints protobuf and regenerates the TypeScript client. Do not edit generated clients by hand. `just test-e2e` builds the UI and server and runs isolated browser/HTTP scenarios against disposable SQLite offices, including task discussions, reports, permissions, restart persistence and MCP access. See [automated testing](docs/testing.md) for setup, focused runs and failure reports.

The durable adapter uses rusqlite to put event writes and private credential tables in the same SQLite transaction; it does not use `katha-sqlx`. This preserves the one-writer model and atomic commit boundary. It is not a claim of production readiness: retention, export, request throttling, a public authentication perimeter and a verified restore process remain to be completed.

## Research reports

The Reports library holds research pages with findings, sources, topics, reporting periods and optional project/task links. Humans can write them in the UI; agents can list, read and save them through MCP using the permissions of their assigned role. Each recurring investigation can produce a new edition without replacing the previous report. Revision checks prevent stale saves from overwriting another editor. Report events survive restarts in SQLite.

See [research reports](docs/reports.md) for the workflow and agent examples. Research scheduling and execution remain with external clients and runtimes. Marketing analytics and campaign connectors remain future work; the app does not invent metrics.

## AI access

Humans and AI share the same fixed roles: Admin, Manager, Member and Viewer. The **Roles & Permissions** page shows the server's presets; users and keys have no separate permission overrides. Admins can manage users and keys whether they are human or AI. At least one active human administrator with a password must remain for recovery. See [roles and permissions](docs/roles.md).

Create an AI user in Team with a name and role. Its login key is generated automatically and shown once. Copy it into the client's protected configuration; only a digest is stored. Keys expire after 90 days. An administrator can rotate a user's key, immediately invalidating all old keys and their sessions, or revoke a key. A key authenticates exactly one AI member and inherits that member's current role. Disabling the member or changing its role takes effect on subsequent calls.

Humans obtain tokens with email/password; AI clients exchange their keys through `ExchangeAgentKey`. MCP also accepts `Authorization: Bearer <ai-key>` and performs that exchange internally, supporting clients with static bearer headers. Functional RPCs still require the short-lived access token. No provider secrets are forwarded. Existing v0.3 AI-member keys remain valid; legacy creator-bound v0.2 keys require replacement. Legacy member access lists and key scopes are ignored under the new fixed-role policy, which can broaden access relative to an old restricted key. Review assigned roles before upgrading. Project-level access grants remain unimplemented: role permissions and project filters do not provide client isolation. See [agent team access](docs/agent-team-access.md).

MCP access is independent of a runtime or watcher. Hermes, Claude Code, Codex and other clients can be configured against supported authentication flows; client compatibility must be verified. A [Ready-based dispatch workflow](docs/agent-dispatch.md) is an optional external integration, not a prerequisite for agent access. Boards do not launch agents yet.

Connect an MCP client such as Hermes to `http://127.0.0.1:8080/mcp` using Streamable HTTP and `Authorization: Bearer <ai-key-or-access-token>`. See [MCP setup and tools](docs/mcp.md). Tools read role-authorized workspace records and create or update boards, tasks and research reports. Admin-only tools create AI users and rotate their keys. No tool contacts providers or publishes posts.

## Storage and limits

The database is the source of truth for the event log, password hashes, AI key digests, setup state and JWT signing key. The signing key is private to the database file, so protect and back up the database as a unit. No provider secrets are stored yet. Durable storage does not provide data retention controls, export, rate limiting, audited provider operations or a verified backup restore.

See [storage and recovery](docs/storage.md) for the database lifecycle and the [Litestream template](deploy/litestream.yml).

Litestream can be configured separately by an operator for offsite replication; it is not bundled with or started by this application, and this repository does not verify uploaded backups or restoration. It does not provide active-active service or high availability. Restore and validate a copy before pointing the service at it. Never run multiple server processes against the same database.

## Hosting and releases

Version-tagged GHCR images are previews, not a production-ready deployment. Operator deployments are managed separately from this public repository. See [hosting notes](docs/hosting.md) and [release management](docs/releases.md).

## Decisions and security

See [architecture](docs/architecture.md), [ADR 0002: UI-first demo and SQLite direction](docs/adr/0002-ui-first-sqlite.md), and [security boundaries](docs/security.md).

## License

MIT OR Apache-2.0. See LICENSE-MIT and LICENSE-APACHE.

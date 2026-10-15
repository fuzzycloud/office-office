# Architecture

Office Office is a shared business workspace for humans and AI. It provides office records and a social publishing queue; Hermes remains responsible for messaging and agent execution. Targets, strategy, pricing history and progress remain part of the product direction.

## Service boundary

The React application uses the generated ConnectRPC client. Axum serves the RPC service under `/rpc`, the UI and a health route. Protobuf is the transport contract. The browser and agents use the same RPC policy; UI checks are convenience, not an authorization boundary. The Streamable HTTP MCP adapter at `/mcp` calls the same actor commands and authorization policy.

## Durable default

Unless `OFFICE_DEMO_MODE=true`, the server opens `data/office-office.sqlite3` (overridable with `OFFICE_DATABASE_PATH`) through the public async `OfficePreviewService::open(path)` API. The first durable workspace has no sample records. Bootstrap collects workspace name and admin name, email and password. Password hashes use Argon2; AI keys are returned once and stored as digests. The JWT signing key and setup state are kept in private SQLite tables, so authentication survives process restarts with the database.

Katha represents the event aggregate and event log. On startup, the server replays events to rebuild its in-memory read projection. Kathputli serializes commands through one actor, and an exclusive process lock prevents another server process from opening the same database. SQLite runs in WAL mode with `synchronous=FULL`. The durable rusqlite adapter deliberately does not use `katha-sqlx`: it writes domain events, activity records, password hashes, AI key digests and setup state in one SQLite transaction. The server returns success only after commit. If persistence fails, it restores the staged in-memory state and returns an error. Private credentials and the JWT signing key are outside the public domain event log.

This is durable local storage, not a production-ready service. Retention and export controls, request throttling, durable audit policy, a public authentication perimeter and verified backup restoration remain unfinished. No social provider credentials are stored.

Project records own multiple named boards with custom columns. Tasks reference a project, its board and a valid column, and may include an owner, priority and due date. These writes share the same transactional event path as other office records. Task discussions use dedicated read RPCs, with revision-checked comment create/edit and soft-delete commands. Server-owned authorship and timestamps accompany comments; task activity remains separate from the conversation. Discussions follow stable task IDs across board moves, and visible comment counts are derived from non-deleted records. Comment events and activity commit in the same transaction as the command. See [tasks and discussions](tasks.md).

Research reports use dedicated list/detail/save RPCs so opening the workspace does not load every full report body. Lists return paginated metadata with body omitted. Saves run through the same kathputli actor and transactional katha event path as other records. Each report records server-owned authorship, timestamps and a monotonically increasing revision. Updates require the current expected revision; a recurring edition is a new report sharing a topic and period label. Source URLs accept HTTP/HTTPS only and are stored without fetching external content. The reports module and MCP report scopes follow existing live role checks. Draft/published statuses are editorial states, not separate ACLs or approvals. Analytics and campaign-data ingestion remain deferred. See [research reports](reports.md).

## Explicit demo mode

`OFFICE_DEMO_MODE=true` selects `OfficePreviewService::new()` and its temporary in-memory storage. Sample data is a separate first-admin registration option (`load_demo_data`). The environment flag preselects that option in the UI but does not insert records before registration. The same option works with SQLite and persists its sample records.

`EngineCommand` is the public typed command DTO and `EngineOutcome` its result. RPC record-write adapters and direct in-process callers use `OfficePreviewService::execute(token, command)`; it sends the command through the same kathputli mailbox, current authorization checks, validation, katha events, projection changes and storage commit. Direct callers do not receive a privileged fake principal. `bootstrap`, `authenticate` and `workspace` expose the corresponding transport-free setup/auth/read operations. Commands also support tagged JSON DTOs.

During an opted-in bootstrap, the actor executes each starter command through that same core dispatcher inside the bootstrap snapshot. This avoids a recursive mailbox request and places the administrator, sample marker, fixtures and activity in one SQL transaction. A failed scenario rolls the entire bootstrap back. A persisted scenario/version event records that starter data was loaded; repeating bootstrap is rejected. The projection starts empty and is never seeded directly.

Samples are ordinary records for testing and exploration. They use generated IDs, visibly sample labels, fictitious `example.test` contacts, pending teammates without passwords, and disconnected demo-only channels. Their creation never sends invitations or provider requests. Sample state (`demo_mode`) is separate from durability (`persistent_storage`) in setup/workspace responses. Event-based soft deletion is available for task comments; deletion of other record types remains planned. No hard-reset or erase-history endpoint is introduced. See [starter data and engine testing](demo.md).

Roles are `admin`, `manager`, `member` and `viewer`. Module access is assigned for team, customers, projects, reports, social and settings. Admins manage teams and settings; managers and members can write within modules they can access; viewers are read-only. The server rechecks role and module access on each request. Workspace settings include timezone and all 35 daisyUI themes.

## Network and storage operations

The binary binds to `127.0.0.1:8080` by default. A non-loopback `ADDR` requires `OFFICE_ALLOW_REMOTE=true`; this is an explicit remote-ingress acknowledgement and does not enable authentication hardening or public safety. Keep bootstrap behind a private ingress. The container sets `ADDR=0.0.0.0:8080` and `OFFICE_ALLOW_REMOTE=true`, runs as UID 10001, and uses `/data/office-office.sqlite3`. Mount a persistent volume at `/data`; its directory is mode `0700`. The database and lock files must remain private to the service account.

Litestream is optional operator configuration for offsite replication. It is not bundled or run by the server. Backup upload, restore and recovery are not verified by this project; an operator must test restoring and validating a copy before serving from it. WAL mode still supports only one application process per database. Do not run active-active instances against a shared file.

## Access and integrations

Authentication and authorization apply at the RPC layer. JWTs expire after 15 minutes, and each request checks current role and module access so role changes take effect immediately. Demo setup is intended for loopback use. MCP bearer keys are scoped, expire within 90 days, and are bound to their creator's current permissions. Keys cannot administer accounts or other keys.

The social queue saves plans but has no posting adapter. Social OAuth, external posting and invitations are unavailable. Business integrations such as Zoho remain read-only by default. Any future narrow write action needs its own permission, idempotency key, provider receipt and audit record. Provider credentials are not currently stored. Never forward provider secrets to agents.

Hermes owns Telegram, Slack, WhatsApp/Evolution and other conversational channels and agent execution. MCP initial tools read scoped workspace records and save boards, tasks or reports; agents never read storage directly.

## Hosting and product conventions

GHCR images are published only for version tags and remain previews; the public repository does not configure an operator-specific deployment. See [hosting](hosting.md) for the deployment boundary. The UI uses React and Vite; the service uses Rust, Axum and ConnectRPC. The protobuf contract is in `proto/office/v1/office.proto`; `just generate` regenerates clients. Use pnpm for frontend work and follow the root `AGENTS.md` for focused checks. Never hand-edit generated clients.

# Architecture

Office Office is a shared business workspace for humans and AI. It provides office records and a future social publishing queue; Hermes remains responsible for messaging and agent execution. Targets, strategy, projects, pricing history and progress remain part of the product direction.

## Current UI-first phase

The React application uses the generated ConnectRPC client. Axum serves the RPC service under `/rpc`, the UI and a health route. Protobuf is the transport contract. The browser and agents use the same RPC policy; UI checks are convenience, not an authorization boundary.

The current demo stores users, workspace, teams, settings, customers, projects and social channel records in an in-memory event core using katha, with commands serialized through a kathputli actor mailbox. All data resets when the process restarts; this slice does not use katha-sqlx or a durable database. The first-admin bootstrap collects workspace name and admin name, email and password. Bootstrap is serialized so concurrent first-admin attempts have one winner. Passwords are Argon2 hashes. Login returns a JWT signed with a randomly generated runtime key; it expires after 15 minutes. Restarting loses the key and invalidates all sessions.

Roles are `admin`, `manager`, `member` and `viewer`. Module access is assigned for team, customers, projects, social and settings. Admins manage teams and settings; managers and members can write within modules they can access; viewers are read-only. The server rechecks role and module access on each request. Workspace settings include timezone and the full set of 35 daisyUI themes. Production provider settings are a later feature.

Sample customers, projects and social channels are seeded by backend RPC behavior. They are labeled as sample data and reset on restart. The current demo does not send posts, invitations, emails, or provider requests. No social OAuth, durable database, or backup implementation is present.

Projects own multiple named boards with ordered column names. Tasks belong to a project and board, reference one valid column and may carry an assignee, priority and due date. Board and task writes use the same serialized event path as other records.

## Persistence direction

The planned durable core is one SQLite database in WAL mode with a single writer. Katha will provide the event core, and kathputli will serialize commands. Projections are derived views and can be rebuilt from events. There is no Postgres persistence plan.

Litestream is planned for offsite backup and replication of the SQLite database. It does not provide active-active service or high availability. A recovery process must restore and validate a database before the application serves requests, and must never overwrite an existing database during bootstrap. Durable authentication, configuration, signing and encryption key material need a protected backup and recovery path as well. Provider encryption keys must have a separate recovery secret; storing the only decryption key alongside the encrypted database is not recovery.

Deployment identity or AWS environment configuration may provide deployment credentials for backup infrastructure. It is not a substitute for the application's durable signing/encryption recovery material. The current demo does not require passwords or tokens in environment variables.

## Access and integrations

Authentication and authorization apply at the RPC layer. JWTs are short-lived, and each request checks current role and module access so role changes take effect immediately. Demo setup is intended for loopback use, not public access.

Future social adapters will let users queue and publish posts through Office Office's own social channel workflow. Each provider operation needs an idempotency key, audit record, status, and retry handling so retries do not create duplicate posts. This is a scoped publishing exception; it does not make the service a general-purpose provider client. Demo sample channels never publish.

Business integrations such as Zoho remain read-only by default. Provider credentials stay server-side and are encrypted at rest in the durable implementation. A narrow action such as sending an invoice requires a separate permission, an operation identifier to prevent duplicate sends, provider receipts and an audit record. Never forward provider secrets to agents.

Hermes owns Telegram, Slack, WhatsApp/Evolution and other conversational channels and agent execution. The Streamable HTTP MCP adapter at `/mcp` calls the same actor commands and authorization policy as RPC; it never reads storage directly. Its initial tools read scoped workspace records and save boards or tasks. JWT-authenticated administrators issue named, expiring, revocable keys; only a hash is retained. Each key is bound to its creator and its scopes are intersected with the creator's current role and module access on every call. Keys cannot administer users or other keys. Key credentials remain outside domain events.

## Hosting and limits

The current server is a preview/demo, not a public authentication service. GHCR `edge` is a preview image. Do not deploy it for public users or real customer records. There is no production deployment or implemented durable backup path. See [hosting](hosting.md) for current image and workflow details.

The eventual hosted shape is one application instance with a persistent SQLite volume, HTTPS ingress and a separately configured Litestream backup path. Restore and validation happen before the service accepts requests. Offsite replication protects recovery; it does not make multiple writers safe.

## Product conventions

The UI uses React and Vite; the service uses Rust, Axum and ConnectRPC. The protobuf contract is in `proto/office/v1/office.proto`; `just generate` regenerates clients. Use pnpm for frontend work and follow the root `AGENTS.md` for focused checks. Never hand-edit generated clients.

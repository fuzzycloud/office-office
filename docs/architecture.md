# Architecture

Office Office is a shared business workspace for humans and AI. It provides office records and a social publishing queue; external clients and runtimes remain responsible for agent execution and runtime conversations. Hermes is one possible integration, alongside clients such as Claude Code and Codex. Targets, strategy, pricing history and progress remain part of the product direction.

## Service boundary

The React application uses TanStack Router for section URLs and the generated ConnectRPC client for data. Route entry revalidates the shared TanStack Query cache rather than retaining React-only page state indefinitely; browser history and direct section reloads are supported. See [navigation and refresh](navigation.md). Axum serves the RPC service under `/rpc`, the UI and a health route. Protobuf is the transport contract. The browser and agents use the same RPC policy; UI checks are convenience, not an authorization boundary. The Streamable HTTP MCP adapter at `/mcp` calls the same actor commands and authorization policy.

## Durable default

Unless `OFFICE_DEMO_MODE=true`, the server opens `data/office-office.sqlite3` (overridable with `OFFICE_DATABASE_PATH`) through the public async `OfficePreviewService::open(path)` API. The first durable workspace has no sample records. Bootstrap collects workspace name and admin name, email and password. Password hashes use Argon2; AI keys are returned once and stored as digests. The JWT signing key and setup state are kept in private SQLite tables, so authentication survives process restarts with the database.

Katha represents the event aggregate and event log. On startup, the server replays events to rebuild its in-memory read projection. Kathputli serializes commands through one actor, and an exclusive process lock prevents another server process from opening the same database. SQLite runs in WAL mode with `synchronous=FULL`. The durable rusqlite adapter deliberately does not use `katha-sqlx`: it writes domain events, activity records, password hashes, AI key digests and setup state in one SQLite transaction. The server returns success only after commit. If persistence fails, it restores the staged in-memory state and returns an error. Private credentials and the JWT signing key are outside the public domain event log. The internal `office-sqlite-journal` crate owns raw journal reads and inserts within the caller-owned transaction. Katha aggregates and replay do not require a Katha-supplied database driver. The extraction preserves the existing schema and requires no data migration. Member/profile and key metadata remain event sourced; moving accounts to ordinary SQL is a separate, unimplemented option.

This is durable local storage, not a production-ready service. Retention and export controls, request throttling, durable audit policy, a public authentication perimeter and verified backup restoration remain unfinished. No social provider credentials are stored.

Project records own multiple named boards with custom columns. Tasks reference a project, its board and a valid column, and may include an owner, priority and due date. These writes share the same transactional event path as other office records. Task discussions use dedicated read RPCs, with revision-checked comment create/edit and soft-delete commands. Server-owned authorship and timestamps accompany comments; task activity remains separate from the conversation. Discussions follow stable task IDs across board moves, and visible comment counts are derived from non-deleted records. Comment events and activity commit in the same transaction as the command. See [tasks and discussions](tasks.md).

Research reports use dedicated list/detail/save RPCs so opening the workspace does not load every full report body. Lists return paginated metadata with body omitted. Saves run through the same kathputli actor and transactional katha event path as other records. Each report records server-owned authorship, timestamps and a monotonically increasing revision. Updates require the current expected revision; a recurring edition is a new report sharing a topic and period label. Source URLs accept HTTP/HTTPS only and are stored without fetching external content. Report access follows the same live role checks as other modules. Draft/published statuses are editorial states, not separate ACLs or approvals. Analytics and campaign-data ingestion remain deferred. See [research reports](reports.md).

Member profiles include optional bio and avatar URL fields. Admins edit team profiles through `SaveMember`; authenticated users can update only their own bio/picture through `SaveProfile` (including Viewers). The self-profile command clones the current member, changes those fields only, and commits the ordinary member event, preserving role, status, kind and credentials. Images can be browser-loaded HTTPS URLs with no-referrer or private uploaded file references. Private images are downloaded with the current session and rendered from browser blob URLs; initials remain the fallback. There is no server-side fetch of external avatar URLs. Limits and compatibility are documented in [profiles](profiles.md).

## File storage

Optional S3-compatible object storage holds attachment bytes separately from SQLite. File metadata, uploader identity, checksums and revision-checked soft deletion use the ordinary actor/event transaction. Authenticated HTTP adapters upload and retrieve bounded bytes; RPC and MCP expose metadata and permitted operations under the same live member/role policy. The server chooses object keys and never forwards storage credentials. Profile pictures are decoded and normalized before storage. The Files gallery derives bounded raster previews through an authenticated, read-only endpoint; it stores no thumbnails or extra events and preserves source objects. Two processing slots bound preview decoding and object retrieval. Profile selection reuses only an existing own-profile file reference. Object upload and SQLite commit cannot form one distributed transaction: failed metadata writes attempt object cleanup, and orphan reconciliation remains future work. Soft deletion hides metadata and denies future downloads, while retaining bytes and event history. See [files](files.md).

Database backup and object retention are independent. A restore needs both the SQLite metadata and its corresponding retained objects. Use separate prefixes, keep a seven-day Litestream recovery window, and do not apply that expiry to attachments. File access inherits module roles; project-specific isolation remains unimplemented.

## Explicit demo mode

`OFFICE_DEMO_MODE=true` selects `OfficePreviewService::new()` and its temporary in-memory storage. Sample data is a separate first-admin registration option (`load_demo_data`). The environment flag preselects that option in the UI but does not insert records before registration. The same option works with SQLite and persists its sample records.

`EngineCommand` is the public typed command DTO and `EngineOutcome` its result. RPC record-write adapters and direct in-process callers use `OfficePreviewService::execute(token, command)`; it sends the command through the same kathputli mailbox, current authorization checks, validation, katha events, projection changes and storage commit. Direct callers do not receive a privileged fake principal. `bootstrap`, `authenticate` and `workspace` expose the corresponding transport-free setup/auth/read operations. Commands also support tagged JSON DTOs.

During an opted-in bootstrap, the actor executes each starter command through that same core dispatcher inside the bootstrap snapshot. This avoids a recursive mailbox request and places the administrator, sample marker, fixtures and activity in one SQL transaction. A failed scenario rolls the entire bootstrap back. A persisted scenario/version event records that starter data was loaded; repeating bootstrap is rejected. The projection starts empty and is never seeded directly.

Samples are ordinary records for testing and exploration. They use generated IDs, visibly sample labels, fictitious `example.test` contacts, pending teammates without passwords, and disconnected demo-only channels. Their creation never sends invitations or provider requests. Sample state (`demo_mode`) is separate from durability (`persistent_storage`) in setup/workspace responses. Event-based soft deletion is available for task comments and file metadata; deletion of other record types remains planned. No hard-reset or erase-history endpoint is introduced. See [starter data and engine testing](demo.md).

Roles are fixed presets: Admin reads/writes all modules; Manager reads all and writes customers, projects, reports and social; Member reads all and writes projects and reports; Viewer reads all only. Team/key/settings administration is Admin-only for both human and AI users. There are no per-user module overrides or per-key scopes. `ListRoles` exposes the canonical matrix; `GetWorkspace.permissions` exposes the caller's effective permissions for UI controls. See [roles](roles.md). Workspace settings include timezone and all 35 daisyUI themes.

## Network and storage operations

The binary binds to `127.0.0.1:8080` by default. A non-loopback `ADDR` requires `OFFICE_ALLOW_REMOTE=true`; this is an explicit remote-ingress acknowledgement and does not enable authentication hardening or public safety. Keep bootstrap behind a private ingress. The container sets `ADDR=0.0.0.0:8080` and `OFFICE_ALLOW_REMOTE=true`, runs as UID 10001, and uses `/data/office-office.sqlite3`. Mount a persistent volume at `/data`; its directory is mode `0700`. The database and lock files must remain private to the service account.

The image bundles pinned Litestream 0.5.17 as an optional same-container supervisor; it is disabled by default. With `OFFICE_LITESTREAM_ENABLED=true`, Litestream starts and supervises `office-server` against the same persistent volume. A missing database is restored to a temporary file and checked for SQLite integrity before promotion. Restore failures stop startup; a missing backup permits new database initialization only with the explicit `OFFICE_ALLOW_NEW_DATABASE=true` first-boot flag. Existing databases are used as-is. An isolated S3-compatible bucket upload and fresh-volume restore have passed integrity/content checks. Hosted migration and ongoing backup monitoring remain separate operator responsibilities. WAL mode still supports only one application process per database. Do not run active-active instances against a shared file. See [storage and recovery](storage.md) for configuration and migration guidance.

## Access and integrations

Authentication and authorization apply at the RPC layer. Human JWTs expire after seven days; AI JWTs expire after at most 15 minutes, bounded by key expiry. Every operation rechecks the member's current role and active state. AI keys bind to one AI member, expire within 90 days, and exchange for tokens bounded by credential expiry. Functional RPCs use tokens; MCP accepts tokens or internally exchanges raw AI keys. Revocation, rotation or deactivation denies existing sessions on subsequent calls. Human and AI Admins have the same administration permissions, while a password-backed human administrator must remain for recovery. New AI creation commits member events and key digest atomically and returns the secret once; rotation revokes all previous keys and creates the replacement in one transaction.

Legacy `Member.access`, `AgentKey.scopes` and request scope fields remain wire/event compatible but no longer constrain authorization. Role-only access intentionally replaces that older policy. Existing v0.3 member-bound keys use current roles; v0.2 creator-bound keys remain invalid. Review roles before upgrading, especially where older scoped keys restricted a broad role.

The social queue saves plans but has no posting adapter. Social OAuth, external posting and invitations are unavailable. Business integrations such as Zoho remain read-only by default. Any future narrow write action needs its own permission, idempotency key, provider receipt and audit record. Provider credentials are not currently stored. Never forward provider secrets to agents.

Runtime conversations, messaging-channel integrations and execution belong to external clients/runtimes; Hermes is used for those integrations in our own setup. The public application does not require Hermes. MCP initial tools read role-authorized workspace records, save boards/tasks/reports, and expose Admin-only AI provisioning/key rotation; agents never read storage directly.

### Shared user authentication and remaining policy work

v0.3.0 implements explicit human/AI members and key exchange. `kind` defaults to human for legacy members; new AI members need no password/email, and user type is immutable. Keys bind to an active AI member with a separate issuer. Stable member IDs identify comment/report authors and task activity. Project memberships, task/board revision checks, command idempotency and structured generic activity attribution remain planned. Existing project filters and reference validation are not project authorization.

Humans and AI are users in one member/role model. Humans authenticate with email/password; AI users exchange a member-bound key for a short-lived access token. Both flows resolve a common principal using the current fixed role across RPC and MCP. Project grants remain future work. Revoking a key or disabling a member invalidates its outstanding sessions on subsequent calls. Stable actor identity is separate from assignment and key issuance. See [agent team access](agent-team-access.md) for migration rules, token constraints and acceptance tests. The remaining project-isolation and reliability requirements are not current behavior.

### Optional external execution flow

Functional MCP/API access does not require Ready, a watcher, runtime-profile mapping or Office Office starting an agent. Any supported client can authenticate and perform permitted operations. Client configuration and OAuth interoperability must be documented and tested rather than inferred from a product name.

If an external dispatcher is installed later, Ready can explicitly request work after assignment and brief/acceptance/dependency checks. Such an integration needs atomic claims, attempt/revision tracking, heartbeats, safe retries, uncertain-start reconciliation, cancellation and authorized review. Runtime mappings and named-agent behavior belong in its configuration. Card moves never grant external-action approval. See [optional agent dispatch](agent-dispatch.md); this is separate from baseline team and MCP access.

## Hosting and product conventions

GHCR images are published only for version tags and remain previews; the public repository does not configure an operator-specific deployment. See [hosting](hosting.md) for the deployment boundary. The UI uses React and Vite; the service uses Rust, Axum and ConnectRPC. The protobuf contract is in `proto/office/v1/office.proto`; `just generate` regenerates clients. Use pnpm for frontend work and follow the root `AGENTS.md` for focused checks. Never hand-edit generated clients.


### Planned work conversations and personal attention

Task comments are the current work-conversation surface. A notification board now
provides personal recipient/sent lists, explicit task-linked response requests and
immutable cursor polling through RPC/MCP. Creation fanout, read markers, claims
and resolution commit through the same actor/event/SQLite path. Polling does not
mark read or acknowledge, and notification bodies do not leak into the workspace
activity feed. See [notifications and watchers](notifications.md). Stable-ID inline
mentions, revision-specific file/report links, one project discussion area and
richer review/decision inbox workflows remain planned. Read markers are separate from unresolved requests;
ordinary comments and mentions never launch execution. Our first optional adapter
uses office events, a local watcher and configured Hermes profiles, with replies
and visible status written back through authenticated APIs. No Hermes-specific
identity or persona is added to the app. See [work conversations and needs
attention](work-conversations.md) for delivery order, policy and acceptance cases;
the remaining additions are not shipped functionality.

## Human browser authentication

The `/auth` HTTP adapter calls the same bootstrap/login actor commands, sets a stateless seven-day HttpOnly cookie and returns user metadata without a bearer token. Session recovery validates the existing cookie; logout clears it. Cookie-to-bearer middleware covers RPC and file endpoints, with CSRF and Origin checks, while MCP remains an explicit-bearer interface. Hosted cookies require HTTPS; loopback development can use HTTP. Browser session changes clear cached records and invalidate results from the previous identity. No storage schema changes or refresh-session records are introduced. See [security boundaries](security.md) for stateless logout limitations.

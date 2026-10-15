# Office Office

A shared daily office workspace for humans and AI. Office Office is building toward a clear view of targets, strategy, projects, pricing history and progress. It is independent open-source software, inspired by the Hindi sitcom [Office Office](https://en.wikipedia.org/wiki/Office_Office), and is not affiliated with the show or its creators.

Hermes owns conversational channels and agent execution. Office Office owns office records and, as a separate product capability, its future social publishing queue. It does not provide another agent runtime.

## Current phase

The current phase is a UI-first demonstration. Authentication, users, teams, profiles, role assignments and workspace records live in an in-memory event core using katha, with commands serialized through a kathputli actor mailbox. Data resets whenever the server restarts; the demo does not use katha-sqlx or a durable database. The first screen bootstraps the workspace with its name and the first administrator's name, email and password. The server serializes competing bootstrap requests so only one can win. Subsequent users sign in with email and password. Passwords are stored as Argon2 hashes; signed JWTs use a random key created at runtime and expire after 15 minutes. This runtime key and all demo data disappear on restart.

The demo offers `admin`, `manager`, `member` and `viewer` roles. Admins manage teams and settings; managers and members can write in modules they can access; viewers can read only. Module access covers team, customers, projects, social and settings. The server checks the current role and module access on every request. Workspace settings include timezone and the full set of 35 daisyUI themes.

Sample customers, projects and social channels are seeded by the backend RPC demo path. They are visibly marked as sample data and reset on restart. Demo credentials and sample records are fictitious: the demo does not send posts, invitations, or contact any external service. Social provider connections, durable storage and backup are not implemented.

## Run locally

Prerequisites: Rust with edition 2024 support, Node 24, pnpm 12 (pinned in `package.json`), Buf CLI, and `protoc` if required by the Rust code generator.

```sh
pnpm install
just generate
just server
```

In another terminal, run `just web` and open the Vite URL. Choose the workspace and first admin credentials on the bootstrap screen. The local demo starts without passwords, access tokens or provider secrets in environment variables. Keep it on loopback; do not expose the in-memory demo as a public service.

For a production UI build, use `just build`, then run `target/release/office-server` from the repository root and open http://127.0.0.1:8080. The server currently has no durable database, so restarting it resets users and all records.

## Development

The protobuf service is the shared domain boundary for the browser and agents. Project workspaces support multiple boards with custom columns and tasks, owners, priorities and due dates. The MCP adapter uses the same actor commands and permission checks. Seed data is created through backend RPC behavior, not hardcoded in the frontend. Run `just check` for the repository's full check suite; `just generate` lints protobuf and regenerates the TypeScript client. Do not edit generated clients by hand. `just test-e2e` builds the UI and runs a browser smoke flow for setup, team onboarding, customers, projects, the queue and themes. CI runs this flow and uploads desktop/mobile screenshots.

## AI access

Administrators can create named, scoped AI keys in Settings. Copy the secret when it is created; it is shown once, stored only as a hash on the server, and cannot be recovered. Keys expire within 90 days and can be revoked immediately. A key is tied to its creator and cannot exceed that account's current permissions. Keys and all other preview data disappear on restart.

Connect an MCP client such as Hermes to `http://127.0.0.1:8080/mcp` using Streamable HTTP and `Authorization: Bearer <your-key>`. See [MCP setup and tools](docs/mcp.md). The initial tools read scoped workspace records and create or update boards and tasks. They do not manage accounts, issue keys, contact providers or publish posts.

## Roadmap

The next persistence design is one SQLite database with WAL and one writer. Katha will hold the event core, kathputli will serialize commands, and rebuildable projections will serve reads. Litestream is planned for offsite backups; it is not high availability and is not implemented yet. Recovery must restore and validate the database before the service accepts traffic. Durable auth/config signing and encryption key material must also have a protected recovery path.

Later work includes durable user and team management, audit history, social provider connections and an idempotent, auditable posting queue. Provider settings will be encrypted server-side. External business connectors such as Zoho remain read-only by default; any narrow write action requires its own permission and audit record. Goals, strategy, pricing history and progress remain part of the product direction.

## Hosting and releases

The GHCR `edge` image is a preview of the current demo and is not ready for public authentication or durable customer data. There is no deployed service. See [hosting notes](docs/hosting.md) and [release management](docs/releases.md).

## Decisions and security

See [architecture](docs/architecture.md), [ADR 0002: UI-first demo and SQLite direction](docs/adr/0002-ui-first-sqlite.md), and [security boundaries](docs/security.md).

## License

MIT OR Apache-2.0. See LICENSE-MIT and LICENSE-APACHE.

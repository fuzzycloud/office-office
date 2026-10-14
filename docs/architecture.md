# Architecture

Office Office is a hosted daily business workspace shared by humans and AI. It is not a CRM replacement or agent runtime.

## First working slice

React calls a generated ConnectRPC client. Axum hosts the OfficeService under `/rpc`, a health route and the built UI. Protobuf is the transport contract; the starter board payload is a versionable JSON document inside that contract. This is deliberately a bootstrap, not a claim that all domain fields already have generated protobuf types.

The board records measurable targets, strategy notes, project lifecycle (active, on_hold, archived), dated pricing entries in integer minor units, and progress updates. It starts empty. A person creates the first records. Archived projects keep their context and pricing history.

The Rust service persists the board to a JSON file with serialized writes and atomic replacement. This supports one server instance with a persistent volume. Whole-board saves do not yet provide concurrent-user merge semantics. Use one editor at a time during this bootstrap. PostgreSQL, typed domain RPCs, per-record revision checks and an audit log are the next foundation work before a shared production rollout.

## Access boundary

Two distinct server-side bearer credentials: human and agent, both read/write. Missing or invalid credentials are denied. Both credentials may query and save the board. Agent access to Office Office itself is writable. Browser users enter their token at runtime; no token is compiled into the frontend. Session storage keeps the token for the tab; clear it by signing out. Deploy behind HTTPS; a human token is a bootstrap credential, not a substitute for individual accounts and roles.

Future external connectors (Zoho and others) are imported read models. Provider credentials belong only to the server or integration operator. Agents receive allowlisted context with read-only external access by default. A connector may later expose explicitly enabled, narrow actions such as creating or sending a Zoho invoice. Such actions need separate permissions, operation IDs to prevent duplicate sends, provider receipts and audit events. They must not grant general provider write access. No live provider connector is implemented in this initial scaffold. Keep imported records separate from human-editable office records when introducing them.

Hermes owns Telegram, Slack, WhatsApp/Evolution and other channel operations. Office Office holds goals, planning and business context. A future MCP server and CLI will expose read and write board tools and must wrap the existing RPC policy rather than bypass it or access the data file directly.

## Hosted path

Start with one container, one persistent volume and HTTPS ingress. The Dockerfile builds React and Rust using a pinned cargo-chef planner/cook/build pipeline; the server serves both from the same origin. GitHub Actions builds and publishes to GHCR on main and version tags after checks pass. Servers pull the image; Kamal is explicitly deferred. No deployment has been performed. Individual identity, workspace isolation, backup/restore verification and multi-user conflict control remain prerequisites for a public multi-user service.

## Sources of conventions

User-selected Rust + React + ConnectRPC. Dependency reference: pi_dx workspace, not its stale demo crate. TanStack Query for server state, pnpm package management, one Rust build at a time, and tiered delegation follow secondbrain and sibling AGENTS.md guidance. Do not copy healthcare or legal-domain logic from those projects.

## Validation limits of this initialisation

During initial validation, the sandbox could not bind a local TCP listener or use the host Docker socket. Git access was restored after scaffolding. Rust unit tests and an in-process HTTP route integration test verify persistence, validation and human/agent access. TypeScript checking, Buf lint/code generation and Vite production build run locally using matching installed sibling dependencies. A clean network install and full container build must run in GitHub Actions; an interactive browser smoke test remains outstanding. No image publication or deployment has occurred.

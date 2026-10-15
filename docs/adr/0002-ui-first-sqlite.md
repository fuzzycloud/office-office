# ADR 0002: UI-first demo and SQLite event core

- Status: Accepted
- Date: 2026-10-15

## Context

Office Office needs a usable workspace and account-management flow before durable multi-user hosting is ready. The initial demo should exercise the same RPC boundary as future clients without pretending that in-memory data is durable or that provider connections work.

The product needs an event-oriented persistence core that remains simple to back up and recover. The prior proposal for PostgreSQL is superseded: the planned durable store is SQLite with one writer.

## Decision

Build the current phase UI-first. Workspace setup creates the first administrator from workspace name, admin name, email and password. The server serializes bootstrap so only one initial account is created. Store password hashes with Argon2 and issue 15-minute JWTs with a random runtime signing key. Users, teams, roles, settings and records remain in an in-memory katha event core, with commands serialized by a kathputli actor mailbox, and reset at restart. This slice does not use katha-sqlx or a durable database. Workspace settings include timezone and all 35 daisyUI themes; these are demo defaults, distinct from future provider settings.

Use four roles: admin, manager, member and viewer. Admins manage teams and settings. Managers and members may write in modules available to their team. Viewers are read-only. Check current role and module access on every RPC request. Seed clearly labeled sample data through backend RPC behavior. Demo sample channels do not send posts or invitations and do not contact providers.

The future durable core is a single SQLite database in WAL mode with a single writer. Katha owns the event core, kathputli serializes commands, and projections remain rebuildable. Litestream provides planned offsite backup, not active-active high availability. Restores occur and are validated before serving; bootstrap must never overwrite an existing database. Durable auth and configuration keys need protected recovery. Provider encryption keys require a recovery secret separate from the encrypted database.

Social publishing will be an Office Office workflow with scoped provider adapters, idempotent operations, audit history and retries. Hermes remains the agent runtime and owner of conversational channels. Business integrations remain read-only by default, with narrow separately permitted and audited actions.

## Consequences

The demo is intentionally ephemeral and suitable only for local/preview use. It has no real backup, durable login or provider publishing. GHCR preview images must not be presented as a public production service. Future persistence work must preserve the single-writer recovery model and ensure that database restore and key recovery are tested before serving users.

The board direction—targets, strategy, projects, pricing history and progress—remains on the roadmap while account, team, customer and social workflows are developed.

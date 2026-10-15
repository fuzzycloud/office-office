# Security boundaries

## Current demo

The demo uses the server RPC layer for authentication and authorization. The browser does not grant itself permissions. Passwords are stored as Argon2 hashes, and login issues a 15-minute JWT signed with a random key held in process memory. The server checks current role and module access on each request. Roles are admin, manager, member and viewer; module access covers team, customers, projects, social and settings.

The first-admin bootstrap is intentionally available only while no workspace exists. The server serializes bootstrap attempts so concurrent requests cannot create competing initial admins. This prevents a race, but anyone who can reach an uninitialized public server could claim it. Keep the current demo bound to loopback and do not expose it to the internet. The demo has no durable account store or durable signing key: a restart resets accounts, records and sessions.

Sample customers, projects and social channels are fictitious backend-seeded records, marked as samples and reset on restart. They do not send posts, invitations or provider requests. This prevents demo data from causing external side effects. Never represent sample activity as a successful customer interaction or provider connection.

## Agent credentials

AI access uses named opaque bearer keys with explicit module read/write scopes, expiry and immediate revocation. Administrators create and revoke keys using JWT sessions. The raw key is returned once and is never included in domain events or key listings; only its SHA-256 digest is retained in memory. Every MCP request rechecks validity and every operation intersects key scope with the creator's current account permissions. Disabling the creator disables access. Keys grant no account or key administration capability.

MCP rejects browser Origin headers to reduce cross-origin and DNS-rebinding exposure; native MCP clients should omit Origin. Treat bearer keys as passwords and use HTTPS for any future hosted deployment. The preview has no durable key storage or production perimeter.

## Deferred production controls

The demo does not provide durable storage, encrypted provider settings, audit history, backup or restore. Production use requires a single SQLite writer, durable protected signing and encryption key recovery, verified restoration before serving traffic, and audited authorization decisions. Litestream is planned for offsite backup only; it does not provide active-active availability. Never overwrite an existing database during bootstrap.

Provider settings must be encrypted server-side, with a separate recovery secret. A key stored only alongside the encrypted database cannot recover it after loss. Deployment identity and AWS credentials may authorize infrastructure access but do not replace application signing/encryption recovery material. Do not pass provider secrets to agents.

Future social publishing must use explicit provider scopes, server-side credentials, an idempotency key per operation, audit records, provider receipts and safe retry behavior. A retry must not silently publish a duplicate post. Business connector access remains read-only by default; narrow actions such as sending an invoice require separate permission and audit records.

## Trust boundary

Humans and agents use the same RPC authorization path. UI visibility and client-side validation are not security controls. Hermes remains responsible for agent execution and messaging channels. Office Office owns the records and any future, separately scoped social publishing workflow.

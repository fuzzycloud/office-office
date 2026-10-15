# Security boundaries

## Identity and authorization

Authentication and authorization are enforced by the server, with the same actor commands for UI RPC and MCP. Roles are admin, manager, member and viewer; module access covers team, customers, projects, reports, social and settings. Every operation checks the current account state, so changing access or disabling an account takes effect on subsequent requests. UI visibility is not a security boundary.

First-admin setup is available only while a new office is uninitialized. Bootstrap is serialized and committed atomically with the administrator's password hash and workspace events. Anyone who can reach a fresh office first could claim it: keep setup behind a private ingress. Startup fails on a damaged or unsupported database instead of falling back to setup.

Passwords are stored as Argon2 hashes in private SQLite tables. JWTs last 15 minutes and use a signing key retained in the same protected database, so restart does not invalidate an unexpired session. The raw signing key is never returned to clients or included in domain events. Backups of the database therefore include sensitive authentication material; restrict and encrypt both the volume and backups. SQLite is not encrypted by the application.

## Agent credentials

AI access uses named opaque bearer keys with module scopes, expiry and immediate revocation. JWT-authenticated administrators create and revoke keys for active AI team members. The raw secret is returned once; only its SHA-256 digest and member binding are retained privately. Issuer metadata is separate from the member identity. Credentials are committed atomically with public key metadata events. A module write scope also permits reads in that module. `ExchangeAgentKey` validates the key and active AI member, then issues a JWT for at most 15 minutes, bounded by key expiry. MCP and functional RPCs accept the access token, not the raw login key. The issued scope ceiling, current key scopes, member role and module access are intersected on each operation. Current key scopes cannot grant team/key/settings administration, even to an AI member with an admin role.

AI writes use the authenticated member name; comments, reports and task activity use stable member IDs. Rotation does not create a new author. Generic workspace activity still has a display-name-only schema; structured audit enrichment remains planned. MCP rejects supplied Origin headers; native clients should omit Origin. Use HTTPS for any future hosted deployment. Neither database persistence nor `OFFICE_ALLOW_REMOTE=true` supplies a production perimeter.

AI members now have their own identities and credentials. Legacy creator-bound keys are rejected by the new exchange and require explicit replacement. There is still no project-membership authorization; filtering a response by project is not an isolation boundary. The [accepted agent team access contract](agent-team-access.md) requires independent active members, project grants, stable provenance and credential migration before these guarantees can be claimed.

The common session model issues tokens after human password login or AI key exchange. AI tokens must retain their credential scope ceiling across both RPC and MCP. Current member/project/key state is rechecked after issuance; revoking a key or disabling its member must deny an otherwise unexpired token. Runtime choice does not affect authorization, and generic MCP access requires no watcher or execution-profile mapping.

## Event and storage boundary

Katha domain events contain records and activity. Password hashes, key digests and signing material live outside those events. A kathputli actor stages changes and commits each command's events and private authentication changes in one SQLite transaction before success. A failed commit restores the prior projection and credentials. Startup rebuilds projections from the journal before accepting HTTP requests. A process lock excludes another application writer.

Normal startup uses empty durable records. `OFFICE_DEMO_MODE=true` selects in-memory storage that resets on restart. First-admin registration separately offers sample starter data, created through normal authenticated engine commands. SQLite can retain the same samples across restarts. Pending sample teammates receive no shared password. No mode sends invitations, messages, invoices, provider requests or social posts. Demo records never represent successful external interactions.

Append-only history retains previous personal data values. Event/backup retention, export and erasure workflows remain deferred and must be designed before production use. Storage access is trusted: this is not a cryptographically tamper-evident journal.

## Recovery and deferred controls

[Storage and recovery](storage.md) describes the optional Litestream template and manual restore drill. Replication is not started by the image or application and has not been verified against AWS. Never overwrite an existing database during restore or treat a failed restore as a new office. Restoring an older backup can resurrect revoked keys or old passwords; review credentials after recovery.

This development build still needs a production review of TLS/ingress, request throttling, password recovery, retention/erasure and verified backup monitoring. Future provider settings require encryption server-side and a separate protected decryption recovery secret; no such credentials are stored today. Future publishing or invoice actions need explicit narrow permissions, operation IDs, receipts and retry handling. Never pass provider secrets to agents.

External clients and runtimes own agent execution and conversational channels. Office Office owns records and the separately scoped future social publishing queue.

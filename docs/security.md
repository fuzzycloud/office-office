# Security boundaries

## Identity and authorization

Authentication and authorization are enforced by the server, with the same actor commands for UI RPC and MCP. Roles are admin, manager, member and viewer; module access covers team, customers, projects, reports, social and settings. Every operation checks the current account state, so changing access or disabling an account takes effect on subsequent requests. UI visibility is not a security boundary.

First-admin setup is available only while a new office is uninitialized. Bootstrap is serialized and committed atomically with the administrator's password hash and workspace events. Anyone who can reach a fresh office first could claim it: keep setup behind a private ingress. Startup fails on a damaged or unsupported database instead of falling back to setup.

Passwords are stored as Argon2 hashes in private SQLite tables. JWTs last 15 minutes and use a signing key retained in the same protected database, so restart does not invalidate an unexpired session. The raw signing key is never returned to clients or included in domain events. Backups of the database therefore include sensitive authentication material; restrict and encrypt both the volume and backups. SQLite is not encrypted by the application.

## Agent credentials

AI access uses named opaque bearer keys with module scopes, expiry and immediate revocation. JWT-authenticated administrators create and revoke them. The raw secret is returned once; only its SHA-256 digest and owner binding are retained privately. Credentials are committed atomically with public key metadata events. A module write scope also permits reads in that module. Key scopes are intersected with the owner's current role and module access on each operation; keys cannot administer accounts or other keys.

AI writes identify the key name in activity. MCP rejects supplied Origin headers; native clients should omit Origin. Use HTTPS for any future hosted deployment. Neither database persistence nor `OFFICE_ALLOW_REMOTE=true` supplies a production perimeter.

## Event and storage boundary

Katha domain events contain records and activity. Password hashes, key digests and signing material live outside those events. A kathputli actor stages changes and commits each command's events and private authentication changes in one SQLite transaction before success. A failed commit restores the prior projection and credentials. Startup rebuilds projections from the journal before accepting HTTP requests. A process lock excludes another application writer.

Normal startup uses empty durable records. `OFFICE_DEMO_MODE=true` selects in-memory storage that resets on restart. First-admin registration separately offers sample starter data, created through normal authenticated engine commands. SQLite can retain the same samples across restarts. Pending sample teammates receive no shared password. No mode sends invitations, messages, invoices, provider requests or social posts. Demo records never represent successful external interactions.

Append-only history retains previous personal data values. Event/backup retention, export and erasure workflows remain deferred and must be designed before production use. Storage access is trusted: this is not a cryptographically tamper-evident journal.

## Recovery and deferred controls

[Storage and recovery](storage.md) describes the optional Litestream template and manual restore drill. Replication is not started by the image or application and has not been verified against AWS. Never overwrite an existing database during restore or treat a failed restore as a new office. Restoring an older backup can resurrect revoked keys or old passwords; review credentials after recovery.

This development build still needs a production review of TLS/ingress, request throttling, password recovery, retention/erasure and verified backup monitoring. Future provider settings require encryption server-side and a separate protected decryption recovery secret; no such credentials are stored today. Future publishing or invoice actions need explicit narrow permissions, operation IDs, receipts and retry handling. Never pass provider secrets to agents.

Hermes owns agent execution and conversational channels. Office Office owns records and the separately scoped future social publishing queue.

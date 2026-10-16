# Security boundaries

## Identity and authorization

Authentication and authorization are enforced by the server, with the same actor commands for UI RPC and MCP. Roles are fixed presets: admin, manager, member and viewer. [Role permissions](roles.md) cover team, customers, projects, reports, social and settings, with no per-user or per-key overrides. Every operation checks the current account state, so changing access or disabling an account takes effect on subsequent requests. UI visibility is not a security boundary.

First-admin setup is available only while a new office is uninitialized. Bootstrap is serialized and committed atomically with the administrator's password hash and workspace events. Anyone who can reach a fresh office first could claim it: keep setup behind a private ingress. Startup fails on a damaged or unsupported database instead of falling back to setup.

Passwords are stored as Argon2 hashes in private SQLite tables. Human JWTs last seven days; AI access JWTs last at most 15 minutes, bounded by key expiry. Both use a signing key retained in the same protected database, so restart does not invalidate an unexpired session. The raw signing key is never returned to clients or included in domain events. Backups of the database therefore include sensitive authentication material; restrict and encrypt both the volume and backups. SQLite is not encrypted by the application.

The browser binds RPC and file-transfer results to the session that initiated the request. Signing out clears cached workspace data and secret dialogs; delayed results are discarded after a session change. An unauthorized response from an older session cannot clear the newer login. One-time AI-key reveals also check the initiating session before rendering.

## Agent credentials

AI users receive their own opaque login key automatically at creation. Keys expire after 90 days and can be revoked immediately. Admins, human or AI, manage users and credentials under the same policy. The raw secret is returned once; only its SHA-256 digest and member binding are retained privately. Issuer metadata is separate from authenticated identity. Member events and credentials commit atomically. Rotation revokes all previous keys for the member and creates a replacement in the same transaction.

`ExchangeAgentKey` validates the credential and active AI member, then issues a JWT for at most 15 minutes, bounded by key expiry. Functional RPCs require that token. MCP accepts a token or internally exchanges a raw AI key. Each operation rechecks current role, active status and credential validity. Revocation, rotation and deactivation deny existing sessions on subsequent operations. Fixed roles replace legacy member access/key scopes, which are retained only for wire/event compatibility and ignored for authorization. Review assigned roles before upgrading: the new policy can broaden older restricted access.

AI Admins can provision AI users and rotate keys through MCP. User kind cannot change. A caller cannot disable/demote itself, and the last active password-backed human Admin must remain for recovery. Admin authority includes user/key administration; do not grant it for ordinary research work.

AI writes use the authenticated member name; comments, reports and task activity use stable member IDs. Rotation does not create a new author. Generic workspace activity still has a display-name-only schema; structured audit enrichment remains planned. MCP rejects supplied Origin headers; native clients should omit Origin. Use HTTPS for any future hosted deployment. Neither database persistence nor `OFFICE_ALLOW_REMOTE=true` supplies a production perimeter.

AI members now have their own identities and credentials. Legacy creator-bound keys are rejected by the new exchange and require explicit replacement. There is still no project-membership authorization; filtering a response by project is not an isolation boundary. The [accepted agent team access contract](agent-team-access.md) requires independent active members, project grants, stable provenance and credential migration before these guarantees can be claimed.

The common session model identifies the member and, for AI sessions, its credential. Runtime choice does not affect authorization. Generic MCP access requires no watcher or execution-profile mapping. Project-level permissions remain unimplemented; existing project filters are not isolation boundaries.

## Event and storage boundary

Katha domain events contain records and activity. Password hashes, key digests and signing material live outside those events. A kathputli actor stages changes and commits each command's events and private authentication changes in one SQLite transaction before success. A failed commit restores the prior projection and credentials. Startup rebuilds projections from the journal before accepting HTTP requests. A process lock excludes another application writer.

Normal startup uses empty durable records. `OFFICE_DEMO_MODE=true` selects in-memory storage that resets on restart. First-admin registration separately offers sample starter data, created through normal authenticated engine commands. SQLite can retain the same samples across restarts. Pending sample teammates receive no shared password. No mode sends invitations, messages, invoices, provider requests or social posts. Demo records never represent successful external interactions.

Append-only history retains previous personal data values. Event/backup retention, export and erasure workflows remain deferred and must be designed before production use. Storage access is trusted: this is not a cryptographically tamper-evident journal.

## Recovery and deferred controls

[Storage and recovery](storage.md) describes the bundled, opt-in Litestream configuration and manual restore drill. Replication is disabled by default. An isolated S3-compatible replica upload and fresh-volume restore have passed integrity/content checks; hosted activation and monitoring remain operator responsibilities. Startup never overwrites an existing database during restore and does not treat a failed restore as a new office. A missing backup allows an empty first boot only with the explicit `OFFICE_ALLOW_NEW_DATABASE=true` flag. Restoring an older backup can resurrect revoked keys or old passwords; review credentials after recovery.

This development build still needs a production review of TLS/ingress, request throttling, password recovery, retention/erasure and verified backup monitoring. Future provider settings require encryption server-side and a separate protected decryption recovery secret; no such credentials are stored today. Future publishing or invoice actions need explicit narrow permissions, operation IDs, receipts and retry handling. Never pass provider secrets to agents.

External clients and runtimes own agent execution and conversational channels. Office Office owns records and the separately scoped future social publishing queue.

## Dependency review

The 2026-10-16 review updated rust-s3 to 0.38 with quick-xml 0.41 and selected jsonwebtoken's AWS-LC provider, removing its unused RustCrypto RSA dependency. Office Office still signs and validates HS256 tokens with the existing database signing key. Compatible nanoid and source-map-js patches clear development-tool advisories. RustSec and the complete pnpm audit reported no known vulnerabilities at review time; this is a dated check, not a future guarantee.

Run `cargo audit` and `pnpm audit` when changing dependencies, alongside the normal tests. Keep runtime credentials out of Git, logs, and Docker build contexts. The Docker ignore rules explicitly exclude the private operator helper and configuration directories.

## Stateless browser-cookie boundary

Browser login/bootstrap set `office_session` with `HttpOnly`, `SameSite=Lax`, `Path=/` and a seven-day `Max-Age`. Public hostnames always add `Secure`, including when the server binds to loopback behind an HTTPS proxy. Non-loopback server bindings also force `Secure`. Only a loopback binding together with a localhost/loopback Host permits the local HTTP development exception. The JWT is not returned in browser authentication response bodies. A non-secret browser session marker guards pending results and cross-tab account changes; it is not a credential.

`/auth/session` validates the cookie against the current member. Cookie authentication is bridged only into RPC and file requests; MCP continues to require explicit bearer authentication. Explicit Authorization headers take precedence over cookies, including invalid credentials. Authentication POSTs and unsafe cookie-authenticated requests require `X-Office-CSRF: 1`; cross-origin Origin and cross-site Fetch Metadata are rejected. No permissive CORS policy enables another origin to supply that header with credentials.

The seven-day expiry is absolute, not sliding. There is no server session/refresh-token table. Logout clears the browser cookie but cannot revoke a copied JWT. Account deactivation still denies every protected operation; role changes take effect without waiting for expiry. Re-enabling an account can make an otherwise unexpired JWT usable again. Per-session revocation and password-change invalidation would need an additional mechanism and are not claimed here.

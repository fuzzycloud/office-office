# Agent team membership and project access

Status: shared human/AI users, fixed roles, automatic AI keys and key rotation are implemented. Project isolation, assignment guards, task/board revisions, idempotency and optional dispatch remain requirements. The fixed-role policy supersedes v0.3.0's member access/key scopes.

## Current identity and permission contract

Humans and AI are users with stable member IDs, names, roles and active/disabled state. Humans authenticate with email/password; AI users authenticate with a key bound to exactly one AI member. Human sessions use seven-day JWTs (HttpOnly cookies in the browser); AI key exchanges issue short-lived JWTs. Both use the same server authorization through UI, RPC, MCP and engine commands. Authenticated identity determines authorship; the caller cannot supply another author's name or ID. Key issuance and assignment are separate from authorship.

[Roles and permissions](roles.md) defines the fixed Admin, Manager, Member and Viewer matrix. There are no editable member permission lists or key scopes. `ListRoles` exposes the policy and `GetWorkspace.permissions` exposes the caller's effective permissions. Role changes and deactivation take effect on subsequent operations. Project-level authorization is not implemented; every role can read workspace records. Project filters and consistency checks are not client isolation.

Admins can manage human and AI users regardless of their own kind. In particular, **an AI Admin can create AI users**, through the shared RPC or `office_create_ai_user` MCP tool. Creating an AI user automatically creates a 90-day key and returns its secret once. User kind is immutable. A caller cannot disable/demote itself, and the last active password-backed human Admin must remain for recovery. Use lower roles for normal research and customer work.

A credential binds to the AI member, with issuing administrator recorded separately. Separate agents should have separate members/keys. Rotation atomically revokes every previous key for the member and returns a replacement secret once. Missing/disabled members and expired/revoked keys deny access; an otherwise-valid JWT cannot bypass those live checks. A rotated credential does not create a new author. Historical attribution is retained when a member is disabled.

The exchange returns a token lasting at most 15 minutes, bounded by credential expiry, with member subject, credential ID, issuer/audience and timestamps. Functional RPCs require tokens. MCP accepts a token or an AI key and internally performs the same exchange. This supports static bearer clients; it does not implement OAuth discovery or prove native interoperability with every client. No watcher, runtime-profile mapping or Hermes dependency is required for functional access.

## Compatibility

Legacy `Member.access` and key scope fields remain wire/event compatible but are ignored for authorization. Existing v0.3 member-bound keys use the member's current role. This can broaden access compared with an older narrowly scoped key: review roles before upgrading. v0.2 creator-bound keys remain rejected; provision explicit AI users and replacement keys. No database reset is required and history is not reassigned.

## Current implementation versus requirements

| Area | Implemented | Remaining work |
| --- | --- | --- |
| Identity | Human/AI members, member-bound keys, independent issuer, active-state checks | Project memberships and broader structured audit |
| Authentication | Password/key login, JWT checks, raw-key MCP adapter, immediate revocation/rotation | OAuth discovery and live client compatibility |
| Permissions | Fixed roles shared across transports; AI Admin can provision users | Project authorization on all reads/writes and secondary references |
| Attribution | Stable member attribution on comments, reports and task activity | Generic workspace activity still stores actor names; full structured change audit |
| Assignment | Optional member ID, existing-member validation, explicit Unassigned display | Active project eligibility and active-work assignment guard |
| Reliable writes | Atomic event/credential transactions, replay and rollback, report/comment revisions | Task/board compare-and-set, durable idempotency |
| Execution | External clients execute work; app stores assignments, status and discussions | Optional generic dispatch integration |
| Operations | File-backed SQLite, process lock, optional Litestream template, Chromium/mobile-width checks | Retained business storage, tested isolated restore, broader device/distribution review |

## Project authorization requirements

Future project memberships must apply uniformly to lists, details, comments, reports, search, counts, feeds and polling. Apply authorization before pagination and aggregates. Validate source/destination moves and linked records, including customers and unlinked research reports, without leaking unauthorized record existence. A project request filter must never widen access. Define workspace-scoped visibility and any explicit admin exception before claiming client isolation.

Assignment must validate active project eligibility for humans and AI. Backlog can be unassigned; entering an active-work category should require an eligible owner. Custom columns need semantic categories rather than policy based on their display labels. Assignment alone does not demonstrate execution.

## Writes, history and execution

Task/board updates must supply the expected revision. A stale write returns a conflict without committing events or partial changes. Create commands accept a principal-bound idempotency key: the same key and payload return the original result; the same key with a different payload is rejected. Persist the deduplication result atomically with domain events so retries after a response is lost or the process restarts do not duplicate records. Define retention and the supported retry window.

Record stable actor member ID/kind, credential ID where applicable, target IDs, action, server timestamp, relevant changes, revision and command/correlation ID. Preserve attribution after renaming, disabling or rotating credentials. Historical key references remain metadata, never a secret. Never place bearer tokens, password hashes or provider credentials in activity/events/logs. Keep security rejection logging separate from successful business events, and redact it too.

Generic MCP/API access does not require a watcher, Ready category, runtime profile mapping or Office Office starting a process. A client authenticates as its own AI user and performs permitted functions directly. External dispatchers may optionally add Ready-triggered handoffs, claims, attempt/run references and reconciliation; see [optional agent dispatch](agent-dispatch.md). Runtime mappings are integration configuration, never a prerequisite for team membership or a Hermes-only dependency.

An assignment is planned work. Only observed execution or a deliberate authorized update advances status. External clients should update Office Office rather than maintain a competing authoritative board. Provider publishing, invoices and other external effects retain separate narrow permissions, audit and approval policies.

## Next-deployment acceptance matrix

Set up disposable offices through supported UI/RPC/engine commands. The implemented identity/roles/key lifecycle cases are covered locally; project grants, assignment guards, task/board revisions, idempotency and dispatch remain test requirements. HTTPS/client-specific verification remains separate from local coverage.

| Scenario | Expected result |
| --- | --- |
| Human and AI users have the same role | Same module permissions across RPC and MCP |
| New AI member | Own member ID, one-time key, role-based access |
| AI Admin creates another AI user | Allowed; new user has independent identity/key |
| Member or Viewer creates users/rotates keys | Denied |
| Raw AI key used at MCP | Internal exchange and the same authenticated member |
| Missing, invalid, expired or revoked key/token | Denied without mutation |
| Key rotated after token issuance | Every old key and its existing tokens denied |
| Member disabled after token issuance | Key exchange and existing token denied |
| Role changed after token issuance | Subsequent operations use the new role |
| Viewer attempts writes | Denied across UI/RPC/MCP |
| Two AI users comment/report | Distinct stable authors, retained across credential rotation |
| Forged author metadata | Ignored/rejected; server principal determines provenance |
| Last human Admin disabled/demoted | Rejected, even when an AI Admin remains |
| Agent addresses a project outside future grants | Must be denied across all reads/writes; not yet implemented |
| Disabled/unassigned owner enters active work | Future guard required |
| Concurrent task/board writes or retried creates | Future revision/idempotency guarantees required |
| Assignment without confirmed execution | Does not fabricate a running runtime |

Before real business data, retain storage across container upgrades and test restoring a backup to an isolated instance. A file-backed SQLite database inside a container survives same-container restarts but is lost on replacement without retained storage. Litestream replicates a local working file and is not bundled yet. Postgres is not required. Verify mobile clients and repository/dependency/asset licensing before distribution. External publishing/sending remains separately permissioned and approval-gated.

## Implementation evidence

- [Protobuf contract](../proto/office/v1/office.proto): members, roles, keys, credential lifecycle and record commands.
- [Engine and authorization](../apps/server/src/lib.rs): shared principal, fixed-role checks, atomic member/key commands.
- [MCP adapter](../apps/server/src/mcp.rs): raw-key exchange, host checks and role-authorized tools.
- [Automated testing](testing.md): engine, RPC/MCP and browser checks; remaining acceptance requirements are not passing coverage.

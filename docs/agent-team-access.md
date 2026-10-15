# Agent team membership and project access

Status: shared AI-user/key-exchange authentication is implemented in v0.3.0. Project isolation, assignment guards, task/board revisions, idempotency and optional dispatch remain requirements. v0.2.2 used direct creator-bound keys.

## Validation of the proposed checklist

Humans and AI are users in the same team model, with the same role vocabulary and project policy. They differ in how they authenticate: humans use email/password to obtain an access token; AI users exchange their own agent key for an access token. Assignment, authorization and attribution use the same stable member ID across UI, RPC, MCP and events. Office Office is runtime-neutral: Hermes, Claude Code, Codex and other clients can use its supported MCP/API authentication. External clients execute work; Office Office remains authoritative for its records.

The proposed checklist is accepted with these clarifications:

- An agent member can be active without an email login or password. Human login eligibility and agent membership are separate checks. Requiring a human password for an agent would repeat the current owner-binding limitation.
- A task's assignee is distinct from its creator and last editor. Backlog may be unassigned. Entering an active-work state requires an eligible assignee; assigning an agent does not prove a run has started.
- Custom columns need a semantic workflow category, including an active-work category. Do not implement policy by comparing a display label to the literal text `In progress`.
- Project filters are a convenience, never authorization. Workspace-wide records and customers also need a defined visibility rule so unlinked reports, customer references, search and activity cannot bypass project policy.
- Team and key administration require explicit administrative permission. Normal agent credentials do not include those capabilities. Business-record tools for projects/customers need their own permissions; neither a role name nor the human issuing a key may silently grant extra authority.
- File-backed SQLite inside a container is distinct from SQLite `:memory:`. A file without a retained volume survives a same-container restart but not replacement. Business use requires storage retained across upgrades and a tested recovery path. Litestream replicates a local working SQLite file; a sidecar needs access to that file. Postgres is not required for this design.

## Current implementation versus requirements

| Area | v0.3.0 | Remaining work |
| --- | --- | --- |
| Identity | Explicit human/agent members; keys bound to an active AI member with a separate issuer | Project memberships and broader structured audit |
| Authentication | Password login and AI key exchange issue JWTs; shared principal checks current member/key state and scope ceiling | Broader OAuth/client interoperability |
| Attribution | Server-derived member attribution on comments/reports/task activity | Stable actor/key IDs on generic workspace activity and full change audit |
| Assignment | Task assignee ID is optional and must refer to an existing member; UI displays Unassigned | Eligible active project member, including agent; active-work assignment guard; creator/assignee/editor kept separate |
| Permissions | Live role/module checks intersected with key scopes; board/project/reference consistency validation | Project membership authorization on all reads and writes, including secondary references and aggregates |
| Administration | Admin RPC/UI for human and AI members; member-bound key issue/list/revoke | Minimal authorized assignable-member discovery through MCP |
| Reliable writes | Transactional event commit, replay and rollback; report/comment revision checks | Task/board compare-and-set revisions; command idempotency and structured attribution for all relevant changes |
| Execution | External agents execute work; task assignment and comments are stored | Generic functional access first; runtime orchestration/dispatch are optional integrations |
| Operations | File-backed SQLite, process lock, optional Litestream template, Chromium/mobile-width tests | Retained storage for business use, tested isolated restore, broader mobile verification and distribution review |

The shared auth model is implemented; the rows marked remaining work are not. Existing project consistency tests must not be described as authorization isolation tests. Generic workspace activity still stores actor names rather than a complete structured audit identity.

## Identity and policy contract

Extend the team model with a stable `member_id`, `kind` (`human` or `agent`), display name, role/module permissions and lifecycle state. Disabled or removed members are ineligible for new access or assignment, but their historical records remain attributable. Agents do not receive synthetic passwords or fictitious email addresses just to satisfy human onboarding validation.

Each credential binds immutably to one agent member and records its issuing administrator separately. Separate agents require separate credentials; rotation may temporarily give one agent multiple credentials. A missing member, disabled member, expired key or revoked key denies access. Check again when the actor processes the command, not only when HTTP accepts it. Do not trust caller-supplied member IDs, actor kind, author names or timestamps for provenance.

For agents, effective access is the intersection of the active member's role/module permissions, authorized project membership and key scopes. For humans, apply member and project permissions without a key-scope factor. Define any workspace-admin exception explicitly; agent access must not inherit an issuer's admin bypass. Reductions in access apply to subsequent operations, including queued commands that have not executed.

Use one policy implementation for lists, details, comments, reports, search, activity, polling and writes. Apply authorization before pagination, counts or search results, so hidden records do not leak through summaries. Validate both source and destination for moves and every linked record. Unknown and unauthorized IDs must not provide an existence oracle. A `project_id` request filter cannot widen a principal's grants.

Explicitly define workspace-scoped access for customer records, unlinked reports and aggregate feeds. Linking a visible record to a hidden task/project/customer must not reveal that record or grant access. Do not claim client isolation until these reference paths are covered.

Expose only minimal authorized member details through an assignable-members read tool: stable ID, display name and kind, with eligibility/status as needed. Do not expose passwords, key material, signing data or unnecessary profile fields. Team and credential lifecycle operations remain outside normal agent tools.

## Provisioning policy for this version

An authenticated human administrator creates AI profiles and assigns their role/module access, then issues a unique member-bound key. AI credentials cannot create other users, issue keys, modify their own role/access or change their member kind. Any future delegated user administration needs an explicit permission and credential scope; it is not implied by MCP access.

## One session model, different login credentials

| User | Login credential | Result | Functional access |
| --- | --- | --- | --- |
| Human | Email and password | Short-lived token for that member | UI, RPC and supported MCP tools under current permissions |
| AI | Its own agent key | Short-lived token for that AI member | The same service policy through RPC/MCP, limited further by key scopes |

The key is a login credential, not a role or shared team identity. Roles and project grants belong to the user; `kind=agent` does not confer privileges. Issuer metadata does not become the authenticated actor. Administrative operations need explicitly supported permissions and credential scopes even when an AI user has an administrative role.

The exchange validates the key and active member before issuing a signed access token. Carry the stable member subject, credential/session ID, scope ceiling, intended issuer/audience and issuance/expiry. Never include the raw key or provider secrets. Start with the existing short session lifetime, expiring no later than the login credential. Clients can exchange their key again when necessary; refresh tokens are not required initially.

Every protected request validates the token and checks current member, project and credential state. Revoking the key, disabling/removing the member or reducing access invalidates outstanding sessions on subsequent operations. A valid JWT signature alone is insufficient. Do not exchange an agent key for an unrestricted human JWT that loses its scopes. Both adapters resolve a common principal: using RPC instead of MCP cannot bypass credential restrictions.

MCP calls use `Authorization: Bearer <access-token>`. A custom key exchange requires a client/adapter that can perform and renew it; arbitrary MCP clients will not necessarily discover that exchange automatically. Standards-based MCP OAuth discovery is a separate interoperability feature, guided by the [MCP authorization specification](https://modelcontextprotocol.io/specification/latest/basic/authorization). Document tested configurations for Hermes, Claude Code and Codex rather than claiming untested native compatibility. v0.2.2 accepted raw agent keys directly; v0.3.0 replaces that with this exchange model.

## Writes, history and execution

Task/board updates must supply the expected revision. A stale write returns a conflict without committing events or partial changes. Create commands accept a principal-bound idempotency key: the same key and payload return the original result; the same key with a different payload is rejected. Persist the deduplication result atomically with domain events so retries after a response is lost or the process restarts do not duplicate records. Define retention and the supported retry window.

Record stable actor member ID/kind, credential ID where applicable, target IDs, action, server timestamp, relevant changes, revision and command/correlation ID. Preserve attribution after renaming, disabling or rotating credentials. Historical key references remain metadata, never a secret. Never place bearer tokens, password hashes or provider credentials in activity/events/logs. Keep security rejection logging separate from successful business events, and redact it too.

Generic MCP/API access does not require a watcher, Ready category, runtime profile mapping or Office Office starting a process. A client authenticates as its own AI user and performs permitted functions directly. External dispatchers may optionally add Ready-triggered handoffs, claims, attempt/run references and reconciliation; see [optional agent dispatch](agent-dispatch.md). Runtime mappings are integration configuration, never a prerequisite for team membership or a Hermes-only dependency.

An assignment is planned work. Only observed execution or a deliberate authorized update advances status. External clients should update Office Office rather than maintain a competing authoritative board. Provider publishing, invoices and other external effects retain separate narrow permissions, audit and approval policies.

## Delivery sequence and compatibility

1. Add AI users in the shared member/role model, member-bound keys, key-to-token exchange, a common authenticated principal, server-derived provenance and admin setup. Preserve human email/password login and prevent AI tokens bypassing scopes through another transport.
2. Add project memberships and common visibility policy, then eligible assignment and minimal MCP member discovery. Include workspace-scoped records and reference checks in this slice.
3. Add task/board revisions and durable command idempotency; extend history with stable identities and change metadata.
4. Verify generic functional access with independently configured agent clients. Membership and MCP use must not depend on Hermes or a dispatcher. Introduce project/customer tools only when explicitly required and separately scoped.
5. Verify the release against the acceptance matrix below. Before business records or migration, complete retained-storage, restore, mobile and distribution checks.

Ready-triggered execution is an optional later integration. If implemented, deliver claims, attempts, safe retries, heartbeat/uncertainty, cancellation and review together before claiming automatic dispatch works.

Existing key-to-creator bindings must not silently become agent identities or retain an administrator's authority. Require explicit admin provisioning and new credentials, revoking legacy keys during a controlled migration. Preserve historical authorship as recorded; do not rewrite past human/key activity as a newly created agent. Event replay must remain compatible with previous events, and historical records lacking new metadata must not invent a principal. Non-admin legacy project grants need an explicit migration policy; fail closed for agent access rather than treating a missing membership as all-project permission.

## Next-deployment acceptance matrix

Use disposable offices with two agent members and two projects, disjoint project memberships, separate scoped keys and a human admin. Set up through supported UI/RPC/engine commands; do not seed projections or private tables. Use a controlled test clock for expiry. Repeat transport-sensitive cases through the deployed HTTPS endpoint with its configured Host, not only loopback. The identity, exchange, scope, revocation, attribution and replay cases are implemented in tests; project-grant, assignment-guard, revision/idempotency and optional-dispatch cases remain acceptance requirements.

| Scenario | Required result |
| --- | --- |
| Agent A reads/writes its allowed project | Allowed; returned records and audit identify Agent A's member ID |
| Missing, malformed, unknown, expired or revoked key | Denied; no mutation or record disclosure |
| AI key exchanged for access token | Subject is the AI member; expiry, issuer/audience and key-scope ceiling enforced |
| Missing, malformed, expired or wrong-audience access token | Denied through RPC and MCP |
| Key revoked/member disabled after token issuance | Existing token denied on the next operation |
| AI token used through RPC instead of MCP | Identical permissions and scope restrictions |
| Client uses MCP without runtime mapping or dispatcher | Supported functional calls work under that user's permissions |
| Otherwise-valid key bound to missing, disabled or removed member | Denied on the next operation, including an already queued command |
| Issuer and agent are different people/identities | Attribution and grants come from the bound agent, not the issuer |
| Read-only key calls each write tool/RPC adapter | Denied; event stream, revision and records unchanged |
| Agent A addresses Project B by ID or malicious filter | Denied/omitted across details, lists, counts, search, feeds and polling |
| Visible record links to unauthorized project/task/customer | Denied without leaking the referenced record |
| Assign pending, disabled, nonexistent or unauthorized member | Rejected through UI, RPC and MCP |
| Unassigned backlog enters active-work category | Rejected even when a custom label names the column |
| Agent A and Agent B comment or report | Distinct stable authors; disabling/renaming either preserves past attribution |
| Forged author/member/key metadata | Ignored or rejected; authenticated principal determines provenance |
| Two stale task/board writers | One accepted revision; stale operation conflicts without overwriting |
| Create committed but response lost, then retried/restarted | Same result/ID once; reused token with different payload rejected |
| Assignment without a confirmed run | Remains assignment; does not fabricate working/running state |
| Optional dispatcher is installed | Its claims, runtime and review checks pass separately from baseline MCP access |
| Principal without required admin permission/scope attempts team/key administration | Denied; assignable-member discovery reveals no credentials |

Before real business data: retain the database across container upgrades; restore a backup to an isolated instance and validate events/auth; test target mobile browsers/devices; inventory repository/dependency/asset licenses and attribution before distribution; keep external operations explicitly permissioned and approval-gated. A successful replication upload or existing Postgres backup is not evidence of a successful SQLite restore.

## Implementation evidence

- [Protobuf contract](../proto/office/v1/office.proto): `Member`, `AgentKey`, `Task`, `Board`, report/comment revision requests.
- [Engine and authorization](../apps/server/src/lib.rs): `save_member`, `save_task_as`, `create_agent_key`, `agent_owner`, `agent_identity`, `agent_workspace`.
- [MCP adapter and host checks](../apps/server/src/mcp.rs): tool inventory, request authentication and configurable host validation.
- [Existing test coverage](testing.md): engine, RPC/MCP and browser scenarios. Expired-key and changed-owner permissions are covered by `agent_key_expires_and_owner_permissions_are_rechecked`; this does not prove independent agent membership.


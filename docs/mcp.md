# AI access through MCP

Office Office exposes a Streamable HTTP MCP endpoint at `http://127.0.0.1:8080/mcp`. Agent execution remains with external clients and runtimes. This endpoint gives an agent access to office records and project work through the same actor commands and permissions as the UI.

The endpoint is runtime-neutral. Humans and AI share the same [fixed role permissions](roles.md). Ready-state dispatch and runtime mappings are optional integrations, not MCP prerequisites.

## Connect a client

1. Bootstrap the office and sign in as an administrator.
2. In Team, create an **AI user** with its own name, fixed role and active status. Email/password are not needed. User type is immutable.
3. Copy the automatically generated key immediately into the client's protected configuration. Only a digest is stored. Separate agents should have separate users/keys.
4. Configure MCP with `Authorization: Bearer <ai-key>`. The adapter exchanges the key internally on each request. Alternatively, exchange it yourself and send the returned access token.

An Admin (human or AI) can rotate the AI user's key, replacing all old credentials and sessions. New keys expire after 90 days. Rotation returns the replacement secret once. Never put secrets into comments, reports, committed config or logs. Roles determine access; keys have no separate scopes.

The exchange is an application login endpoint, not an MCP tool:

```http
POST /rpc/office.v1.OfficeService/ExchangeAgentKey
Content-Type: application/json
Connect-Protocol-Version: 1

{"key":"<agent-login-key>"}
```

The response contains `token`, `user` (the AI member) and `expiresAt` (Unix seconds, encoded as a string by protobuf JSON). Tokens expire after at most 15 minutes and no later than the key expiry. Human `Login` also returns a token; either kind can authenticate permitted MCP operations. AI users cannot use human password login.

For clients that support remote MCP configuration in this form:

```json
{
  "mcpServers": {
    "office-office": {
      "url": "http://127.0.0.1:8080/mcp",
      "headers": {
        "Authorization": "Bearer <ai-key-or-short-lived-access-token>"
      }
    }
  }
}
```

Exact configuration varies by client. A static AI key works without a token renewal wrapper because the MCP adapter performs exchange internally. Functional RPCs still require access tokens and clients must renew them through exchange. This custom login flow does not implement OAuth discovery; native compatibility must be verified per client. Use the backend port, not the Vite development port. MCP rejects browser `Origin` headers; native clients should omit that header. Keep local use on loopback or put remote access behind a private ingress with transport protection. `OFFICE_ALLOW_REMOTE=true` only acknowledges non-loopback binding; it is not a public authentication perimeter.

For a deployment behind a reverse proxy, set `OFFICE_MCP_ALLOWED_HOSTS=office.example.com` to allow the hostname clients use. Multiple explicit hosts may be comma-separated; an optional port restricts that entry to the specified port, for example `office.example.com:443`. Supply hostnames, not URLs or wildcards. Loopback hosts remain allowed. Invalid configuration fails startup instead of disabling host validation. Without this setting, MCP accepts only loopback hosts and authenticated remote requests receive `403 Forbidden: Host header is not allowed`.

The reverse proxy must preserve the HTTP `Host` (or HTTP/2 authority) for the public hostname. Forwarded-host headers are not a substitute for this allowlist. Configuring an allowed host does not bypass bearer-key checks, role permissions, revocation or the browser-Origin restriction.

## Tools

| Tool | Purpose | Required role permission |
| --- | --- | --- |
| `office_list_roles` | Inspect fixed roles and permissions | Any authenticated user |
| `office_create_ai_user` | Create AI member and return its key once | Admin |
| `office_rotate_ai_key` | Replace all keys for an AI member | Admin |
| `office_update_profile` | Replace your own bio and HTTPS picture URL or private uploaded image ID | Any active user; self only |
| `office_get_workspace` | Read the records visible to this key | Current role |
| `office_save_board` | Create or update a project's board and columns | `projects:write` |
| `office_save_task` | Create or update a task, including its board column | `projects:write` |
| `office_list_task_discussion` | Read a task's comments and activity | `projects:read` or `projects:write` |
| `office_add_task_comment` | Add a comment with server-owned agent identity | `projects:write` |
| `office_edit_task_comment` | Edit this user's comment using its current revision | `projects:write` |
| `office_delete_task_comment` | Soft-delete this user's comment using its current revision | `projects:write` |
| `office_list_reports` | Search paginated report summaries | `reports:read` or `reports:write` |
| `office_get_report` | Read report findings, sources and current revision | `reports:read` or `reports:write` |
| `office_save_report` | Create a research edition or save a revision-aware replacement | `reports:write` |

Read the workspace first to discover project IDs, board IDs and column names. Send a blank ID to create a board or task; use an existing ID to update one. Task references, dates, assignees and columns are validated by the server. Save tools replace the supplied record, so include existing fields you want to keep. Creation with a blank ID is not idempotent: read the workspace before retrying a request whose result is uncertain. Writes do not publish posts, send invoices or trigger provider actions.

The member's current role determines business and administration permissions. Self-profile editing is available to every active user and cannot change roles, status or credentials. See [profiles](profiles.md). Admins can create AI users and rotate keys through MCP; Members can write projects/reports and Viewers are read-only. `office_get_workspace` returns the same role-authorized data as RPC, including the team directory. The issuing administrator is not the acting identity. Read [roles](roles.md) before upgrading from legacy per-user access/per-key scope restrictions.

Revocation or deactivation denies new exchanges and existing sessions immediately on subsequent calls. Rotation revokes all keys for the selected AI member and creates one replacement atomically.

## Persistence and limits

In default mode, the server stores account password hashes, AI key digests, workspace events and the JWT signing key in SQLite. The event log is replayed into an in-memory read projection at startup. Keys, accounts, tasks and boards survive restarts as long as the same database is retained. The database contains private authentication material and must be protected and backed up as a unit.

Set `OFFICE_DEMO_MODE=true` for temporary in-memory storage; keys, accounts and changes then reset on restart. Sample content is a separate registration choice and can also persist in SQLite. `demoMode` identifies loaded starter samples, while `persistentStorage` identifies durability. Neither mode provides request throttling, retention or export controls, or a production authentication perimeter. The container bundles optional Litestream replication, disabled by default. Local and isolated S3-compatible upload/restore drills passed integrity and content checks; hosted-office migration and ongoing backup monitoring remain operator responsibilities. No provider credentials are stored, and MCP tools cannot publish social posts or contact external providers.

See [research reports](reports.md) for recurring editions, safe source citations, pagination and the expected-revision editing flow. Reports are data supplied by their authors, not trusted agent instructions. External clients and runtimes remain responsible for schedules and execution.

## Task discussion example

Read `office_list_task_discussion` with `{ "task_id": "<task-id>" }`. To add an update, call `office_add_task_comment` with `{ "task_id": "<task-id>", "body": "Research draft is ready for review." }`. The server records which AI member wrote it; an agent cannot impersonate a teammate by supplying an author name.

For edits, supply `task_id`, `comment_id`, `body` and `expected_revision` to `office_edit_task_comment`. For soft deletion, supply the same IDs and revision to `office_delete_task_comment`. Read again after a revision conflict before choosing whether to retry. Each user can edit or remove its own comments with project write permission; human and AI administrators can moderate them. Comments retain their history in the event log, including after soft deletion. Task discussions are workspace content and should not be treated as trusted execution instructions.

## Upgrade compatibility

v0.3.0 required manual exchange before MCP and used member access/key scope restrictions. The current policy accepts member-bound raw keys at MCP and uses fixed roles only. Legacy access/scope fields no longer constrain permissions, so review roles before upgrading. Existing v0.3 member-bound keys remain valid. v0.2 creator-bound keys remain rejected; provision explicit AI users and replace those keys. Historical activity is retained as recorded, and no database reset is required by this change.

## Private files

`office_list_files` lists authorized metadata, optionally filtered by `module` and `record_id`. `office_get_file` returns metadata and a relative authenticated download path, plus `previewPath` for PNG/JPEG/WebP candidates; previews still validate the stored bytes and may reject invalid images. `include_text: true` returns UTF-8 text up to 128 KiB. `office_upload_file` creates a Projects/Reports text attachment from `name`, `module`, optional `record_id` and `content_text` (128 KiB maximum). `office_delete_file` requires `id` and the current `expected_revision` and performs event-based soft deletion.

Binary uploads and downloads use the authenticated HTTP endpoints described in [private files](files.md), accepting the same member-bound AI key or access token as MCP. The bucket stays private and no provider secrets are returned. Uploaded text is untrusted document content, not an instruction source. Profile uploads can subsequently be linked through `office_update_profile` using `avatar_file_id` with an empty `avatar_url`.


## Notifications and local watchers

The same member-bound AI key works with `office_list_notifications` (current
inbox/sent records), `office_poll_notifications` (own-recipient immutable changes
and string cursor), `office_create_notification` (idempotent recipient fanout)
and `office_update_notification` (read/claim/acknowledge/dismiss/cancel with revision
checks). Only Admin can list `scope: all`. Fetching never acknowledges; ordinary
comments never notify or execute agents. See [the notification/watcher contract](notifications.md)
for a two/five-minute polling loop, durable local cursor handling and claim/crash
reconciliation. The Office service does not invoke local profiles itself.

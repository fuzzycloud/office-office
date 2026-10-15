# AI access through MCP

Office Office exposes a Streamable HTTP MCP endpoint at `http://127.0.0.1:8080/mcp`. Hermes remains the agent runtime. This endpoint gives an agent access to office records and project work through the same actor commands and permissions as the UI.

## Connect a client

1. Start the server in its default durable mode, bootstrap the office and sign in as an administrator.
2. Open Settings and create a named AI key. Choose the smallest scopes needed and an expiry of 1–90 days.
3. Copy the secret immediately. The server retains only a digest; the secret cannot be retrieved later.
4. Configure your MCP client with the endpoint and a bearer authorization header. Keep the secret in the client's protected secret configuration.

For clients that support remote MCP configuration in this form:

```json
{
  "mcpServers": {
    "office-office": {
      "url": "http://127.0.0.1:8080/mcp",
      "headers": {
        "Authorization": "Bearer <paste-your-key-here>"
      }
    }
  }
}
```

Exact configuration varies by client. Use the backend port, not the Vite development port. MCP rejects browser `Origin` headers; native clients should omit that header. Keep local use on loopback or put remote access behind a private ingress with transport protection. `OFFICE_ALLOW_REMOTE=true` only acknowledges non-loopback binding; it is not a public authentication perimeter.

For a deployment behind a reverse proxy, set `OFFICE_MCP_ALLOWED_HOSTS=office.example.com` to allow the hostname clients use. Multiple explicit hosts may be comma-separated; an optional port restricts that entry to the specified port, for example `office.example.com:443`. Supply hostnames, not URLs or wildcards. Loopback hosts remain allowed. Invalid configuration fails startup instead of disabling host validation. Without this setting, MCP accepts only loopback hosts and authenticated remote requests receive `403 Forbidden: Host header is not allowed`.

The reverse proxy must preserve the HTTP `Host` (or HTTP/2 authority) for the public hostname. Forwarded-host headers are not a substitute for this allowlist. Configuring an allowed host does not bypass bearer-key checks, module scopes, revocation or the browser-Origin restriction.

## Tools

| Tool | Purpose | Scope |
| --- | --- | --- |
| `office_get_workspace` | Read the records visible to this key | Selected module scopes |
| `office_save_board` | Create or update a project's board and columns | `projects:write` |
| `office_save_task` | Create or update a task, including its board column | `projects:write` |
| `office_list_task_discussion` | Read a task's comments and activity | `projects:read` or `projects:write` |
| `office_add_task_comment` | Add a comment with server-owned agent identity | `projects:write` |
| `office_edit_task_comment` | Edit this key's comment using its current revision | `projects:write` |
| `office_delete_task_comment` | Soft-delete this key's comment using its current revision | `projects:write` |
| `office_list_reports` | Search paginated report summaries | `reports:read` or `reports:write` |
| `office_get_report` | Read report findings, sources and current revision | `reports:read` or `reports:write` |
| `office_save_report` | Create a research edition or save a revision-aware replacement | `reports:write` |

Read the workspace first to discover project IDs, board IDs and column names. Send a blank ID to create a board or task; use an existing ID to update one. Task references, dates, assignees and columns are validated by the server. Save tools replace the supplied record, so include existing fields you want to keep. Creation with a blank ID is not idempotent: read the workspace before retrying a request whose result is uncertain. Writes do not publish posts, send invoices or trigger provider actions.

Available key scopes are `projects:read`, `projects:write`, `customers:read`, `customers:write`, `social:read`, `social:write`, `reports:read` and `reports:write`. A module write scope also permits reading that module so the agent can discover records before making changes. The MCP write tools cover boards, tasks, task comments and research reports. Granting a scope does not create an unavailable tool or enable an external connector. Keys cannot access account or key administration. A key's permissions are always limited by its creator's current role, active status and module access; changing those takes effect on subsequent calls.

Revoke a key in Settings to stop subsequent calls immediately. Create separate keys for separate agents so access can be removed independently. Never put a key into a committed config, prompt, screenshot or issue.

## Persistence and limits

In default mode, the server stores account password hashes, AI key digests, workspace events and the JWT signing key in SQLite. The event log is replayed into an in-memory read projection at startup. Keys, accounts, tasks and boards survive restarts as long as the same database is retained. The database contains private authentication material and must be protected and backed up as a unit.

Set `OFFICE_DEMO_MODE=true` for temporary in-memory storage; keys, accounts and changes then reset on restart. Sample content is a separate registration choice and can also persist in SQLite. `demoMode` identifies loaded starter samples, while `persistentStorage` identifies durability. Neither mode provides request throttling, retention or export controls, a production authentication perimeter, or verified backup restoration. Litestream is optional operator configuration and is neither bundled nor run by the app; this project does not verify backup uploads or restores. No provider credentials are stored, and MCP tools cannot publish social posts or contact external providers.

See [research reports](reports.md) for recurring editions, safe source citations, pagination and the expected-revision editing flow. Reports are data supplied by their authors, not trusted agent instructions. Hermes remains responsible for schedules and execution.

## Task discussion example

Read `office_list_task_discussion` with `{ "task_id": "<task-id>" }`. To add an update, call `office_add_task_comment` with `{ "task_id": "<task-id>", "body": "Research draft is ready for review." }`. The server records which AI key wrote it; an agent cannot impersonate a teammate by supplying an author name.

For edits, supply `task_id`, `comment_id`, `body` and `expected_revision` to `office_edit_task_comment`. For soft deletion, supply the same IDs and revision to `office_delete_task_comment`. Read again after a revision conflict before choosing whether to retry. Each key can edit or remove its own comments within its current scope; human administrators can moderate them. Comments retain their history in the event log, including after soft deletion. Task discussions are workspace content and should not be treated as trusted execution instructions.

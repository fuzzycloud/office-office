# AI access through MCP

Office Office exposes a Streamable HTTP MCP endpoint at `http://127.0.0.1:8080/mcp`. Hermes remains the agent runtime. This endpoint gives an agent access to office records and project work, using the same actor commands and permissions as the UI.

## Connect a client

1. Bootstrap the office and sign in as an administrator.
2. Open Settings and create a named AI key. Choose the smallest scopes needed and an expiry of 1–90 days.
3. Copy the secret immediately. The server retains only a hash; the secret cannot be retrieved later.
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

Exact configuration varies by client. Use the backend port, not the Vite development port. Native clients should omit the `Origin` header: this preview rejects requests carrying an Origin. Use HTTPS when a durable hosted version is deployed.

## Tools

| Tool | Purpose | Scope |
| --- | --- | --- |
| `office_get_workspace` | Read the records visible to this key | Selected module scopes |
| `office_save_board` | Create or update a project's board and columns | `projects:write` |
| `office_save_task` | Create or update a task, including its board column | `projects:write` |

Read the workspace first to discover project IDs, board IDs and column names. Send a blank ID to create a board or task; use an existing ID to update one. Task references, dates, assignees and columns are validated by the server. Save tools replace the supplied record, so include existing fields you want to keep. Creation with a blank ID is not idempotent: read the workspace before retrying a request whose result is uncertain. Writes do not publish posts, send invoices or trigger provider actions.

Available key scopes are `projects:read`, `projects:write`, `customers:read`, `customers:write`, `social:read` and `social:write`. A module write scope also permits reading that module so the agent can discover records before making changes. The initial MCP write tools cover boards and tasks only. Granting a scope does not create an unavailable tool or enable an external connector. Keys cannot access account or key administration. A key's permissions are always limited by its creator's current role, active status and module access; changing those takes effect on subsequent calls.

Revoke a key in Settings to stop subsequent calls immediately. Create separate keys for separate agents so access can be removed independently. Never put a key into a committed config, prompt, screenshot or issue.

## Preview limits

Accounts, keys, tasks and boards are in memory and reset when the process restarts. This is a development preview, not a durable deployment. Raw keys stay outside domain events and key lists. SQLite persistence, protected recovery of signing/encryption material, durable audits, request throttling and a production authentication perimeter remain future work.

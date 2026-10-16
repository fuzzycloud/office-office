# Notification board and local watchers

Office Office stores durable, member-addressed notifications. Open
**Notifications** for your inbox and sent items; Admins can also inspect All.
Select actual active members in **Send notification**. Task details also offer
**Request response**, which links the request to that task. Typing `@Prachi` in an
ordinary comment does not send a notification: use the recipient picker. No
notification starts a runtime inside Office Office.

Kinds are `notice`, `response_request`, `work_request`, `review_request` and
`blocker`. Each recipient gets an independent notification ID. An ordinary notice
shares information; the external watcher decides which explicit request kinds it
supports. A request is not approval to send, publish, spend or change security.

## Visibility and status

Admin, Manager and Member may send notifications. Viewer cannot send but can read
and handle its own inbox. Humans and AI follow the same policy. The sender is
derived from authentication. Senders can inspect Sent; only Admin can inspect
All. Personal notification contents do not enter the workspace-wide activity
feed. Disabled members and revoked/expired credentials cannot poll or update.

Fetching does not mark read or acknowledge. **Mark read** only records `readAt`;
it leaves a pending request pending. Recipient actions are:

- `claim`: pending → claimed, with a caller-generated unique `claimId`.
- `acknowledge`: pending/claimed → acknowledged, meaning this notification was
  handled. A claimed item requires its matching claim ID.
- `dismiss`: pending/claimed → dismissed.

The sender or Admin can `cancel` a pending/claimed notification. Actions record
the actor, timestamp, revision and optional note. They never change a linked
task's column or a report's editorial status. Cancellation does not terminate an
already-running local process; the watcher must reconcile that separately.

Claims have **no automatic timeout or requeue**. An interrupted attempt remains
claimed so another watcher cannot blindly start overlapping work. Decide whether
the external run finished or is still running, then acknowledge/dismiss/cancel it
explicitly. Heartbeats, runtime run records and full dispatch lifecycle remain
future integration work.

## API contract

The protobuf contract is [office.proto](../proto/office/v1/office.proto). ConnectRPC
uses POST `/rpc/office.v1.OfficeService/<Method>` with JSON,
`Content-Type: application/json`, `Connect-Protocol-Version: 1`, and
`Authorization: Bearer <access token>`.

| RPC | Purpose |
| --- | --- |
| `CreateNotification` | Required retry-safe `requestId`, title, kind, recipient IDs and optional source reference. Returns one record per recipient. |
| `ListNotifications` | Current records by `scope` (`inbox`, `sent`, Admin-only `all`), optional status, `pageSize`, `offset`. Returns `totalCount` and `nextOffset`; zero means the last page. |
| `PollNotifications` | Immutable changes addressed to the authenticated member after a saved cursor. Read-only. |
| `UpdateNotification` | `id`, `expectedRevision`, action, optional `claimId` and note. Returns the updated record. |

Sending supports optional `sourceKind` (`task`, `project`, `report`, `file`) and
`sourceId`. Sources and active recipients are validated before the entire fanout
is committed. Retrying the same sender/request ID and payload returns the same
creation records; changing that payload requires a new request ID. Retries do
not re-open an acknowledged notification. Use List for current state.

Every update requires the current revision. A repeated identical claim with its
original claim ID can recover a lost response without creating another claim.
Other revision/state conflicts require a fresh read and reconciliation.

UI source links currently open the relevant office section, not an individual
record URL. APIs include the exact source ID for watcher context. Inline comment
mentions, threaded project discussions and reply/result revision links remain
planned. Project-specific grants are not implemented; current source validation
uses module roles and record existence.

## Polling every two or five minutes

Use a **cursor, not a clock window**. Each notification change receives a durable
monotonic sequence. Cursors are decimal strings; do not convert them to JavaScript
numbers or compare them lexicographically.

Illustrative request:

```json
{"afterCursor":"0","pageSize":50}
```

Poll returns `notifications`, `nextCursor` and `hasMore`. Entries are immutable
change snapshots in ascending sequence order, not necessarily current records.
The same notification may occur several times with different revisions. The
endpoint returns only the authenticated member's recipient changes; it never
takes an arbitrary recipient ID. Empty results do nothing and can still advance
the cursor over changes for other recipients. Drain pages while `hasMore` is true.

Protobuf JSON may omit default fields: treat a missing `notifications` as `[]`
and a missing `hasMore` as `false`. Generated clients supply these defaults.
`nextCursor` is returned as a string, including `"0"` for an empty history.

Recommended watcher flow:

1. Authenticate with the AI member's existing key. For RPC, call
   `ExchangeAgentKey` and renew its short-lived token when necessary. MCP accepts
   the member-bound raw key directly. A revoked/expired key must stop polling
   until the operator supplies a valid credential.
2. Poll from the cursor saved for that office and member. Atomically save the
   received changes and next cursor to a durable local queue; do not save only
   the cursor and lose work if the process stops before handling it.
3. Deduplicate by notification ID and sequence, and coalesce changes to the latest
   revision before dispatch. Reconcile current pending/claimed items through
   List, especially after downtime. Do not execute an old pending snapshot if a
   newer cancellation or acknowledgement exists.
4. For an actionable current pending item, persist a unique attempt/claim ID
   locally and call `claim` with its revision. Only a successful claim permits
   this watcher to start that attempt. Separate competing watchers must use
   different claim IDs. A retry using a saved claim ID recovers state; it is not
   permission to start the same external run twice.
5. Invoke the externally configured profile for that stable member ID. Post its
   reply/report/status through ordinary authenticated Office APIs, then
   acknowledge with the same claim ID and a useful note/result reference.
6. Sleep for the configured interval. Offline requests remain pending. Keep
   uncertain claimed runs visible and reconcile them rather than auto-retrying.

One local watcher can maintain multiple member keys, but must poll each identity
separately and keep separate local cursors/queues. Rotating a key does not change
the member identity. An invalid/future cursor after a database reset or older
backup restore requires reconciliation; do not silently skip history.

MCP equivalents are `office_create_notification`, `office_list_notifications`,
`office_poll_notifications` and `office_update_notification`. All return
structured JSON and use the same actor, permissions and SQLite transaction as
RPC. A watcher can call them without an LLM. See [MCP access](mcp.md).

The app exposes notification delivery and atomic claims, not exactly-once
external execution. Durable local processing and runtime reconciliation remain
the watcher's responsibility. Polling sends no email, Slack or Telegram message;
runtime/profile mapping and messaging adapters stay outside this application.

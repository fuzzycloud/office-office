# Notification board and local watchers

Office Office stores durable, member-addressed notifications. Open
**Notifications** for your inbox and sent items; Admins can also inspect All.
Select actual active members in **Send notification**. Task details also offer
**Request response**, which links the request to that task. Typing `@Prachi` in an
ordinary comment is plain text: select the actual member in the structured mention picker to notify them. No
notification starts a runtime inside Office Office.

Kinds are `notice`, `response_request`, `work_request`, `review_request` and
`blocker`. Each recipient gets an independent notification ID. An ordinary notice
shares information; the external watcher decides which explicit request kinds it
supports. A request is not approval to send, publish, spend or change security.

## Visibility and status

Admin, Manager and Member may send notifications. Viewer cannot send but can read
and handle its own inbox. Humans and AI follow the same policy. The sender is
derived from authentication. Senders can inspect Sent; only Admin can inspect
All. Personal notification contents do not enter the workspace-wide activity feed. Feedback entries (created/read/claimed/acknowledged/dismissed/cancelled) are visible only to the sender and recipient, additionally constrained by source access. Disabled members and revoked/expired credentials cannot poll or update.

Fetching does not mark read or acknowledge. **Mark read** only records `readAt`;
it leaves a pending request pending. Recipient actions are:

- `claim`: pending → claimed, with a caller-generated unique `claimId`.
- `acknowledge`: pending/claimed → acknowledged, meaning this notification was
  handled. A claimed item requires its matching claim ID.
- `dismiss`: pending/claimed → dismissed.

The sender or Admin can `cancel` a pending/claimed notification. Actions record
the actor, timestamp, revision and optional note. They never change a linked
task's column or a report's editorial status. A notification backed by a report review must be resolved through `DecideReportReview`, preserving the authoritative review decision. Cancellation does not terminate an
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
| `UpdateNotification` | `id`, `expectedRevision`, action, optional `claimId`, note and exact `resultKind`/`resultId`/`resultRevision`. Returns the updated record. |

Sending supports optional `sourceKind` (`task`, `project`, `report`, `file`, `task_comment`, `project_message`, `report_review`), `sourceId` and `sourceRevision`. Sources and active recipients are validated before the entire fanout
is committed. Retrying the same sender/request ID and payload returns the same
creation records; changing that payload requires a new request ID. Retries do
not re-open an acknowledged notification. New public request IDs cannot use the reserved workflow prefixes `task_comment:`, `project_message:`, `task-assignment:` or `review:`; use a caller-generated UUID instead. Use List for current state.

Every update requires the current revision. A repeated identical claim with its
original claim ID can recover a lost response without creating another claim.
Other revision/state conflicts require a fresh read and reconciliation.

The header bell shows unread items separately from unresolved attention. The full
Notifications board keeps inbox, sent, Admin-only all, and paginated Office activity views. Source links use
`ResolveSource` to authorize and locate a task, project discussion, file or exact
report revision. Result links identify the actual reply/report/review, rather than
assuming a claimed request has completed. Project-specific grants are not
implemented; current source validation uses module roles and record existence.

### Business activity

`ListActivity` exposes recent authorized business changes with actor IDs, names,
kinds, source IDs/revisions and timestamps. `PollActivity` returns ascending
append-only entries with an independent `activity:v1:N` cursor, `nextCursor` and
`hasMore`. Use an empty cursor for a new consumer. The cursor cannot be exchanged
with `PollNotifications`; that existing recipient-only decimal contract is unchanged.
Drain pages, persist the cursor with local queue insertion, and deduplicate entries
by ID/sequence. Reconcile after a database reset or older restore rather than
silently skipping history.

The feed covers new domain writes and private notification feedback. It is not a
backfilled claim about historical actors: older name-only workspace activity remains
legacy history. Member/key/security changes are Admin-only; credentials are never
included. Private notification feedback is participant-only. Reads, polling and
health checks emit no activity. File deletion remains visible in authorized history,
while downloads of deleted objects remain denied.

New/reassigned tasks generate a `work_request` for their active assignee. Unassigning
or reassigning cancels the old open assignment request; unchanged saves do not create
another. Pending sample teammates receive no assignments until activated. Structured
mentions create informational notices; explicit response requests are separate.
Report review requests and decisions refer to an exact report revision. Deleting a conversation source cancels its open requests; removing an explicit response recipient cancels that generated request while retaining history. No activity
or attention record starts an agent, changes card status or grants provider approval.

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

MCP activity equivalents are `office_list_activity` and `office_poll_activity`; `office_resolve_source` provides authorized navigation context. Notification equivalents are `office_create_notification`, `office_list_notifications`,
`office_poll_notifications` and `office_update_notification`. All return
structured JSON and use the same actor, permissions and SQLite transaction as
RPC. A watcher can call them without an LLM. See [MCP access](mcp.md).

The app exposes notification delivery and atomic claims, not exactly-once
external execution. Durable local processing and runtime reconciliation remain
the watcher's responsibility. Polling sends no email, Slack or Telegram message;
runtime/profile mapping and messaging adapters stay outside this application.

## Board actions and watcher wake-ups

Saving a new assignment or changing its assignee creates an automatic
`work_request`. Selecting a real member in the structured mention picker creates
an informational `notice`; plain text such as `@tara` is not a member identity.
Use **Request response** for an explicit question that a watcher may dispatch.
The inline comment/message picker also offers **Ask to act / respond** before
choosing an `@` recipient. FYI is informational; selecting action mode stores
the member ID in `responseRecipientIds`. A connected worker may claim an eligible
request on its next poll, subject to its own sender policy, access and availability.
Neither creating nor claiming that request proves a runtime is running.

In a reply, **Reply to [person] → Request response** addresses the parent author
directly, even when the body contains no `@mention`. The saved
`responseRecipientIds` includes that member ID and produces one corresponding
`response_request`. The default **FYI** reply keeps the derived parent-author
notice informational. The receipt confirms the actual notification kind and
recipient; restarting a watcher cannot turn an informational notice into work.

A new task-comment or project-message reply creates one `notice` for its active
parent author. Self replies, unchanged saves and text edits do not repeat it. If
that author is already explicitly mentioned or response-selected, the selected
workflow provides the notification instead. Inactive parent authors are skipped
for derived notices; explicitly selecting an inactive recipient still fails.

Watchers must store informational notices without waking a runtime. Only their
configured explicit request kinds are eligible for claim/dispatch. Claims mean
picked up for handling, never completed. Always reconcile current notification
state before acting on immutable poll snapshots. This prevents routine agent
replies from launching a notification loop.

These behaviors apply to new source commands after upgrade. Existing comments
and assignments are not replayed into new requests, so already manually forwarded
work is not dispatched again. This does not require a watcher to manufacture
notifications that the application should produce.

## Verifying the composition path

The post-save receipt reads the saved source and its exact-revision notifications,
then compares them with the author's selected intent. A missing or different
recipient/mode, unexpected reply reference, or missing/duplicate notification is
a visible verification mismatch. Retry verification only reads records; it never
posts the comment again. An intentional post without recipients reports that
nobody was notified, while a reply can still inform its parent author.

For a hosted acceptance check, use a clearly labelled internal test discussion
and harmless instruction. Select **Ask to act / respond** in the deployed UI,
submit once, and read back the exact saved body, stable recipient ID, parent and
revision. Confirm one actionable notification for that source revision. Observe
the installed watcher's claim and actual profile launch, its reply at the same
discussion and acknowledgement with the matching claim ID and result reference.
Read back those records, then allow another polling cycle to check for duplicate
execution or reply loops. Repeat with FYI (notice only, no launch) and an
intentional unaddressed post (clear no-notification receipt).

The automated local worker-protocol test covers UI → RPC → SQLite → claim →
reply → acknowledgement. It does not invoke Hermes or prove a hosted worker ran.
Do not mark the full hosted integration verified from a direct notification API
smoke test, a claim, or a subprocess exit alone. Acknowledgement means handling
of the notification, independently of task completion and human approval.

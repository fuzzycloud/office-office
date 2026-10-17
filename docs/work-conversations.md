# Work conversations and needs attention

Task and project conversations support structured member-ID mentions, replies,
exact file/report references and explicit response requests. Personal attention,
report review decisions and authorized business activity are durable records.
See [notifications](notifications.md), [tasks](tasks.md), [agent access](agent-team-access.md)
and [optional dispatch](agent-dispatch.md).

## Task conversations

Keep questions, progress, decisions, review and results attached to the task.
Mentions reference stable member IDs rather than interpreting display names as
identities. Select actual visible, active members from the team directory;
renaming someone must not reroute an old request. Preserve historical attribution
when a member is disabled. A plain-text `@name` is not an authenticated mention.

In the browser composer, type `@` or use **Add Mention / FYI** to choose an
active member. Selected people appear as removable chips. **Mention / FYI**
creates an informational notice; **Request response** explicitly asks the
selected person to respond. These choices apply equally to humans and AI.
Choosing a person in one group moves them out of the other. Picking their
inline `@mention` again preserves an existing explicit response request.
Typed names without a linked recipient require an acknowledgement before
posting them as plain text; email addresses are not treated as mentions.

After saving, the composer checks the caller's sent notifications for the exact
saved comment/message revision and shows the recipients actually notified.
Replies can notify the parent author without an explicit chip. An edit that
retains its recipients creates no new notification. A receipt verification
failure does not retry the write: the saved message remains saved, and only
verification is retried. A created notification proves neither delivery to an
external runtime nor that someone has started work.

Use explicit **Request response** actions. Posting a comment,
mentioning someone, editing text or loading a discussion never launches work.
A response request records the source comment/message and revision, requester,
recipient member IDs, state and timestamps. Recipients must be eligible to read
the source. Keep mention/read markers separate from a request that needs action.

Reply-to links keep the parent record ID. Replies must reference the same
task/project conversation and remain navigable after edits or soft deletion.
File/report references carry the record ID and revision that was discussed;
open the referenced report revision rather than silently substituting the newest body. Do not imply that file bytes have version
history: current file records use immutable objects and metadata revisions.

## One project discussion

The app provides one lightweight Discussion area per project for work that does not yet
belong to a task. It supports messages, replies, member mentions, file/report
references and explicit response requests to one member or a small group.
No channels, reactions, voice calls or Slack replacement are needed initially.

An authorized lead can **Create task from message**. The new task links back to
the source message/revision and the message links to the task. Preserve the
original discussion. Task creation uses the same typed command, validation,
actor/event transaction and retry protection as other writes. Creating a task
does not itself authorize execution or external sending.

## Personal needs-attention inbox

Each human and AI member gets the same inbox through UI and authenticated
RPC/MCP. Include explicitly eligible assigned work, response requests, review
requests, blockers and decisions addressed to that member. An ordinary mention
may be unread without constituting a response request.

Store attention items durably with their source reference and recipient, rather
than deriving unresolved work only from chat text. Reading an item clears its
unread marker, not the obligation. Open requests remain until answered or
explicitly dismissed/cancelled. Answering links the response/result; cancellation
and dismissal record the actor and reason. Define who may resolve each request
(recipient, requester or authorized lead) on the server. For group requests,
track each recipient independently and make the completion rule explicit.

The source remains authoritative for task status and review decisions. A
disabled/departed recipient leaves a visible unresolved item for reassignment;
it must not silently become completed. Reassignment cancels or reconciles the
old recipient's request, rather than creating overlapping invisible work.

## Optional runtime integration

Our preferred first integration is:

**Office event → local watcher → configured Hermes profile → reply/status in Office.**

Hermes is the first adapter, not a required runtime. The watcher maps stable
Office member IDs to configured runtime profiles outside the application. Keep
runtime conversations/execution in that runtime; visible work discussions,
requests, results and status remain in Office Office. Task text cannot select
arbitrary shell commands or replace the configured identity mapping.

Start with authenticated incremental polling and a reliable change cursor.
Only explicit response/dispatch requests are eligible for execution. Use durable
deduplication, atomic claims, attempt IDs, task/source revisions, heartbeats and
uncertain-run reconciliation before automatic execution. Repeated polls, event
delivery or ordinary comments must not start duplicate runs. A watcher credential
can route work only within its authorization; specialists reply using their own
member identities. Follow the full [dispatch contract](agent-dispatch.md).

An attention item, assignment or card move never grants permission to publish,
send, spend or change security settings. Those decisions stay separately gated.

## Delivery and acceptance

1. Structured task mentions, revision-specific references and explicit
   response-request commands with durable recipient state.
2. Personal attention lists, read/resolve actions and source navigation in
   UI/RPC/MCP. Verify that reading does not resolve a request.
3. Project discussion supports replies and linked task creation.
4. External operators can connect an optional local watcher with authenticated cursor polling and the
   dispatch reliability controls above.

Use katha events, kathputli commands and SQLite transactions for writes; do not
let the watcher bypass the engine. Server-derived identity and role checks apply
to messages, mentions, linked records, inboxes and actions. Project membership is
still future work: project filters alone do not establish client isolation.

Tests must prove stable-ID routing across renames, invalid/disabled recipient
handling, per-recipient unread versus unresolved state, edit/delete history,
revision-specific links, cross-project reference validation, authorized task
creation and replay after restart. UI and MCP must expose the same requests and
attribution. An ordinary comment/mention must produce no run; duplicate request
delivery must produce at most one claimed execution attempt. Runtime execution attempts, heartbeats and uncertain-start reconciliation remain the external dispatcher’s responsibility; the application records claims and results but does not prove a runtime has started.

## Report review

`RequestReportReview` names active reviewers and an exact current report revision.
Each reviewer receives a separate review request. `DecideReportReview` accepts
`approved` or `changes_requested` only from the designated reviewer, with optimistic
revision checks. Review is independent of draft/published editorial status.
Saving a newer report revision cancels pending reviews and their obsolete attention
items; historical approvals remain attached to the revision actually reviewed.
`GetReport` accepts `revision` to retrieve the retained body discussed or reviewed.

# Work conversations and needs attention

Status: partially implemented. Task comments, the notification board, personal
inboxes, explicit task-linked response requests and cursor-based watcher polling
are available in source. Inline structured mentions, replies, project discussion
and richer review/decision workflows remain follow-up work. See [notifications](notifications.md). Read with [tasks](tasks.md),
[agent access](agent-team-access.md) and [optional dispatch](agent-dispatch.md).

## Task conversations

Keep questions, progress, decisions, review and results attached to the task.
Mentions reference stable member IDs rather than interpreting display names as
identities. Select actual visible, active members from the team directory;
renaming someone must not reroute an old request. Preserve historical attribution
when a member is disabled. A plain-text `@name` is not an authenticated mention.

Add explicit **Request response** / **Ask [member]** actions. Posting a comment,
mentioning someone, editing text or loading a discussion never launches work.
A response request records the source comment/message and revision, requester,
recipient member IDs, state and timestamps. Recipients must be eligible to read
the source. Keep mention/read markers separate from a request that needs action.

Support reply-to links as discussions grow. Replies must reference the same
task/project conversation and remain navigable after edits or soft deletion.
File/report references carry the record ID and revision that was discussed;
show when a newer revision exists. Do not imply that file bytes have version
history: current file records use immutable objects and metadata revisions.

## One project discussion

Provide one lightweight Discussion area per project for work that does not yet
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

## First runtime integration

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

1. Add structured task mentions, revision-specific references and explicit
   response-request commands with durable recipient state.
2. Expose personal attention lists, read/resolve actions and source navigation in
   UI/RPC/MCP. Verify that reading does not resolve a request.
3. Add project discussion and linked task creation, then replies as needed.
4. Connect the optional local watcher with authenticated cursor polling and the
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
delivery must produce at most one claimed execution attempt. Do not claim this
workflow is shipped until these paths are implemented and verified.

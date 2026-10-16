# Katha persistence migration assessment

This records a compatibility experiment and the resulting internal journal
helper. It is not a deployed migration or a completed/published Katha backend. The hosted office and its Litestream replica
were not read, modified or reset. Fixture databases were created locally and
removed afterward.

## Result

Wrapping the current journal in a compatible rusqlite backend requires **no
event-row conversion and no database reset**. That is the smaller option and the
one prototyped here. The existing Katha SQLx store uses a different envelope and
table layout, but a mechanical import can preserve the same history and private
authentication state. Data loss is not intrinsically necessary in either case.

The deciding factor is the adapter's schema and transaction API, not whether its
driver is rusqlite or SQLx. A new Katha rusqlite backend using the standard SQLx
store's schema would still need an import of the existing Office journal.

| Route | Data work | Implementation work |
| --- | --- | --- |
| Schema-compatible Katha rusqlite backend | No row or table conversion | Extract the journal primitive; keep caller-owned transaction and app validation. Complete the reusable library contract before publishing. |
| Existing `katha-sqlx` store | Import old events into two Katha tables; retain all three private tables | Add caller-owned event-append transaction support, integrate async storage and adjust schema-coupled tests. |
| SQLx driver with the existing custom schema | No schema conversion | Port queries/connection lifecycle, but this alone does not reuse Katha's event-store implementation. Not the selected prototype. |

## Initial experiment and release integration

- Promoted the experiment to the internal `office-sqlite-journal` workspace
  crate. It is unpublished and excluded from independent cargo-release releases.
  Docker copies it into planner/build stages; workspace checks cover its tests.
- Moved event-table creation, ordered raw reads/validation and event inserts into
  that crate. The application still owns domain decoding, authentication tables,
  secure file ownership, process locking and WAL/FULL configuration.
- The application continues to own the transaction. Appended events, password/key
  snapshots and setup state commit together. The helper never commits on its own.
- `storage.rs` loses 52 lines and gains 19 integration lines. The actor, RPC/MCP,
  protobuf, UI and domain command behavior are unchanged.
- Cargo resolves the same rusqlite/SQLite driver as before; no SQLx driver was
  added. Only the internal journal package was added to the product lockfile.

This candidate is a low-level compatibility primitive over Katha `EventWrite`,
**not an implementation of the full Katha `EventStore` trait**. General stream
APIs, expected-version semantics, append notifications and storage of arbitrary
correlation/causation IDs and metadata still need a library design. The current
six-column journal cannot represent those optional envelope fields, and the
prototype rejects them rather than silently discarding them. Existing Office
writes do not populate them.

## Why `katha-sqlx` is not a drop-in replacement

Inspected the local Katha 0.2.6 source and cached 0.2.4 implementation. The store
owns its append transaction (`process_event` in `katha-sqlx/src/event_store.rs`).
It exposes `apply_projection_once_in_tx`, but that is for projection operations,
not atomic event append plus application-private authentication writes. Reusing
it safely needs an append transaction hook or equivalent callback. Sharing a pool
alone does not share a transaction. Append notifications must be emitted only
after the caller commits successfully.

The database shapes differ:

| Office journal | Katha SQLx mapping for a single `workspace` stream |
| --- | --- |
| `sequence` (1-based, global) | `version = sequence - 1` (per-stream, 0-based); retain original sequence in metadata |
| `event_id` | `id`, unchanged UUID |
| `event_type` | `name`, preserving the app's stable discriminator |
| `event_version = 1` | Retain as `legacy_event_version` in metadata |
| `occurred_at` | Convert **epoch seconds** to RFC3339 UTC `created_utc` |
| `payload` | `data`, preserving the exact JSON string |

Katha additionally needs `office_streams` and `office_events` (using a chosen store
name), stream ID/version bookkeeping, and nullable correlation/causation metadata.
Office's original Katha event names and optional envelope fields were not stored
by the old journal; do not claim an importer can recover values never saved.

`passwords`, `agent_secrets` and `private_config` can stay unchanged. In particular,
keep the signing key and bootstrap state to preserve existing JWTs, and preserve
key digests/revocations to retain AI authentication. Notification cursor and claim
state are inside event payloads; preserving their complete order is essential.

The application has three async storage boundaries (open, persist and close),
with blocking SQLite work isolated through `spawn_blocking`; a SQLx integration
would replace that blocking connection lifecycle. Six Rust files contain 20 SQL statement call sites
that need review; statements against retained private tables need not all change.
There are no required UI/RPC/domain changes for an adapter switch.

One dependency wrinkle: current rusqlite 0.37 uses `libsqlite3-sys` 0.35, while the
inspected SQLx 0.8.6/Katha SQLx workspace uses 0.30. A SQLx switch must remove or
align rusqlite, including the SQL-coupled test harness. Cargo cannot link both
incompatible native SQLite implementations into the same dependency graph.

A production importer should validate the old journal first, copy envelopes in
one transaction, verify counts/IDs/order/payloads/private state, then explicitly
advance its schema version. Old and new writers must not overlap. Retaining old
tables alone is not a safe rollback once SQLx-only writes start; an old binary
must not silently read a stale journal alongside newer credentials.

## Evidence from the experiment

The drill starts the preserved pre-change server, builds a populated fixture
office through RPC, stops it, and backs up its database to a local copy. The
prototype then opens that copy. It verified:

- **104 old events** preserved exactly, including UUIDs, timestamps, encoded
  payload strings and ordering; table definitions and `user_version` unchanged.
- Password hashes, agent-key digests/ownership, signing key and setup state
  unchanged after opening and reading.
- Existing human and AI JWTs still accepted; password login and raw key exchange
  still work; a previously revoked key remains rejected.
- Notification change history, saved cursor behavior and uncertain claimed work
  replay identically.
- New writes append through the prototype; the **old binary can reopen and read
  the result**. The original source fixture database remains unchanged.
- A separate SQLx-layout copy maps and reconstructs all 104 envelopes exactly
  using Katha's actual SQL migration DDL. Private tables are unchanged.

The SQLx check is a **schema/conversion dry run**, not a compiled SQLx application
integration or proof of the missing transaction hook. No importer is enabled at
application startup. The app uses the schema-compatible internal journal helper.

Validation: all 50 existing server tests, five prototype unit tests, and Clippy
with warnings denied passed. Unit tests cover journal compatibility, committed
appends, codec/auth-write rollback, stale sequence rejection, unsupported metadata
and corrupt journal rejection. All 46 isolated Chromium browser scenarios also passed with the prototype,
including durable login, team, project/task/comment/report/file/profile flows and
notification polling/replay. Frontend typechecking/build passed as part of that
run.

## Reproduce locally

Preserve a pre-change debug server binary before rebuilding the working tree.
Then build the current app and run:

```sh
cargo test -p office-server
cargo test --locked -p office-sqlite-journal
cargo clippy -p office-server --all-targets -- -D warnings
cargo build -p office-server
python3 crates/sqlite-journal/compatibility_drill.py \
  /tmp/office-journal-migration-check/legacy-office-server \
  target/debug/office-server \
  --sqlx-schema /home/kunjee/Workspace/manchhq/katha/katha-sqlx/migrations/0001_events.sql
```

Paths to the preserved binary and Katha checkout are local inputs, not deployment
requirements. The drill creates disposable local records, credentials and files;
it prints only assertions/counts, removes its temporary data, and requires local
TCP sockets. It does not read deployment credentials or connect to S3.

## Recommendation

Decide the Katha backend API before changing Office's on-disk format. For the
smallest adoption, preserve the current journal as a supported compatibility
layout and expose a caller-owned transaction API. The experiment shows that this
can retain the existing team and keys without a reset. If the goal is instead to
standardize on the existing SQLx store and its complete stream API, use a tested
one-time importer and the transaction hook; the data conversion is mechanical,
but the integration is more than swapping a driver dependency.

## Separate question: keeping accounts outside event sourcing

This assessment does **not** change account persistence. Password hashes, AI key
digests, signing key and bootstrap state already use private SQL tables. Member
records (including role, status and profile) and key metadata/revocation currently
come from `member` and `agent_key` events. They are not yet ordinary SQL records.
The user's latest direction is to assess migration first; separation is an option,
not a prerequisite for adopting either driver.

A local conversion dry run extracts the latest member/key record per stable ID
into two SQL snapshot tables on a disposable database copy. It checks profiles,
revoked keys, credential ownership, exact record equality, unchanged private
credentials and legacy history, SQLite integrity, and transaction rollback after
an injected failure. Those snapshot tables deliberately store JSON for this
experiment; they are not a proposed finished authentication schema. No startup
migration or post-cutover account writer is implemented by this experiment.

The smallest production separation would:

1. Validate the complete legacy state and references before conversion. Copy the
   latest account records into ordinary SQL tables with appropriate constraints.
2. Preserve member/key IDs, password hashes, digests, signing key and setup state.
   Tasks, comments, reports, files and notifications continue referencing the
   same identities. Disabling a member must retain historical attribution.
3. Atomically advance the schema version. Load SQL account state as authoritative
   after business-event replay; legacy account events must never overwrite it.
4. Route bootstrap, member/profile changes, file-deletion avatar cleanup and key
   creation/rotation/revocation to SQL-backed account updates. Keep those writes,
   any related business events, and credential changes in the same transaction.
   Preserve existing actor rollback and live authorization checks.
5. Keep account administration audit records, without using them to rebuild
   accounts. Update fixtures and replay tests that currently expect member events.
   Add restart, disabled-member, rotation and failed-commit tests for the cutover.

Retaining legacy account events as read-only history avoids rewriting event
sequences and notification cursors. It does **not** remove historical profile
payloads from the database or its backups. Purging those payloads is a separate
migration with more validation and retention considerations. A schema version
bump must make older binaries refuse the converted database: they cannot safely
see future SQL-only member changes by replaying the old history.

This is bounded cross-layer work: storage/loading, actor persistence and rollback,
account command paths, avatar cleanup, tests and relevant documentation. It needs
no new browser or RPC contract. It is more than changing the adapter dependency,
but there is no identified need to reset the office or recreate its team.

Katha stream IDs provide event scoping; that is separate from choosing where
authentication accounts are authoritative. In the inspected local Katha core
and SQLx source, no dedicated user/tenant account model was found. Custom event
metadata or stream naming can associate business events with a user/tenant
without requiring authentication state to be event-sourced. Any support in a
different Katha version remains to be checked before relying on it.

Recommendation: treat account separation and backend selection as independent
decisions. Prefer ordinary SQL accounts if making this boundary change, but do
not rebuild the event journal just to accomplish it. Until a tested cutover is
implemented, existing event-sourced member metadata remains the source of truth.

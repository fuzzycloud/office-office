# Office SQLite journal

This small crate demonstrates compatibility between Katha `EventWrite` values and Office Office's existing six-column SQLite `events` table. It preserves event IDs and encoded payload strings, writes event version 1, and lets the caller own the SQLite transaction so private authentication writes can share the same commit boundary.

This is a low-level compatibility primitive, not a complete Katha `EventStore` implementation. The schema cannot represent correlation IDs, causation IDs, or any metadata, so the append helper rejects those values. It does not provide multistream APIs, notifier publishing, connection ownership, or production storage lifecycle behavior. Those pieces remain pending.


This is an internal, unpublished workspace crate. Katha supplies event behavior;
this helper stores its writes with rusqlite without requiring Katha's supplied
drivers. Office Office owns connection lifecycle, domain validation and private
authentication tables. Its existing database format is unchanged.

See [ASSESSMENT.md](ASSESSMENT.md) for the comparison with katha-sqlx, possible
migration mapping, disposable compatibility drill and verification results.
Run `cargo test -p office-sqlite-journal` for the journal tests. Workspace CI
includes those tests; this crate has no independent release or publication.

# Storage and recovery

Normal startup opens `data/office-office.sqlite3` (override with `OFFICE_DATABASE_PATH`). A new office has no customer, project, task or social sample records. Bootstrap the first administrator once, then add records through the UI or MCP.

`OFFICE_DEMO_MODE=true` selects temporary in-memory storage and preselects sample data on the first-admin screen. The `load_demo_data` registration option controls whether the starter scenario runs. The same scenario can populate a normal SQLite office, where samples survive restart. It creates ordinary records through engine commands and events, not SQL seed inserts. Earlier in-memory prototype records cannot be migrated because they were never saved. The browser smoke test explicitly uses temporary storage and opts into the scenario.

## Commit and replay

Katha handles domain events and projection updates; a kathputli actor serializes commands. The SQLite adapter appends a versioned event batch and updates private authentication tables in the same transaction. Bootstrap and a project with its initial board each form one atomic command. The server acknowledges a mutation only after SQLite commits. Failed writes restore the previous projection and credentials.

SQLite uses WAL and `synchronous=FULL`. There is one application writer, guarded by a process lock. Do not run multiple application instances against one database, use a network filesystem, edit tables directly, or delete lock files to bypass the running process. Application projections are rebuilt by replay before HTTP starts; unsupported schemas, unknown events or damaged records cause startup to fail instead of opening first-admin setup.

Public events contain office records and activity, not password hashes, raw AI keys or signing material. Private tables contain Argon2 password hashes, AI-key digests and owner IDs, and the JWT signing key. Restoring the whole database restores these credentials too. Valid unexpired sessions continue across restarts. AI-key expiry, revocation and current owner permissions still apply.

## Protect the database

The database is sensitive: its events contain office/customer data and its private tables contain authentication material. Newly created application storage uses owner-only permissions. Use an encrypted disk/volume and encrypted backups with restricted access. SQLite itself is not encrypted by this implementation. There are no provider secrets or provider-secret encryption keys yet.

For containers, mount a persistent volume at `/data` writable by UID/GID 10001. The image sets `OFFICE_DATABASE_PATH=/data/office-office.sqlite3`. Use a Docker-managed named volume so data survives container replacement and image upgrades. Replacing a container without persistent storage loses its office. Keep setup behind a private ingress; anyone who reaches an empty office first could claim administrator access.

An append-only event log retains old record values. A retention/export/erasure workflow is still needed before production customer data. There is no application-level purge of historical events or uploaded file bytes. Optional Litestream retention manages database replicas separately.

## Optional Litestream replication

[deploy/litestream.yml](../deploy/litestream.yml) is the default Litestream 0.5.17 configuration. The container bundles that pinned version, but does not start replication by default. Litestream supervises `office-server` in the same container when enabled; do not run a second application writer or a separate Litestream process against the same database. The runtime has passed a local file-replica restore drill, including office replay, password login, AI-key authentication and SQLite integrity. An isolated S3-compatible bucket drill also passed: the bundled runtime uploaded a replica, restored into a fresh Docker volume and passed SQLite integrity/content checks. This does not mean a hosted office has been migrated or its ongoing backup health is monitored. See the upstream [S3 guide](https://litestream.io/guides/s3/) and [configuration reference](https://litestream.io/reference/config/).

For an existing office, preserve its database before enabling replication. On the first container using a new persistent volume, stop the old service and make a consistent SQLite backup (including WAL state through SQLite's backup mechanism), then place that database in the new volume. Never start an empty replacement and let it claim the existing office's identity.

The default config is `/etc/office-office/litestream.yml`; set `OFFICE_LITESTREAM_CONFIG` to override it. Enable with `OFFICE_LITESTREAM_ENABLED=true`, then provide absolute `OFFICE_DATABASE_PATH`, `OFFICE_BACKUP_BUCKET`, a unique `OFFICE_BACKUP_PREFIX`, and `AWS_REGION`. Credentials can come from private `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` environment variables or the AWS SDK credential chain; optional `AWS_SESSION_TOKEN` supports temporary credentials. `AWS_ENDPOINT_URL_S3` is available for a custom S3-compatible endpoint. Keep credentials out of source control and logs. Copy [the secret-free environment example](../deploy/litestream.env.example) to `.env.litestream` as a starting point.

When enabled, startup uses an existing database as-is and does not restore over it. If the database is missing, Litestream restores to a temporary file; startup checks SQLite integrity before atomically promoting the file. Network, authorization, restore, corruption, or integrity errors stop startup rather than creating an empty office. If no backup exists, a fresh database is allowed only when `OFFICE_ALLOW_NEW_DATABASE=true` is explicitly set for first boot; remove that flag after initialization. Do not enable it for routine restarts. Demo in-memory mode cannot be backed up and must not be combined with Litestream.

The template syncs every five minutes, takes a snapshot every 24 hours, and retains 168 hours (seven days). This favors lower background traffic for a non-critical office; changes since the last successful sync can be lost if local storage disappears. An outage can extend that interval. Retention is a recovery window, not a deletion guarantee for event data. Litestream replication is asynchronous backup, not high availability or a second application writer. A successful local commit does not mean the transaction has reached S3. Configure bucket encryption, access controls and lifecycle separately. Keep database replicas under a dedicated backup prefix; never apply a seven-day bucket-wide expiry to uploaded files. Litestream manages its recovery window; a bucket rule that deletes objects solely by age can remove data needed by a retained snapshot. On shutdown allow 60 seconds so Litestream can stop the child and finish its final sync; keep one application writer. Monitor replication health and practice restoration before relying on backups.

## Restore drill

1. Stop the application and replication processes. Preserve the existing volume and all SQLite sidecars.
2. Restore to a separate, nonexistent path; do not overwrite the active database. With the template environment exported:

   ```sh
   litestream restore -config deploy/litestream.yml -o /safe/recovery/office.sqlite3 "$OFFICE_DATABASE_PATH"
   ```

3. Run SQLite `PRAGMA integrity_check` on the restored copy. Start an isolated application using its path and loopback binding; startup validates and replays the event log. Check login, records and key revocation using that copy.
4. Only after verification, stop the isolated service and explicitly promote the recovered database while the original application remains stopped. Preserve the former volume for rollback and restart replication against the chosen database.

Do not use `-force`, treat a missing backup as an empty office, or automatically fall back to bootstrap on restore failure. Restore can roll back recent password changes or key revocations: treat a recovery as a security event and review credentials. See the upstream [restore reference](https://litestream.io/reference/restore/).

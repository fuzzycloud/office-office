# Storage and recovery

Normal startup opens `data/office-office.sqlite3` (override with `OFFICE_DATABASE_PATH`). A new office has no customer, project, task or social sample records. Bootstrap the first administrator once, then add records through the UI or MCP.

`OFFICE_DEMO_MODE=true` selects temporary in-memory storage and preselects sample data on the first-admin screen. The `load_demo_data` registration option controls whether the starter scenario runs. The same scenario can populate a normal SQLite office, where samples survive restart. It creates ordinary records through engine commands and events, not SQL seed inserts. Earlier in-memory prototype records cannot be migrated because they were never saved. The browser smoke test explicitly uses temporary storage and opts into the scenario.

## Commit and replay

Katha handles domain events and projection updates; a kathputli actor serializes commands. The SQLite adapter appends a versioned event batch and updates private authentication tables in the same transaction. Bootstrap and a project with its initial board each form one atomic command. The server acknowledges a mutation only after SQLite commits. Failed writes restore the previous projection and credentials.

SQLite uses WAL and `synchronous=FULL`. There is one application writer, guarded by a process lock. Do not run multiple application instances against one database, use a network filesystem, edit tables directly, or delete lock files to bypass the running process. Application projections are rebuilt by replay before HTTP starts; unsupported schemas, unknown events or damaged records cause startup to fail instead of opening first-admin setup.

Public events contain office records and activity, not password hashes, raw AI keys or signing material. Private tables contain Argon2 password hashes, AI-key digests and owner IDs, and the JWT signing key. Restoring the whole database restores these credentials too. Valid unexpired sessions continue across restarts. AI-key expiry, revocation and current owner permissions still apply.

## Protect the database

The database is sensitive: its events contain office/customer data and its private tables contain authentication material. Newly created application storage uses owner-only permissions. Use an encrypted disk/volume and encrypted backups with restricted access. SQLite itself is not encrypted by this implementation. There are no provider secrets or provider-secret encryption keys yet.

For containers, mount a persistent volume at `/data` writable by UID/GID 10001. The image sets `OFFICE_DATABASE_PATH=/data/office-office.sqlite3`. Replacing a container without a volume loses its database. Keep setup behind a private ingress; anyone who reaches an empty office first could claim administrator access.

An append-only event log retains old record values. A retention/export/erasure workflow is still needed before production customer data. There is no automatic purge of events or backups.

## Optional Litestream replication

[deploy/litestream.yml](../deploy/litestream.yml) is an operator template for Litestream 0.5+, using its current single-`replica` configuration. Install Litestream separately; it is not bundled or launched in the application image. The template and AWS upload/restore have not been exercised against a live bucket. See the upstream [S3 guide](https://litestream.io/guides/s3/) and [configuration reference](https://litestream.io/reference/config/).

Export an absolute `OFFICE_DATABASE_PATH`, `OFFICE_BACKUP_BUCKET`, a unique `OFFICE_BACKUP_PREFIX`, and `AWS_REGION`. Give Litestream AWS workload credentials or the usual AWS credential environment variables; never commit them. Run it with access to the same persistent volume and file owner as the application:

```sh
litestream replicate -config deploy/litestream.yml
```

Replication is asynchronous backup, not high availability or a second application writer. Monitor replication health and test restoration. A successful local database commit does not mean the transaction has already reached S3. Configure bucket encryption, access controls and retention separately.

## Restore drill

1. Stop the application and replication processes. Preserve the existing volume and all SQLite sidecars.
2. Restore to a separate, nonexistent path; do not overwrite the active database. With the template environment exported:

   ```sh
   litestream restore -config deploy/litestream.yml -o /safe/recovery/office.sqlite3 "$OFFICE_DATABASE_PATH"
   ```

3. Run SQLite `PRAGMA integrity_check` on the restored copy. Start an isolated application using its path and loopback binding; startup validates and replays the event log. Check login, records and key revocation using that copy.
4. Only after verification, stop the isolated service and explicitly promote the recovered database while the original application remains stopped. Preserve the former volume for rollback and restart replication against the chosen database.

Do not use `-force`, treat a missing backup as an empty office, or automatically fall back to bootstrap on restore failure. Restore can roll back recent password changes or key revocations: treat a recovery as a security event and review credentials. See the upstream [restore reference](https://litestream.io/reference/restore/).

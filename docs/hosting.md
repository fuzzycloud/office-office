# Hosting

## Current development build

The application now persists events and authentication in SQLite. Normal startup uses `data/office-office.sqlite3`, configurable with `OFFICE_DATABASE_PATH`, and begins with no sample records. First-admin setup runs once; restarting replays the journal and restores accounts, records, AI-key digests and the JWT signing key.

This is not yet a publicly deployed or production-reviewed service. Keep setup on loopback or behind a private ingress. The first visitor to an empty office can claim administrator access. HTTPS, request throttling, password recovery, privacy retention/erasure and a verified operational backup path remain necessary before public customer use.

`OFFICE_DEMO_MODE=true` selects in-memory storage that resets on restart and preselects the optional sample-data checkbox during first-admin registration. Sample records are created by the engine scenario only after opt-in; the same option can populate a persistent SQLite office. Storage mode is independent of `OFFICE_ALLOW_REMOTE=true`, the acknowledgement required for a non-loopback `ADDR`. Neither flag grants permissions or supplies a production security boundary.

## One persistent application instance

The hosted shape is one application writer and one SQLite volume. Katha handles domain events and rebuildable projections; kathputli serializes commands. SQLite uses WAL with FULL synchronous commits. A process lock rejects another application writer. Do not use a shared network filesystem or run several application instances against the same file.

The image sets `ADDR=0.0.0.0:8080`, `OFFICE_ALLOW_REMOTE=true` and `OFFICE_DATABASE_PATH=/data/office-office.sqlite3`. It runs as UID/GID 10001. Mount a persistent volume at `/data`, owned by that identity and restricted to mode 0700. Replacing a container without persistent storage discards its office. No Kamal deployment is configured.

The database includes private authentication tables and a signing key. Protect the volume with encryption and restricted access. Provider credentials are not implemented. [Storage and recovery](storage.md) covers transaction guarantees, event retention and recovery.

## Offsite backup

[deploy/litestream.yml](../deploy/litestream.yml) is an optional operator template for Litestream 0.5+ S3 replication. The binary is not bundled or launched by this image, and live AWS upload/restore has not been tested. Run a separately managed process with access to the database volume and AWS workload credentials. Set its bucket, prefix and region through environment variables. Monitor replication and exercise the documented restore drill before relying on it.

Litestream protects recovery; it is not active-active availability. Restore to a separate path, validate SQLite and application replay before promotion, and never silently replace an existing database or fall back to first-admin setup after a restore error. Database backups include signing material and password/key hashes. Restoring an earlier backup can undo revocations and password changes.

## Image publication

GitHub Actions builds and publishes `ghcr.io/fuzzycloud/office-office` after checks, using `GITHUB_TOKEN` and `packages: write`. The workflow publishes images; it does not deploy a server or configure backup credentials. See [release management](releases.md).

Organization settings must allow GitHub Packages and package creation; an existing package must grant this repository workflow access. Set the package's visibility to Public explicitly if anonymous pulls are intended. A public source repository does not automatically make the container public. See [GitHub's container registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

Use a `sha-<full-commit>` tag or image digest for reproducible deployment. Docker Hub publishing is not configured; it can later use repository secrets `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`. Runtime database and AWS secrets do not belong in image-publication CI.

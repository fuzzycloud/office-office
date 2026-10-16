# Hosting

## Current development build

The application now persists events and authentication in SQLite. Normal startup uses `data/office-office.sqlite3`, configurable with `OFFICE_DATABASE_PATH`, and begins with no sample records. First-admin setup runs once; restarting replays the journal and restores accounts, records, AI-key digests and the JWT signing key.

This repository publishes a development preview, not a production-reviewed service; operator deployments are configured separately. Keep setup on loopback or behind a private ingress. The first visitor to an empty office can claim administrator access. HTTPS, request throttling, password recovery, privacy retention/erasure and a verified operational backup path remain necessary before public customer use.

`OFFICE_DEMO_MODE=true` selects in-memory storage that resets on restart and preselects the optional sample-data checkbox during first-admin registration. Sample records are created by the engine scenario only after opt-in; the same option can populate a persistent SQLite office. Storage mode is independent of `OFFICE_ALLOW_REMOTE=true`, the acknowledgement required for a non-loopback `ADDR`. Neither flag grants permissions or supplies a production security boundary.

## One persistent application instance

The hosted shape is one application writer and one SQLite volume. Katha handles domain events and rebuildable projections; kathputli serializes commands. SQLite uses WAL with FULL synchronous commits. A process lock rejects another application writer. Do not use a shared network filesystem or run several application instances against the same file.

The image sets `ADDR=0.0.0.0:8080`, `OFFICE_ALLOW_REMOTE=true` and `OFFICE_DATABASE_PATH=/data/office-office.sqlite3`. It runs as UID/GID 10001. Mount a Docker-managed named volume at `/data`, owned by that identity and restricted to mode 0700. Preserve the volume across releases. Before replacing an existing hosted office, stop it and copy its consistent SQLite database into the volume; never let a new empty database initialize in place of the existing office. Operator-specific deployment configuration is intentionally kept outside this repository.

The database includes private authentication tables and a signing key. Protect the volume with encryption and restricted access. Provider credentials are not implemented. [Storage and recovery](storage.md) covers transaction guarantees, event retention and recovery.

## Offsite backup

[deploy/litestream.yml](../deploy/litestream.yml) configures the pinned Litestream 0.5.17 bundled in the image. It remains disabled by default. Set `OFFICE_LITESTREAM_ENABLED=true` and supply `OFFICE_BACKUP_BUCKET`, `OFFICE_BACKUP_PREFIX`, and `AWS_REGION` to opt in. Provide credentials through a private environment file or the AWS SDK credential chain; never put credentials in the image or repository. See [storage and recovery](storage.md) for all options and restore behavior. An isolated S3-compatible bucket upload/restore drill has passed; activation and verification for each hosted office remain operator responsibilities.

When enabled, Litestream runs as supervisor for the application in the same container. Keep one application writer and set Docker `--stop-timeout 60` to allow final sync. On a missing database, startup restores to a temporary file and validates integrity before promotion; any restore failure stops startup. An empty first boot requires the explicit `OFFICE_ALLOW_NEW_DATABASE=true` flag, which should be removed after initialization. Existing databases are never overwritten by restore. Litestream protects recovery; it is not active-active availability. Database backups include signing material and password/key hashes. Restoring an earlier backup can undo revocations and password changes.

## Image publication

GitHub Actions builds and publishes `ghcr.io/fuzzycloud/office-office` after checks, using `GITHUB_TOKEN` and `packages: write`. The workflow publishes images; it does not deploy a server or configure backup credentials. See [release management](releases.md).

Organization settings must allow GitHub Packages and package creation; an existing package must grant this repository workflow access. Set the package's visibility to Public explicitly if anonymous pulls are intended. A public source repository does not automatically make the container public. See [GitHub's container registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

Use a `sha-<full-commit>` tag or image digest for reproducible deployment. Docker Hub publishing is not configured; it can later use repository secrets `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`. Runtime database and AWS secrets do not belong in image-publication CI.

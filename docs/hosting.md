# Hosting

## Current preview

The GHCR `edge` image is a preview of the UI-first demo. The application keeps users, roles, settings and records in memory; they reset when the process restarts. It is not ready for public authentication or real customer data. Keep local runs on loopback and do not place it behind a public ingress.

The demo starts without token, password or provider-secret environment variables. The first screen collects workspace and administrator credentials. The server creates an Argon2 password hash and issues short-lived JWTs using a random key held only for the process lifetime. Restarting clears the workspace and sessions.

The demo's sample customers, projects and social channels come from backend RPC seed behavior. They are fictitious, visibly labeled, reset on restart, and never trigger invitations or external publishing. No database, durable key storage, social OAuth or backup service is implemented.

GitHub Actions builds and publishes `ghcr.io/fuzzycloud/office-office` after the configured checks. The workflow publishes images; it does not deploy a server. Image publication is not evidence of a production-ready service. See [release management](releases.md).

## Future durable hosting

The planned persistence model uses one SQLite database in WAL mode with a single writer. Katha will hold the event core and kathputli will serialize commands. Litestream is planned for offsite backup, not active-active availability. The deployment must restore and validate a backup before serving traffic and must never replace an existing database during bootstrap.

Durable authentication and application configuration key material need protected backup and recovery. Provider secrets will be encrypted server-side, with a separate recovery secret for decryption. Deployment credentials, including AWS environment or identity credentials, do not replace that application recovery material. Do not invent environment passwords or tokens for the current demo.

Before opening a public service, implement and review durable identity, key recovery, audit history, authorization, backup restore and social publishing safety. Provider connections and publishing must be scoped and audited. Never forward provider secrets to agents.

## Image publication

The GitHub Actions workflow uses the workflow `GITHUB_TOKEN` and `packages: write` permission. It builds an image; there is no server deployment or Kamal job. Organization settings must permit GitHub Packages and package creation. If the package already exists, grant the repository workflow access. After the first publish, set package visibility to Public only if anonymous pulls are intended. A public source repository does not automatically make its container package public. See [GitHub's container registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

For reproducible image inspection, use a `sha-<full-commit>` tag or image digest. Do not treat any published tag as authorization to expose the current demo publicly.

## Optional Docker Hub publishing

Docker Hub publishing is not configured. If it is added later, configure repository Actions secrets named `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`, scoped to publishing the selected repository. Never put runtime office passwords, JWT keys or provider credentials in CI secrets for image publication.

The preview image explicitly sets `OFFICE_DEMO_MODE=true` to permit container networking. A direct binary defaults to loopback and rejects a non-loopback `ADDR` unless that flag is explicitly enabled. This is a demo acknowledgement, not a production mode or an authentication boundary.

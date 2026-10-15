# Hosting the starter

Build locally with `docker build -t office-office .`:

```sh
docker run --rm -p 127.0.0.1:8080:8080 \
  -e OFFICE_HUMAN_TOKEN -e OFFICE_AGENT_TOKEN \
  -v office-office-data:/data office-office
```

Export two independent random secrets before running. Put an HTTPS reverse proxy in front of the loopback port. `/healthz` is the health route. The same server serves React and RPC, so cross-origin access is unnecessary.

The image is a single-instance bootstrap. Keep a persistent volume; otherwise records disappear with the container. Back up the data file while writes are quiescent and test recovery. No cloud credentials or real customer data belong in the repository.

Do not horizontally scale file persistence. Before opening a multi-user service, implement individual accounts, workspace isolation, audit events and revision-safe writes with PostgreSQL. The application does not yet implement those capabilities.

## GitHub image publishing

The GitHub Actions workflow checks the code and publishes `ghcr.io/fuzzycloud/office-office` on pushes to `main`, version tags, and manual dispatch. It builds an image only; there is no server deployment or Kamal job. Release tags and image tags are described in [release management](releases.md).

GHCR authentication uses the workflow's `GITHUB_TOKEN` and `packages: write` permission. No additional GHCR secret is needed. For the first publication, confirm that repository Actions are enabled and permitted to run the workflow's referenced actions. The organization must allow GitHub Packages and package creation. If the package already exists, grant the repository's Actions workflow access to it. After the first successful publish, set package visibility to Public if anonymous pulls are intended; a public source repository does not make its container package public automatically. See [GitHub's container registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

Pull a published image with:

```sh
docker pull ghcr.io/fuzzycloud/office-office:latest
```

For reproducible deployments, use the `sha-<full-commit>` tag or an image digest. Supply the two runtime credentials and persistent volume as shown above.

## Optional Docker Hub publishing

Docker Hub publishing is not configured. If it is added later, configure repository Actions secrets named `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`. The username should own or have publish access to the intended Docker Hub namespace, and the token should be a Docker Hub access token with the permissions needed to push. The image workflow should log in to Docker Hub using those secrets and publish an explicitly chosen namespace and repository. Never place runtime office tokens or provider credentials in CI secrets for image publication.

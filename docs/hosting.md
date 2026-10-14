# Hosting the starter

Build: `docker build -t office-office .`

```sh
docker run --rm -p 127.0.0.1:8080:8080 \
  -e OFFICE_HUMAN_TOKEN -e OFFICE_AGENT_TOKEN \
  -v office-office-data:/data office-office
```

Export two independent random secrets before running. Put an HTTPS reverse proxy in front of the loopback port. `/healthz` is the health route. The same server serves React and RPC, so cross-origin access is unnecessary.

The image is a single-instance bootstrap. Keep a persistent volume; otherwise records disappear with the container. Back up the data file while writes are quiescent and test recovery. No cloud credentials or real customer data belong in the repository.

Do not horizontally scale file persistence. Before opening a multi-user service, implement individual accounts, workspace isolation, audit events and revision-safe writes with PostgreSQL. The application does not yet implement those capabilities.

## Public image

GitHub Actions checks the code, builds with cargo-chef and pushes to `ghcr.io/fuzzycloud/office-office` on main, version tags or manual dispatch. After first publication, set the GHCR package visibility to public; a public source repository does not automatically make its image public. No SSH deployment runs in CI. Kamal is deferred.

Pull with `docker pull ghcr.io/fuzzycloud/office-office:latest`, then run it using the same credentials and volume options above. For a reproducible deployment, select the `sha-<full-commit>` tag or image digest instead of latest.

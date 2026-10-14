# Office Office

A shared daily office board for humans and AI: targets, strategy, projects, pricing history and progress in one place.

Inspired by [Office Office](https://en.wikipedia.org/wiki/Office_Office), the Hindi sitcom starring Pankaj Kapur as Musaddilal. A small tribute to the endless journey of a file between desks. Here, we would like the file to actually move. Independent open-source software; not affiliated with the show or its creators.

## What this project does

- Track targets and progress.
- Keep strategy notes beside the projects they guide.
- Keep active, on-hold and archived projects visible.
- Preserve dated pricing history.
- Give humans a UI and AI a read/write API over the same board.

Hermes continues to run agents and handle communication channels. Future Zoho and other business connectors will expose read-only context by default, with explicitly enabled actions such as sending an invoice. This starter does not connect to external systems yet.

## Status

Initial working scaffold, not a production SaaS. Rust + Axum + ConnectRPC server, React + Vite UI, generated TypeScript client and file persistence. One office, one server instance; shared tokens and whole-board writes are temporary bootstrap choices. See [architecture and next steps](docs/architecture.md).

## Run locally

Prerequisites: Rust with edition 2024 support, Node 24, pnpm 11, Buf CLI, and protobuf compiler (`protoc`) if required by the Rust code generator.

```sh
pnpm install
just generate
export OFFICE_HUMAN_TOKEN="$(openssl rand -hex 32)"
export OFFICE_AGENT_TOKEN="$(openssl rand -hex 32)"
just server
```

In another terminal run `just web`, then open the Vite URL. Enter your human token in the UI. The browser calls `/rpc` through the Vite proxy to port 8080. Use the agent token for agent access; it can also update the board.

For a built UI, run `just build`, then start `target/release/office-server` from the repository root. Open http://127.0.0.1:8080. Data lives in `data/board.json` by default. Back it up; do not commit it.

## AI access

Agents can use ConnectRPC's JSON HTTP interface directly:

```sh
curl http://127.0.0.1:8080/rpc/office.v1.OfficeService/GetBoard \
  -H "Authorization: Bearer $OFFICE_AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

`SaveBoard` accepts either configured credential. Agents and humans can update the same board. MCP and CLI adapters are planned, not implemented.

## Development

`just check` runs Rust formatting, Clippy, tests, frontend checking and the production UI build. `just generate` lints protobuf and regenerates the TypeScript client. Dependencies follow the current pi_dx reference where applicable.

## Hosting

Build with `docker build -t office-office .`. Supply two distinct credentials at runtime, mount `/data` as a persistent volume, and terminate HTTPS at your ingress. See [hosting](docs/hosting.md). GitHub Actions publishes `ghcr.io/fuzzycloud/office-office` after checks pass. Set the package visibility to public after its first publication. Server deployment and Kamal are deferred.

## Roadmap

1. Typed per-record RPCs, revisions and PostgreSQL persistence.
2. Individual human accounts, agent identities, workspace permissions and audit history.
3. Zoho imports with provenance, freshness and field allowlists; narrowly permitted invoice actions.
4. MCP read/write tools for office context, targets, project history and pricing.
5. Planning discussions and human-reviewed agent contributions.

## GitHub

See [first push instructions](docs/github.md) for the configured repository and image publishing path.

## License

MIT OR Apache-2.0. See LICENSE-MIT and LICENSE-APACHE.

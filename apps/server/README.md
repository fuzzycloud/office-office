# Office board server

This service exposes `office.v1.OfficeService` under `/rpc` over ConnectRPC. `GetBoard` and
`SaveBoard` exchange the frontend domain model as a JSON string in the protobuf
messages during this initial spike. The board contains the `targets`,
`projects`, `strategies`, `prices`, `updates`, and `connectors` arrays. A later
storage step can move this persistence layer to Postgres without changing that
frontend payload contract.

Run from the repository root with:

```sh
OFFICE_HUMAN_TOKEN=human-secret OFFICE_AGENT_TOKEN=agent-secret cargo run -p office-server
```

The human and agent bearer tokens must both be set and must differ. Both roles
may read and save the board. Connector entries must use `mode: "read_only"`;
scoped bill-send permissions are not implemented. The server binds to
`127.0.0.1:8080` by default; set `ADDR` to change the bind address. JSON state
is stored at `data/board.json` by default; set `OFFICE_DATA_PATH` to change it.
`/healthz` is an unauthenticated liveness endpoint. When `apps/web/dist` exists,
the server serves it as the frontend and uses its index page for client-side
routes. The server exits gracefully on Ctrl-C or SIGTERM.

# syntax=docker/dockerfile:1
FROM litestream/litestream:0.5.17@sha256:4b02b9859a6b6b4087d8b8944e15f7e984bd7957cba322bbeee38b0e27b9656a AS litestream

FROM node:24-bookworm-slim AS web
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile
COPY apps/web apps/web
RUN pnpm build

FROM rust:1.98-bookworm AS chef
ENV CARGO_BUILD_JOBS=2
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends protobuf-compiler && rm -rf /var/lib/apt/lists/*
RUN cargo install cargo-chef --version 0.1.78 --locked

FROM chef AS planner
COPY Cargo.toml Cargo.lock ./
COPY apps/server apps/server
COPY proto proto
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS builder
COPY --from=planner /src/recipe.json recipe.json
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    cargo chef cook --release --locked -p office-server --recipe-path recipe.json
COPY Cargo.toml Cargo.lock ./
COPY apps/server apps/server
COPY proto proto
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    cargo build --locked --release -p office-server

# Testable runtime layer; application builds still use cargo-chef above.
FROM debian:bookworm-slim AS runtime-base
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl sqlite3 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 office \
    && useradd --uid 10001 --gid office --no-create-home office \
    && mkdir /data && chown office:office /data && chmod 700 /data
WORKDIR /app
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY --chmod=755 deploy/entrypoint.sh /usr/local/bin/office-entrypoint
COPY deploy/litestream.yml /etc/office-office/litestream.yml
ENV ADDR=0.0.0.0:8080 OFFICE_ALLOW_REMOTE=true OFFICE_DATABASE_PATH=/data/office-office.sqlite3 OFFICE_LITESTREAM_ENABLED=false
USER office
EXPOSE 8080
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/office-entrypoint"]

FROM runtime-base AS runtime
COPY --from=builder /src/target/release/office-server /usr/local/bin/office-server
COPY --from=web /src/apps/web/dist /app/apps/web/dist
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl --fail --silent --show-error --max-time 3 http://127.0.0.1:8080/healthz || exit 1
CMD ["office-server"]

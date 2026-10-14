# syntax=docker/dockerfile:1
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

FROM debian:bookworm-slim
RUN groupadd --gid 10001 office && useradd --uid 10001 --gid office --no-create-home office && mkdir /data && chown office:office /data
WORKDIR /app
COPY --from=builder /src/target/release/office-server /usr/local/bin/office-server
COPY --from=web /src/apps/web/dist /app/apps/web/dist
ENV ADDR=0.0.0.0:8080 OFFICE_DATA_PATH=/data/board.json
USER office
EXPOSE 8080
CMD ["office-server"]

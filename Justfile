set shell := ["sh", "-eu", "-c"]

default:
    @just --list

install:
    pnpm install

generate:
    buf lint
    pnpm generate

server:
    cargo run -p office-server

web:
    pnpm dev

check:
    python3 scripts/check-versions.py
    cargo fmt --all -- --check
    cargo clippy -p office-server --all-targets -- -D warnings
    cargo test -p office-server
    pnpm check
    pnpm build

build:
    pnpm build
    cargo build -p office-server --release

# Install the pinned release tool; this does not release the application.
release-install:
    cargo install cargo-release --version 1.1.2 --locked

release-check:
    python3 scripts/check-versions.py

# cargo-release is a dry run unless --execute is supplied.
release-plan level="patch": release-check
    cargo release --workspace {{quote(level)}}

# Requires a clean main checkout; cargo-release asks before committing/tagging/pushing.
release level="patch": check
    cargo release --workspace {{quote(level)}} --execute

# Builds the UI/server once, then gives every browser test its own process and database.
test-e2e:
    pnpm test:e2e

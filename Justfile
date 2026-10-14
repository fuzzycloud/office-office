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
    cargo fmt --all -- --check
    cargo clippy -p office-server --all-targets -- -D warnings
    cargo test -p office-server
    pnpm check
    pnpm build

build:
    pnpm build
    cargo build -p office-server --release

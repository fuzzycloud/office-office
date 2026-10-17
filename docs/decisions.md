---
governs:
  paths: []
  shapes: [decisions]
  verify: source
---

# Decisions

## 2026-10-17 — Keep unreleased implementation plans local

- **Context:** The user established this repository as public and requested implementation of the open backlog on one branch. Plans describe unreleased work.
- **Decision:** Ignore `docs/superpowers/`; public product and architecture documentation remain tracked. Source: `.gitignore`.
- **Rejected:** Publishing local implementation scratch plans.

## 2026-10-17 — Preserve the existing SQLite journal adapter

- **Context:** Katha replay and actor transactions already use rusqlite; the user explicitly accepted that driver after comparing SQLx migration options.
- **Decision:** Keep the schema-compatible `office-sqlite-journal` crate and caller-owned transaction. Source: `crates/sqlite-journal`, `apps/server/src/storage.rs`, `docs/architecture.md`.
- **Rejected:** A driver migration or account normalization as part of notification/conversation work.

## 2026-10-17 — Separate attention from activity and execution

- **Context:** The user needs task assignments, mentions and agent feedback visible without requiring an always-running AI process.
- **Decision:** Keep recipient notification cursor compatibility, add a separately versioned authorized activity feed, and let external watchers claim explicit requests. Source contract: `docs/notifications.md`, `docs/work-conversations.md`.
- **Rejected:** Running Hermes or a named supervisor persona inside Office Office; treating every comment as an execution request.

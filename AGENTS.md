# Office Office

## Product boundaries
- Read README.md and docs/architecture.md before changing scope.
- Current slice: RPC demo onboarding, team, customers, projects, social queue and settings. Targets, strategy and pricing remain product scope.
- Durable architecture: SQLite + Litestream, katha events and kathputli actors.
- Hermes owns conversational messaging and agent execution. Office Office owns the social publishing queue; live posting adapters are deferred.
- Humans and agents read and write Office Office through the same RPC layer.
- External access is read-only by default; explicit narrow actions (e.g. Zoho invoice send) need separate permissions and audit records. Never forward provider secrets.
- Explicit demo fixtures must come from RPC and be labelled as samples. Never present fake records, connections, posts or approvals as real.

## Tools and checks
- Prefix shell commands with `rtk`; use `rtk proxy` for unsupported commands.
- Use pnpm. Canonical tasks are in Justfile.
- Schema: proto/office/v1/office.proto. Run `just generate` after changing it.
- Focused Rust checks: `cargo test -p office-server`, `cargo clippy -p office-server --all-targets -- -D warnings`.
- Frontend check: `pnpm --filter @office-office/web check`.
- Do not edit generated clients manually.

## Delegation
- Primary agent coordinates architecture, verification, Git, and release steps.
- Use Luna/medium for bounded scaffolding, discovery, and mechanical work.
- Use an available mid-tier model for bounded implementation/review; expensive models only for justified cross-layer problems.
- Give workers separate file ownership. Run only one Cargo build at a time.
- Never default workers to xhigh or run everything on Sol.

## Commit attribution
- Use accurate agent-model Co-Authored-By trailers when applicable; never invent identities.

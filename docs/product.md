---
governs:
  paths: []
  shapes: [product]
  verify: ask
---

# Product boundaries

Office Office is a daily shared office for people and AI users. Customers, projects,
boards, tasks, research reports and work conversations belong together so that both
humans using the UI and agents using RPC/MCP can see progress and contribute work.
This is the user's stated product direction; the sitcom Office Office supplies the
name and affectionate inspiration, not a dependency or endorsement.

## Deliberate boundaries

The user chose a generic shared application: Hermes, Claude Code, Codex or other clients
can authenticate as actual members. Office Office records assignments, discussion,
results and attention. External clients run agents and own runtime conversations.
No named persona or Hermes profile is hard-coded. A card move, mention or assignment
never grants permission to send, publish, spend or change security settings.

External integrations are read-only by default. Narrow provider actions need explicit
permissions and audit evidence. The public project does not impose an operator's
Kamal configuration. These boundaries were supplied by the user and are recorded in
`AGENTS.md` and `docs/architecture.md`.

## Deferred work

Targets, strategy, pricing history, analytics ingestion, live social posting and provider
adapters remain wanted but deferred. Project-specific access grants and a production
public authentication perimeter remain policy/security work. Current fixed roles are
Admin, Manager, Member and Viewer; centrally editable roles can follow if needed.
These are existing user decisions, not claims of implemented functionality.

# Starter data and engine testing

The first-admin form offers **Start with sample office data**. It is optional content for testing and showing what the app can hold: two pending teammates, three customers, three projects, multiple boards, ten tasks, task discussion, three research reports and three disconnected-channel social drafts.

These are ordinary editable office records with generated IDs and sample labels. Contacts use `example.test`, dates are relative to when the scenario runs, and all report findings and sources are explicitly fictional. Teammates remain pending and get no shared demo passwords. The disconnected social channel is a demo record; draft schedule dates do not publish posts. Nothing sends invitations, messages, posts or provider requests. The scenario does not schedule agents or establish real social connections or approvals.

## One pipeline

The scenario submits typed `EngineCommand` DTOs to the same engine dispatcher used by RPC record writes. The actor validates authorization and business rules, produces katha events and activity, updates the projection, and commits to SQLite before acknowledging success. It does not insert database rows or pre-fill read projections directly.

Bootstrap executes the administrator setup and complete starter scenario in one transaction. A failure rolls all of it back, so the next registration attempt can start cleanly. A scenario/version event records provenance. Repeating registration is rejected rather than duplicating fixtures or mixing another scenario into an existing office.

The data flag and storage choice are independent:

| Storage | Sample option | Result |
| --- | --- | --- |
| Default SQLite | Unchecked | Empty office after admin creation |
| Default SQLite | Checked | Sample records persist across restarts |
| `OFFICE_DEMO_MODE=true` in-memory storage | Checked (preselected) | Sample office resets on restart |
| `OFFICE_DEMO_MODE=true` in-memory storage | Unchecked | Empty temporary office |

Setup/workspace DTOs expose `demo_mode` for sample-data provenance and `persistent_storage` for durability. Loading samples does not turn normal writes into a permanently restricted demo installation.

## Exercise the engine without HTTP

The public Rust service entry points are `bootstrap`, `authenticate`, `workspace` and `execute`. A direct caller supplies the same JWT issued at login/bootstrap; the actor still checks current permissions. There is no unauthenticated execute-anything endpoint.

```rust,ignore
use office_server::{EngineCommand, EngineOutcome, OfficePreviewService};
use office_server::proto::office::v1::{
    BootstrapAdminRequest, Customer, SaveCustomerRequest,
};

let engine = OfficePreviewService::open("/private/test-office.sqlite3").await?;
let session = engine.bootstrap(BootstrapAdminRequest {
    name: "Test Admin".into(),
    email: "admin@example.test".into(),
    password: "test-only-password-123".into(),
    workspace_name: "Test Office".into(),
    load_demo_data: true,
    ..Default::default()
}).await?;

let result = engine.execute(&session.token, EngineCommand::SaveCustomer(
    SaveCustomerRequest {
        customer: Some(Customer {
            name: "Test Contact".into(),
            company: "Example Studio".into(),
            email: "contact@example.test".into(),
            status: "active".into(),
            ..Default::default()
        }).into(),
        ..Default::default()
    }
)).await?;
assert!(matches!(result, EngineOutcome::Customer(_)));
engine.close().await?;
```

For isolated tests without a file, use `OfficePreviewService::new()` and explicitly choose whether bootstrap loads sample data. It starts with no records until bootstrap runs.

Commands support tagged JSON DTOs, which can be deserialized into `EngineCommand` for a scenario/test harness:

```json
{
  "type": "save_customer",
  "data": {
    "customer": {
      "name": "Test Contact",
      "company": "Example Studio",
      "email": "contact@example.test",
      "status": "active"
    }
  }
}
```

The JSON format is an in-process command contract, not a bypass of permissions. Treat credential-bearing commands and authentication responses as secrets; do not log their serialized contents. Use returned IDs when later commands need references. A scenario may execute the private core dispatcher while already inside the actor transaction; it must never recursively ask its own mailbox.

## Removal and test boundaries

Task comments support event-based soft deletion and show a tombstone in the discussion; their history is retained. Soft deletion for customers, projects, tasks and other starter records is not implemented yet. Starter-data loading does not add a hard-delete, bulk-reset or erase-history path. For disposable automated tests, use a temporary database directory or in-memory engine instance instead of deleting a working office's history.

`apps/server/tests/demo.rs` exercises the transport-free engine, normal validation and read-only roles, generated event-backed fixtures, restart replay, repeat-registration protection and rollback after a late scenario failure. RPC and MCP integration tests separately cover transport behavior. The browser smoke flow selects sample data explicitly during registration.

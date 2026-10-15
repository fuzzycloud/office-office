use std::sync::Arc;

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use connectrpc::Router as ConnectRouter;
use http_body_util::BodyExt;
use office_server::{
    OfficePreviewService,
    proto::office::v1::{OfficeServiceExt, Task},
};
use serde_json::{Value, json};
use tower::ServiceExt;

fn app(service: Arc<OfficePreviewService>) -> Router {
    Router::new().nest_service(
        "/rpc",
        service.register(ConnectRouter::new()).into_axum_service(),
    )
}

async fn rpc(app: &Router, method: &str, token: Option<&str>, body: Value) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method("POST")
        .uri(format!("/rpc/office.v1.OfficeService/{method}"))
        .header("content-type", "application/json")
        .header("connect-protocol-version", "1");
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn ok(app: &Router, method: &str, token: Option<&str>, body: Value) -> Value {
    let (status, result) = rpc(app, method, token, body).await;
    assert_eq!(status, StatusCode::OK, "{method}: {result}");
    result
}

async fn bootstrap(app: &Router) -> Value {
    ok(app, "BootstrapAdmin", None, json!({"name":"Office Admin", "email":"admin@example.test", "password":"persistent-password-123", "workspaceName":"Persistent Office"})).await
}

#[tokio::test]
async fn restart_replays_records_credentials_and_revocation_without_samples() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("office.sqlite3");
    let service = Arc::new(OfficePreviewService::open(&path).await.unwrap());
    let router = app(service.clone());
    let status = ok(&router, "GetSetupStatus", None, json!({})).await;
    assert_eq!(status["needsSetup"], true);
    assert_ne!(status["demoMode"], true);
    let admin = bootstrap(&router).await;
    let token = admin["token"].as_str().unwrap();
    let admin_id = admin["user"]["id"].as_str().unwrap();
    let initial = ok(&router, "GetWorkspace", Some(token), json!({})).await;
    for name in [
        "customers",
        "projects",
        "boards",
        "tasks",
        "connections",
        "posts",
    ] {
        assert!(
            initial
                .get(name)
                .and_then(Value::as_array)
                .is_none_or(Vec::is_empty),
            "{name}: unexpected seed data"
        );
    }
    let member = ok(&router, "SaveMember", Some(token), json!({"member":{"name":"Reviewer", "email":"reviewer@example.test", "role":"viewer", "status":"active", "access":["projects"]}, "password":"reviewer-password-123"})).await;
    let member_id = member["member"]["id"].as_str().unwrap();
    let customer = ok(&router, "SaveCustomer", Some(token), json!({"customer":{"name":"Contact", "company":"Customer Studio", "email":"contact@example.test", "status":"active", "ownerId":admin_id}})).await;
    let project = ok(&router, "SaveProject", Some(token), json!({"project":{"name":"Launch", "status":"active", "customerId":customer["customer"]["id"], "ownerId":admin_id}})).await;
    let project_id = project["project"]["id"].as_str().unwrap();
    let workspace = ok(&router, "GetWorkspace", Some(token), json!({})).await;
    let board_id = workspace["boards"][0]["id"].as_str().unwrap();
    let column = workspace["boards"][0]["columns"][0].as_str().unwrap();
    let task = ok(&router, "SaveTask", Some(token), json!({"task":{"projectId":project_id, "boardId":board_id, "column":column, "title":"Prepare launch", "assigneeId":member_id, "priority":"high", "dueDate":"2026-12-31"}})).await;
    ok(&router, "SaveSettings", Some(token), json!({"settings":{"workspaceName":"Saved Office", "defaultTheme":"nord", "timezone":"Asia/Kolkata"}})).await;
    let key = ok(
        &router,
        "CreateAgentKey",
        Some(token),
        json!({"name":"Planner", "scopes":["projects:write"], "expiresInDays":30}),
    )
    .await;
    let secret = key["secret"].as_str().unwrap();
    let revoked = ok(
        &router,
        "CreateAgentKey",
        Some(token),
        json!({"name":"Old key", "scopes":["projects:read"], "expiresInDays":1}),
    )
    .await;
    ok(
        &router,
        "RevokeAgentKey",
        Some(token),
        json!({"id":revoked["key"]["id"]}),
    )
    .await;
    // A second connection observes committed data while the service is alive.
    // Public event payloads must not contain authentication material.
    let db = rusqlite::Connection::open(&path).unwrap();
    let journal_mode: String = db
        .pragma_query_value(None, "journal_mode", |row| row.get(0))
        .unwrap();
    assert_eq!(journal_mode, "wal");
    let payloads: String = db
        .query_row("SELECT group_concat(payload, '') FROM events", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert!(!payloads.contains(secret));
    assert!(!payloads.contains("persistent-password-123"));
    assert!(!payloads.contains("$argon2"));
    drop(db);
    service.close().await.unwrap();
    drop(router);
    drop(service);

    let service = Arc::new(OfficePreviewService::open(&path).await.unwrap());
    let router = app(service.clone());
    let status = ok(&router, "GetSetupStatus", None, json!({})).await;
    assert_ne!(status["needsSetup"], true);
    assert!(rpc(&router, "BootstrapAdmin", None, json!({"name":"Intruder", "email":"other@example.test", "password":"another-password-123", "workspaceName":"Other"})).await.0.is_client_error());
    // The signing key is restored: a valid, unexpired session continues to work.
    let workspace = ok(&router, "GetWorkspace", Some(token), json!({})).await;
    assert_eq!(workspace["settings"]["workspaceName"], "Saved Office");
    assert_eq!(workspace["settings"]["defaultTheme"], "nord");
    assert_eq!(workspace["customers"][0]["company"], "Customer Studio");
    assert_eq!(workspace["tasks"][0]["id"], task["task"]["id"]);
    assert_eq!(workspace["tasks"][0]["assigneeId"], member_id);
    let login = ok(
        &router,
        "Login",
        None,
        json!({"email":"reviewer@example.test", "password":"reviewer-password-123"}),
    )
    .await;
    assert_eq!(login["user"]["id"], member_id);
    assert_eq!(
        rpc(
            &router,
            "SaveTask",
            login["token"].as_str(),
            json!({"task":{"title":"Forbidden"}})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert!(service.agent_validate_key(secret).await.is_ok());
    assert!(
        service
            .agent_validate_key(revoked["secret"].as_str().unwrap())
            .await
            .is_err()
    );
    service
        .agent_save_task(
            secret,
            Task {
                project_id: project_id.into(),
                board_id: board_id.into(),
                column: column.into(),
                title: "Agent after restart".into(),
                priority: "medium".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    service.close().await.unwrap();
    drop(router);
    drop(service);

    let service = Arc::new(OfficePreviewService::open(&path).await.unwrap());
    let router = app(service.clone());
    let login = ok(
        &router,
        "Login",
        None,
        json!({"email":"admin@example.test", "password":"persistent-password-123"}),
    )
    .await;
    let workspace = ok(&router, "GetWorkspace", login["token"].as_str(), json!({})).await;
    assert!(
        workspace["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|task| task["title"] == "Agent after restart")
    );
    assert!(
        workspace["activity"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["actorName"] == "Office Admin (AI: Planner)")
    );
    service.close().await.unwrap();
}

#[tokio::test]
async fn concurrent_writes_are_all_committed_and_second_writer_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("office.sqlite3");
    let service = Arc::new(OfficePreviewService::open(&path).await.unwrap());
    assert!(OfficePreviewService::open(&path).await.is_err());
    let router = app(service.clone());
    let admin = bootstrap(&router).await;
    let token = admin["token"].as_str().unwrap();
    let mut writes = Vec::new();
    for index in 0..12 {
        let router = router.clone();
        let token = token.to_owned();
        writes.push(tokio::spawn(async move {
            ok(&router, "SaveCustomer", Some(&token), json!({"customer":{"name":format!("Contact {index}"), "company":format!("Studio {index}"), "email":format!("contact{index}@example.test"), "status":"active"}})).await
        }));
    }
    for write in writes {
        write.await.unwrap();
    }
    service.close().await.unwrap();
    drop(router);
    drop(service);
    let service = Arc::new(OfficePreviewService::open(&path).await.unwrap());
    let router = app(service.clone());
    let workspace = ok(&router, "GetWorkspace", Some(token), json!({})).await;
    assert_eq!(workspace["customers"].as_array().unwrap().len(), 12);
    service.close().await.unwrap();
}

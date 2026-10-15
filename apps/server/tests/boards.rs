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
async fn bootstrap(app: &Router) -> String {
    let (status, body) = rpc(
        app,
        "BootstrapAdmin",
        None,
        json!({
            "name":"Admin", "email":"admin@example.test", "password":"sample-password-123",
            "workspaceName":"Office"
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["token"].as_str().unwrap().into()
}

#[tokio::test]
async fn boards_tasks_and_moves_validate_project_and_columns() {
    let app = app(Arc::new(OfficePreviewService::new()));
    let token = bootstrap(&app).await;
    let (_, created) = rpc(
        &app,
        "SaveProject",
        Some(&token),
        json!({"project":{
            "name":"New project", "status":"active"
        }}),
    )
    .await;
    let project_id = created["project"]["id"].as_str().unwrap();
    let (_, workspace) = rpc(&app, "GetWorkspace", Some(&token), json!({})).await;
    assert!(
        workspace["boards"]
            .as_array()
            .unwrap()
            .iter()
            .any(|b| b["projectId"] == project_id)
    );
    assert_eq!(workspace["tasks"][0]["title"], "Sample task — plan launch");

    let (status, board) = rpc(
        &app,
        "SaveBoard",
        Some(&token),
        json!({"board":{
            "projectId":project_id, "name":"Delivery", "columns":["Ready","Doing","Done"]
        }}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{board}");
    let board_id = board["board"]["id"].as_str().unwrap();
    let (status, task) = rpc(&app, "SaveTask", Some(&token), json!({"task":{
        "projectId":project_id, "boardId":board_id, "column":"Ready", "title":"Ship", "priority":"high", "dueDate":"2026-12-31"
    }})).await;
    assert_eq!(status, StatusCode::OK, "{task}");
    let task_id = task["task"]["id"].as_str().unwrap();
    let (status, moved) = rpc(&app, "SaveTask", Some(&token), json!({"task":{
        "id":task_id, "projectId":project_id, "boardId":board_id, "column":"Doing", "title":"Ship", "priority":"high"
    }})).await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    assert_eq!(moved["task"]["column"], "Doing");
    for invalid in [
        json!({"projectId":"demo-project-1", "boardId":board_id, "column":"Doing", "title":"Wrong project", "priority":"high"}),
        json!({"projectId":project_id, "boardId":board_id, "column":"Missing", "title":"Wrong column", "priority":"high"}),
        json!({"projectId":project_id, "boardId":board_id, "column":"Ready", "title":"Wrong date", "priority":"high", "dueDate":"2026-02-30"}),
    ] {
        assert_eq!(
            rpc(&app, "SaveTask", Some(&token), json!({"task":invalid}))
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        rpc(
            &app,
            "SaveBoard",
            Some(&token),
            json!({"board":{
                "id":board_id, "projectId":project_id, "name":"Delivery", "columns":["Ready","Done"]
            }})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn agent_keys_are_scoped_audited_and_revoked() {
    let service = Arc::new(OfficePreviewService::new());
    let app = app(service.clone());
    let token = bootstrap(&app).await;
    let (status, created) = rpc(
        &app,
        "CreateAgentKey",
        Some(&token),
        json!({
            "name":"Planner", "scopes":["projects:write"], "expiresInDays":30
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let secret = created["secret"].as_str().unwrap();
    assert!(secret.starts_with("oo_"));
    assert_eq!(secret.len(), 67);
    assert!(service.agent_validate_key(secret).await.is_ok());
    let (_, listed) = rpc(&app, "ListAgentKeys", Some(&token), json!({})).await;
    assert!(!listed.to_string().contains(secret));
    assert_eq!(listed["keys"][0]["name"], "Planner");
    let workspace = service.agent_workspace(secret).await.unwrap();
    assert!(!workspace.projects.is_empty());
    assert!(workspace.customers.is_empty());
    assert!(workspace.members.is_empty());
    assert!(!workspace.current_user.is_set());
    assert!(!workspace.settings.is_set());
    let task = service
        .agent_save_task(
            secret,
            Task {
                project_id: "demo-project-1".into(),
                board_id: "demo-board-1".into(),
                column: "Todo".into(),
                title: "AI planning task".into(),
                priority: "low".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(!task.id.is_empty());
    let (_, workspace) = rpc(&app, "GetWorkspace", Some(&token), json!({})).await;
    assert!(
        workspace["activity"]
            .as_array()
            .unwrap()
            .iter()
            .any(|a| a["actorName"] == "Admin (AI: Planner)")
    );
    assert!(!workspace.to_string().contains(secret));
    assert_eq!(
        rpc(&app, "ListAgentKeys", Some(secret), json!({})).await.0,
        StatusCode::UNAUTHORIZED
    );
    let key_id = created["key"]["id"].as_str().unwrap();
    assert_eq!(
        rpc(&app, "RevokeAgentKey", Some(&token), json!({"id":key_id}))
            .await
            .0,
        StatusCode::OK
    );
    assert!(service.agent_validate_key(secret).await.is_err());
    assert!(service.agent_workspace(secret).await.is_err());
    assert_eq!(
        rpc(
            &app,
            "CreateAgentKey",
            Some(&token),
            json!({
                "name":"Expired", "scopes":["projects:read"], "expiresInDays":91
            })
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let (_, read_key) = rpc(
        &app,
        "CreateAgentKey",
        Some(&token),
        json!({
            "name":"Reader", "scopes":["projects:read"], "expiresInDays":1
        }),
    )
    .await;
    let reader_secret = read_key["secret"].as_str().unwrap();
    assert!(service.agent_validate_key(reader_secret).await.is_ok());
    assert!(
        service
            .agent_save_task(
                reader_secret,
                Task {
                    project_id: "demo-project-1".into(),
                    board_id: "demo-board-1".into(),
                    column: "Todo".into(),
                    title: "Forbidden".into(),
                    priority: "low".into(),
                    ..Default::default()
                }
            )
            .await
            .is_err()
    );
}

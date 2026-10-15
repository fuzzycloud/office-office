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
            "workspaceName":"Office", "loadDemoData":true
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
    let (_, seeded) = rpc(&app, "GetWorkspace", Some(&token), json!({})).await;
    let sample_project_id = seeded["projects"][0]["id"].as_str().unwrap();
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
    assert!(
        workspace["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|task| task["title"] == "Sample task — plan launch")
    );

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
        json!({"projectId":sample_project_id, "boardId":board_id, "column":"Doing", "title":"Wrong project", "priority":"high"}),
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
async fn agent_keys_follow_roles_and_are_revoked() {
    let service = Arc::new(OfficePreviewService::new());
    let app = app(service.clone());
    let token = bootstrap(&app).await;
    let (_, seeded) = rpc(&app, "GetWorkspace", Some(&token), json!({})).await;
    let project_id = seeded["projects"][0]["id"].as_str().unwrap().to_owned();
    let board = seeded["boards"]
        .as_array()
        .unwrap()
        .iter()
        .find(|board| board["projectId"] == project_id)
        .unwrap();
    let board_id = board["id"].as_str().unwrap().to_owned();
    let column = board["columns"][0].as_str().unwrap().to_owned();
    let (_, agent) = rpc(&app, "SaveMember", Some(&token), json!({"member":{"name":"Planner agent","kind":"agent","role":"member","status":"active","access":["projects"]}})).await;
    let member_id = agent["member"]["id"].as_str().unwrap();
    let (status, created) = rpc(
        &app,
        "CreateAgentKey",
        Some(&token),
        json!({
            "name":"Planner", "memberId":member_id, "scopes":["projects:write"], "expiresInDays":30
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let secret = created["secret"].as_str().unwrap();
    let exchanged = rpc(&app, "ExchangeAgentKey", None, json!({"key":secret}))
        .await
        .1;
    let access_token = exchanged["token"].as_str().unwrap();
    assert!(secret.starts_with("oo_"));
    assert_eq!(secret.len(), 67);
    assert!(service.agent_validate_token(access_token).await.is_ok());
    assert_eq!(
        rpc(&app, "ListAgentKeys", Some(access_token), json!({}))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let (_, listed) = rpc(&app, "ListAgentKeys", Some(&token), json!({})).await;
    assert!(!listed.to_string().contains(secret));
    assert!(
        listed["keys"]
            .as_array()
            .unwrap()
            .iter()
            .any(|key| key["name"] == "Planner")
    );
    let workspace = service.agent_workspace(access_token).await.unwrap();
    assert!(!workspace.projects.is_empty());
    assert!(!workspace.customers.is_empty());
    assert!(!workspace.members.is_empty());
    assert!(workspace.current_user.is_set());
    assert!(workspace.settings.is_set());
    let task = service
        .agent_save_task(
            access_token,
            Task {
                project_id: project_id.clone(),
                board_id: board_id.clone(),
                column: column.clone(),
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
            .any(|a| a["actorName"] == "Planner agent")
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
    assert!(service.agent_validate_token(access_token).await.is_err());
    assert!(service.agent_workspace(access_token).await.is_err());
    assert_eq!(
        rpc(&app, "GetWorkspace", Some(access_token), json!({}))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        rpc(
            &app,
            "CreateAgentKey",
            Some(&token),
            json!({
                "name":"Expired", "memberId":member_id, "scopes":["projects:read"], "expiresInDays":91
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
            "name":"Reader", "memberId":member_id, "scopes":["projects:read"], "expiresInDays":1
        }),
    )
    .await;
    let reader_secret = read_key["secret"].as_str().unwrap();
    let reader_token = rpc(&app, "ExchangeAgentKey", None, json!({"key":reader_secret}))
        .await
        .1["token"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(service.agent_validate_token(&reader_token).await.is_ok());
    assert_eq!(rpc(&app, "SaveTask", Some(&reader_token), json!({"task":{"projectId":project_id,"boardId":board_id,"column":column,"title":"RPC role grant","priority":"low"}})).await.0, StatusCode::OK);
    assert!(
        service
            .agent_save_task(
                &reader_token,
                Task {
                    project_id: project_id.clone(),
                    board_id: board_id.clone(),
                    column: column.clone(),
                    title: "Forbidden".into(),
                    priority: "low".into(),
                    ..Default::default()
                }
            )
            .await
            .is_ok()
    );
    assert_eq!(rpc(&app, "SaveMember", Some(&token), json!({"member":{"id":member_id,"name":"Planner agent","kind":"agent","role":"member","status":"inactive","access":["projects"]}})).await.0, StatusCode::OK);
    assert!(service.agent_validate_token(&reader_token).await.is_err());
    assert_eq!(
        rpc(&app, "ExchangeAgentKey", None, json!({"key":reader_secret}))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
}

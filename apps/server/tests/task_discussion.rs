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
    proto::office::v1::{OfficeServiceExt, SaveTaskCommentRequest},
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
    let (status, response) = rpc(app, method, token, body).await;
    assert_eq!(status, StatusCode::OK, "{method}: {response}");
    response
}

#[tokio::test]
async fn comments_history_permissions_revisions_and_replay() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("discussion.sqlite3");
    let service = Arc::new(OfficePreviewService::open(&path).await.unwrap());
    let router = app(service.clone());
    let bootstrap = ok(&router, "BootstrapAdmin", None, json!({"name":"Admin","email":"admin@example.test","password":"admin-password-123","workspaceName":"Discussion"})).await;
    let admin = bootstrap["token"].as_str().unwrap();
    let project = ok(
        &router,
        "SaveProject",
        Some(admin),
        json!({"project":{"name":"Project","status":"active"}}),
    )
    .await;
    let workspace = ok(&router, "GetWorkspace", Some(admin), json!({})).await;
    let board = &workspace["boards"][0];
    let task = ok(&router, "SaveTask", Some(admin), json!({"task":{"projectId":project["project"]["id"],"boardId":board["id"],"column":"Todo","title":"Test discussion","priority":"medium","commentCount":999}})).await;
    let task_id = task["task"]["id"].as_str().unwrap();
    assert!(task["task"]["commentCount"].as_u64().unwrap_or(0) == 0);
    let mut tokens = Vec::new();
    for (name, role, access) in [
        ("Writer", "member", "projects"),
        ("Other", "manager", "projects"),
        ("Viewer", "viewer", "projects"),
        ("Excluded", "member", "reports"),
    ] {
        let email = format!("{}@example.test", name.to_lowercase());
        ok(&router, "SaveMember", Some(admin), json!({"member":{"name":name,"email":email,"role":role,"status":"active","access":[access]},"password":"member-password-123"})).await;
        let login = ok(
            &router,
            "Login",
            None,
            json!({"email":email,"password":"member-password-123"}),
        )
        .await;
        tokens.push(login["token"].as_str().unwrap().to_owned());
    }
    let created = ok(
        &router,
        "SaveTaskComment",
        Some(&tokens[0]),
        json!({"taskId":task_id,"body":" First note "}),
    )
    .await;
    let comment = &created["comment"];
    let comment_id = comment["id"].as_str().unwrap();
    assert_eq!(comment["body"], "First note");
    assert_eq!(comment["actorKind"], "human");
    assert_eq!(comment["authorName"], "Writer");
    assert_eq!(comment["revision"], 1);
    let discussion = ok(
        &router,
        "ListTaskDiscussion",
        Some(&tokens[2]),
        json!({"taskId":task_id}),
    )
    .await;
    assert_eq!(discussion["comments"].as_array().unwrap().len(), 1);
    assert_eq!(discussion["activity"][0]["kind"], "comment_added");
    for token in [&tokens[1], &tokens[2]] {
        assert_eq!(
            rpc(
                &router,
                "SaveTaskComment",
                Some(token),
                json!({"taskId":task_id,"commentId":comment_id,"body":"No","expectedRevision":1})
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            rpc(
                &router,
                "DeleteTaskComment",
                Some(token),
                json!({"taskId":task_id,"commentId":comment_id,"expectedRevision":1})
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(
        rpc(
            &router,
            "ListTaskDiscussion",
            Some(&tokens[3]),
            json!({"taskId":task_id})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        rpc(
            &router,
            "SaveTaskComment",
            Some(&tokens[2]),
            json!({"taskId":task_id,"body":"No"})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        rpc(
            &router,
            "SaveTaskComment",
            Some(&tokens[0]),
            json!({"taskId":task_id,"commentId":comment_id,"body":"Stale","expectedRevision":0})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        rpc(
            &router,
            "SaveTaskComment",
            Some(&tokens[0]),
            json!({"taskId":task_id,"body":"   "})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let edited = ok(
        &router,
        "SaveTaskComment",
        Some(&tokens[0]),
        json!({"taskId":task_id,"commentId":comment_id,"body":"Edited note","expectedRevision":1}),
    )
    .await;
    assert_eq!(edited["comment"]["revision"], 2);
    assert_eq!(edited["comment"]["createdAt"], comment["createdAt"]);
    let agent = ok(&router, "SaveMember", Some(admin), json!({"member":{"name":"Research bot","kind":"agent","role":"member","status":"active","access":["projects"]}})).await;
    let other_agent = ok(&router, "SaveMember", Some(admin), json!({"member":{"name":"Other bot","kind":"agent","role":"member","status":"active","access":["projects"]}})).await;
    let key = ok(
        &router,
        "CreateAgentKey",
        Some(admin),
        json!({"name":"Research bot","memberId":agent["member"]["id"],"scopes":["projects:write"],"expiresInDays":30}),
    )
    .await;
    let other_key = ok(
        &router,
        "CreateAgentKey",
        Some(admin),
        json!({"name":"Other bot","memberId":other_agent["member"]["id"],"scopes":["projects:write"],"expiresInDays":30}),
    )
    .await;
    let read_key = ok(
        &router,
        "CreateAgentKey",
        Some(admin),
        json!({"name":"Reader bot","memberId":agent["member"]["id"],"scopes":["projects:read"],"expiresInDays":30}),
    )
    .await;
    let secret = ok(
        &router,
        "ExchangeAgentKey",
        None,
        json!({"key":key["secret"]}),
    )
    .await["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let other_token = ok(
        &router,
        "ExchangeAgentKey",
        None,
        json!({"key":other_key["secret"]}),
    )
    .await["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let read_token = ok(
        &router,
        "ExchangeAgentKey",
        None,
        json!({"key":read_key["secret"]}),
    )
    .await["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let secret = secret.as_str();
    assert!(
        service
            .agent_save_task_comment(
                secret,
                SaveTaskCommentRequest {
                    task_id: task_id.into(),
                    comment_id: comment_id.into(),
                    body: "Cannot impersonate owner".into(),
                    expected_revision: 2,
                    ..Default::default()
                }
            )
            .await
            .is_err()
    );
    let before_failure = service.task_discussion(admin, task_id).await.unwrap();
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TRIGGER fail_comment_activity BEFORE INSERT ON events WHEN NEW.event_type = 'task_activity' BEGIN SELECT RAISE(ABORT, 'forced comment activity failure'); END;").unwrap();
    assert!(
        service
            .agent_save_task_comment(
                secret,
                SaveTaskCommentRequest {
                    task_id: task_id.into(),
                    body: "Must roll back".into(),
                    ..Default::default()
                }
            )
            .await
            .is_err()
    );
    assert_eq!(
        serde_json::to_value(service.task_discussion(admin, task_id).await.unwrap()).unwrap(),
        serde_json::to_value(before_failure).unwrap()
    );
    assert_eq!(
        service.workspace(admin).await.unwrap().tasks[0].comment_count,
        1
    );
    conn.execute_batch("DROP TRIGGER fail_comment_activity;")
        .unwrap();
    drop(conn);
    let ai = service
        .agent_save_task_comment(
            secret,
            SaveTaskCommentRequest {
                task_id: task_id.into(),
                body: "Agent note".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(ai.actor_kind, "agent");
    assert_eq!(ai.author_id, agent["member"]["id"].as_str().unwrap());
    assert!(ai.author_name.contains("Research bot"));
    let edit_ai = SaveTaskCommentRequest {
        task_id: task_id.into(),
        comment_id: ai.id.clone(),
        body: "Updated agent note".into(),
        expected_revision: 1,
        ..Default::default()
    };
    assert!(
        service
            .agent_save_task_comment(&other_token, edit_ai.clone())
            .await
            .is_err()
    );
    assert!(
        service
            .agent_save_task_comment(&read_token, edit_ai.clone())
            .await
            .is_ok()
    );
    assert!(
        service
            .agent_save_task_comment(secret, edit_ai)
            .await
            .is_err()
    );
    assert_eq!(
        service
            .agent_task_discussion(&read_token, task_id)
            .await
            .unwrap()
            .comments
            .len(),
        2
    );
    let mut moved_task = task["task"].clone();
    moved_task["column"] = json!("Done");
    moved_task["commentCount"] = json!(1000);
    let moved = ok(&router, "SaveTask", Some(admin), json!({"task":moved_task})).await;
    assert_eq!(moved["task"]["commentCount"], 2);
    let before = service.task_discussion(admin, task_id).await.unwrap();
    ok(
        &router,
        "SaveTask",
        Some(admin),
        json!({"task":moved["task"]}),
    )
    .await;
    assert_eq!(
        service
            .task_discussion(admin, task_id)
            .await
            .unwrap()
            .activity
            .len(),
        before.activity.len()
    );
    assert!(
        before
            .activity
            .iter()
            .any(|a| a.kind == "task_moved" && a.summary.contains("Todo → Done"))
    );
    let second_board = ok(&router, "SaveBoard", Some(admin), json!({"board":{"projectId":project["project"]["id"],"name":"Second board","columns":["Done"]}})).await;
    let mut agent_task = service.workspace(admin).await.unwrap().tasks[0].clone();
    agent_task.board_id = second_board["board"]["id"].as_str().unwrap().into();
    let agent_moved = service.agent_save_task(secret, agent_task).await.unwrap();
    assert_eq!(agent_moved.id, task_id);
    assert_eq!(agent_moved.comment_count, 2);
    let after_agent_move = service.task_discussion(admin, task_id).await.unwrap();
    assert_eq!(after_agent_move.activity[0].actor_kind, "agent");
    assert_eq!(after_agent_move.activity[0].actor_id, ai.author_id);
    assert_eq!(after_agent_move.comments.len(), 2);
    let deleted = ok(
        &router,
        "DeleteTaskComment",
        Some(admin),
        json!({"taskId":task_id,"commentId":comment_id,"expectedRevision":2}),
    )
    .await;
    assert_eq!(deleted["comment"]["deleted"], true);
    assert!(deleted["comment"]["body"].as_str().unwrap_or("").is_empty());
    assert_eq!(deleted["comment"]["revision"], 3);
    assert_eq!(
        rpc(
            &router,
            "SaveTaskComment",
            Some(&tokens[0]),
            json!({"taskId":task_id,"commentId":comment_id,"body":"Restore","expectedRevision":3})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let ai_admin = ok(
        &router,
        "SaveMember",
        Some(admin),
        json!({"member":{"name":"AI moderator","kind":"agent","role":"admin","status":"active"}}),
    )
    .await;
    let ai_admin_token = ok(
        &router,
        "ExchangeAgentKey",
        None,
        json!({"key":ai_admin["secret"]}),
    )
    .await["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let moderated = ok(&router, "SaveTaskComment", Some(&ai_admin_token), json!({"taskId":task_id,"commentId":ai.id,"body":"Moderated agent note","expectedRevision":2})).await;
    assert_eq!(moderated["comment"]["revision"], 3);
    assert_eq!(moderated["comment"]["body"], "Moderated agent note");
    assert_eq!(
        rpc(
            &router,
            "SaveTaskComment",
            Some(&other_token),
            json!({"taskId":task_id,"commentId":ai.id,"body":"Member edit","expectedRevision":3})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let expected = service.task_discussion(admin, task_id).await.unwrap();
    service.close().await.unwrap();
    drop(router);
    drop(service);
    let reopened = OfficePreviewService::open(&path).await.unwrap();
    let replayed = reopened.task_discussion(admin, task_id).await.unwrap();
    assert_eq!(
        serde_json::to_value(expected).unwrap(),
        serde_json::to_value(replayed).unwrap()
    );
    assert_eq!(
        reopened.workspace(admin).await.unwrap().tasks[0].comment_count,
        1
    );
    reopened.close().await.unwrap();
}

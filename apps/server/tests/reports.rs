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
    proto::office::v1::{ListReportsRequest, OfficeServiceExt, Report, SaveReportRequest},
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
async fn reports_are_versioned_scoped_and_replayed() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("reports.sqlite3");
    let service = Arc::new(OfficePreviewService::open(&path).await.unwrap());
    let router = app(service.clone());
    let admin = ok(&router, "BootstrapAdmin", None, json!({"name":"Admin", "email":"admin@example.test", "password":"persistent-password-123", "workspaceName":"Research"})).await;
    let token = admin["token"].as_str().unwrap();
    assert_eq!(
        ok(&router, "ListReports", Some(token), json!({})).await["totalCount"]
            .as_u64()
            .unwrap_or(0),
        0
    );
    let author = ok(&router, "SaveMember", Some(token), json!({"member":{"name":"Researcher", "email":"researcher@example.test", "role":"member", "status":"active", "access":["reports"]}, "password":"researcher-password-123"})).await;
    let viewer = ok(&router, "SaveMember", Some(token), json!({"member":{"name":"Reader", "email":"reader@example.test", "role":"viewer", "status":"active", "access":["reports"]}, "password":"reader-password-123"})).await;
    let excluded = ok(&router, "SaveMember", Some(token), json!({"member":{"name":"Excluded", "email":"excluded@example.test", "role":"member", "status":"active", "access":["projects"]}, "password":"excluded-password-123"})).await;
    let author_login = ok(
        &router,
        "Login",
        None,
        json!({"email":"researcher@example.test", "password":"researcher-password-123"}),
    )
    .await;
    let author_token = author_login["token"].as_str().unwrap();
    let viewer_login = ok(
        &router,
        "Login",
        None,
        json!({"email":"reader@example.test", "password":"reader-password-123"}),
    )
    .await;
    let viewer_token = viewer_login["token"].as_str().unwrap();
    let excluded_login = ok(
        &router,
        "Login",
        None,
        json!({"email":"excluded@example.test", "password":"excluded-password-123"}),
    )
    .await;
    let excluded_token = excluded_login["token"].as_str().unwrap();
    let body = json!({"title":"Market scan", "summary":"Q4 landscape", "body":"# Findings\nUseful detail", "kind":"research", "status":"draft", "topic":"Customers", "period":"2026 Q4", "sources":[{"title":"Example", "url":"https://example.test/brief"}]});
    let saved = ok(
        &router,
        "SaveReport",
        Some(author_token),
        json!({"report":body, "expectedRevision":0}),
    )
    .await;
    let report = &saved["report"];
    let report_id = report["id"].as_str().unwrap();
    assert_eq!(report["revision"], 1);
    assert_eq!(report["authorId"], author["member"]["id"]);
    assert_eq!(report["authorName"], "Researcher");
    assert_eq!(
        ok(
            &router,
            "GetReport",
            Some(viewer_token),
            json!({"id":report_id})
        )
        .await["report"]["body"],
        "# Findings\nUseful detail"
    );
    assert_eq!(
        rpc(
            &router,
            "SaveReport",
            Some(viewer_token),
            json!({"report":body})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        rpc(&router, "ListReports", Some(excluded_token), json!({}))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        rpc(
            &router,
            "GetReport",
            Some(excluded_token),
            json!({"id":report_id})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let agent = ok(&router, "SaveMember", Some(token), json!({"member":{"name":"Analyst agent", "kind":"agent", "role":"member", "status":"active", "access":["reports"]}})).await;
    let key = ok(
        &router,
        "CreateAgentKey",
        Some(token),
        json!({"name":"Analyst", "memberId":agent["member"]["id"], "scopes":["reports:read", "reports:write"], "expiresInDays":30}),
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
    let secret = secret.as_str();
    assert_eq!(
        service
            .agent_list_reports(secret, ListReportsRequest::default())
            .await
            .unwrap()
            .total_count,
        1
    );
    assert_eq!(
        service
            .agent_get_report(secret, report_id)
            .await
            .unwrap()
            .body,
        "# Findings\nUseful detail"
    );
    let edited = Report {
        id: report_id.into(),
        title: "Market scan updated".into(),
        summary: "Q4 landscape".into(),
        body: "# New findings".into(),
        kind: "research".into(),
        status: "published".into(),
        topic: "Customers".into(),
        period: "2026 Q4".into(),
        ..Default::default()
    };
    let saved_ai = service
        .agent_save_report(
            secret,
            SaveReportRequest {
                report: Some(edited.clone()).into(),
                expected_revision: 1,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(saved_ai.revision, 2);
    assert_eq!(saved_ai.author_id, author["member"]["id"].as_str().unwrap());
    assert_eq!(saved_ai.updated_by, "Analyst agent");
    assert!(
        service
            .agent_save_report(
                secret,
                SaveReportRequest {
                    report: Some(edited.clone()).into(),
                    expected_revision: 1,
                    ..Default::default()
                }
            )
            .await
            .is_err()
    );
    ok(&router, "SaveReport", Some(token), json!({"report":{"title":"Second report", "body":"Another body", "kind":"competitor_review", "status":"draft"}})).await;
    let list = ok(
        &router,
        "ListReports",
        Some(viewer_token),
        json!({"query":"market", "status":"published", "pageSize":1}),
    )
    .await;
    assert_eq!(list["totalCount"], 1);
    assert_eq!(list["reports"][0]["id"], report_id);
    assert!(list["reports"][0].get("body").is_none_or(|v| v == ""));
    let first = ok(&router, "ListReports", Some(token), json!({"pageSize":1})).await;
    assert_eq!(first["totalCount"], 2);
    assert_eq!(first["reports"].as_array().unwrap().len(), 1);
    assert_eq!(first["nextOffset"], 1);
    let second = ok(
        &router,
        "ListReports",
        Some(token),
        json!({"pageSize":1, "offset":1}),
    )
    .await;
    assert_ne!(first["reports"][0]["id"], second["reports"][0]["id"]);
    let period_report = ok(&router, "SaveReport", Some(token), json!({"report":{"title":"Period report", "body":"Research notes", "kind":"research", "status":"draft", "period":"2026-W43", "sources":[{"title":"Author source", "url":"HTTPS://münich.example/@writer/review"}]}})).await;
    let period_list = ok(&router, "ListReports", Some(token), json!({"query":"W43"})).await;
    assert_eq!(period_list["totalCount"], 1);
    assert_eq!(
        period_list["reports"][0]["id"],
        period_report["report"]["id"]
    );
    for url in [
        "javascript:alert(1)",
        "file:///etc/passwd",
        "/relative",
        "https://",
        "https://user:secret@example.test/report",
    ] {
        assert_eq!(rpc(&router, "SaveReport", Some(token), json!({"report":{"title":"Bad", "kind":"research", "status":"draft", "sources":[{"title":"Link", "url":url}]}})).await.0, StatusCode::BAD_REQUEST);
    }
    assert_eq!(rpc(&router, "SaveReport", Some(token), json!({"report":{"title":"Bad", "kind":"research", "status":"draft", "projectId":"missing"}})).await.0, StatusCode::BAD_REQUEST);
    let project_one = ok(
        &router,
        "SaveProject",
        Some(token),
        json!({"project":{"name":"Research project", "status":"active"}}),
    )
    .await;
    let project_two = ok(
        &router,
        "SaveProject",
        Some(token),
        json!({"project":{"name":"Other project", "status":"active"}}),
    )
    .await;
    let project_one_id = project_one["project"]["id"].as_str().unwrap();
    let project_two_id = project_two["project"]["id"].as_str().unwrap();
    let workspace = ok(&router, "GetWorkspace", Some(token), json!({})).await;
    let boards = workspace["boards"].as_array().unwrap();
    let board_one = boards
        .iter()
        .find(|b| b["projectId"] == project_one_id)
        .unwrap();
    let board_two = boards
        .iter()
        .find(|b| b["projectId"] == project_two_id)
        .unwrap();
    let task = ok(&router, "SaveTask", Some(token), json!({"task":{"projectId":project_one_id, "boardId":board_one["id"], "column":"Todo", "title":"Research task", "priority":"medium"}})).await;
    let linked = ok(&router, "SaveReport", Some(token), json!({"report":{"title":"Linked report", "kind":"research", "status":"draft", "projectId":project_one_id, "taskId":task["task"]["id"]}})).await;
    assert_eq!(rpc(&router, "SaveTask", Some(token), json!({"task":{"id":task["task"]["id"], "projectId":project_two_id, "boardId":board_two["id"], "column":"Todo", "title":"Moved research task", "priority":"medium"}})).await.0, StatusCode::BAD_REQUEST);
    let linked_id = linked["report"]["id"].as_str().unwrap().to_string();
    service.close().await.unwrap();
    drop(router);
    drop(service);

    let service = Arc::new(OfficePreviewService::open(&path).await.unwrap());
    let router = app(service.clone());
    let reopened = ok(&router, "GetReport", Some(token), json!({"id":report_id})).await;
    assert_eq!(reopened["report"]["revision"], 2);
    assert_eq!(reopened["report"]["body"], "# New findings");
    assert_eq!(reopened["report"]["updatedBy"], "Analyst agent");
    assert_eq!(
        ok(&router, "GetReport", Some(token), json!({"id":linked_id})).await["report"]["taskId"],
        task["task"]["id"]
    );
    assert!(reopened["report"]["createdAt"].is_string());
    assert_eq!(viewer["member"]["role"], "viewer");
    assert_eq!(excluded["member"]["access"][0], "projects");
    service.close().await.unwrap();
}

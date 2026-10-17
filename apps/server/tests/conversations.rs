use axum::http::StatusCode;
use http_body_util::BodyExt;
use office_server::{OfficePreviewService, proto::office::v1::*};
use serde_json::{Value, json};
use std::sync::Arc;
use tower::ServiceExt;

async fn rpc(
    service: &Arc<OfficePreviewService>,
    method: &str,
    token: &str,
    body: Value,
) -> (StatusCode, Value) {
    let app = axum::Router::new().nest_service(
        "/rpc",
        service
            .clone()
            .register(connectrpc::Router::new())
            .into_axum_service(),
    );
    let response = app
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri(format!("/rpc/office.v1.OfficeService/{method}"))
                .header("content-type", "application/json")
                .header("connect-protocol-version", "1")
                .header("authorization", format!("Bearer {token}"))
                .body(axum::body::Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
async fn ok(service: &Arc<OfficePreviewService>, method: &str, token: &str, body: Value) -> Value {
    let (status, value) = rpc(service, method, token, body).await;
    assert_eq!(status, StatusCode::OK, "{method}: {value}");
    value
}
async fn setup(service: &Arc<OfficePreviewService>) -> BootstrapAdminResponse {
    service
        .bootstrap(BootstrapAdminRequest {
            name: "Admin".into(),
            email: "admin@example.test".into(),
            password: "conversation-password-123".into(),
            workspace_name: "Office".into(),
            load_demo_data: true,
            ..Default::default()
        })
        .await
        .unwrap()
}
async fn reviewer(service: &Arc<OfficePreviewService>, token: &str) -> (String, String) {
    let saved = ok(service, "SaveMember", token, json!({"member":{"name":"Reviewer","email":"reviewer@example.test","role":"member","status":"active"},"password":"conversation-password-123"})).await;
    let login = service
        .authenticate(LoginRequest {
            email: "reviewer@example.test".into(),
            password: "conversation-password-123".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    (saved["member"]["id"].as_str().unwrap().into(), login.token)
}

#[tokio::test]
async fn project_replies_convert_once_and_preserve_bidirectional_source_links() {
    let service = Arc::new(OfficePreviewService::new());
    let admin = setup(&service).await;
    let workspace = service.workspace(&admin.token).await.unwrap();
    let project = &workspace.projects[0];
    let board = &workspace.boards[0];
    let message = ok(
        &service,
        "SaveProjectMessage",
        &admin.token,
        json!({"message":{"projectId":project.id,"body":"Please investigate this"}}),
    )
    .await["message"]
        .clone();
    assert_eq!(message["revision"], 1);
    let unchanged = ok(
        &service,
        "SaveProjectMessage",
        &admin.token,
        json!({"message":message,"expectedRevision":1}),
    )
    .await;
    assert_eq!(
        unchanged["message"]["revision"], 1,
        "unchanged text creates no new revision"
    );
    let reply = ok(
        &service,
        "SaveProjectMessage",
        &admin.token,
        json!({"message":{"projectId":project.id,"body":"A reply","parentId":message["id"]}}),
    )
    .await["message"]
        .clone();
    assert_eq!(reply["parentId"], message["id"]);
    let conversion = json!({"messageId":message["id"],"expectedRevision":1,"task":{"projectId":project.id,"boardId":board.id,"column":board.columns[0],"title":"Investigate","priority":"medium"}});
    let converted = ok(
        &service,
        "CreateTaskFromMessage",
        &admin.token,
        conversion.clone(),
    )
    .await;
    assert_eq!(converted["task"]["sourceMessageId"], message["id"]);
    assert_eq!(converted["task"]["sourceMessageRevision"], 1);
    assert_eq!(
        converted["message"]["linkedTaskId"],
        converted["task"]["id"]
    );
    let retry = ok(
        &service,
        "CreateTaskFromMessage",
        &admin.token,
        conversion.clone(),
    )
    .await;
    assert_eq!(retry["task"]["id"], converted["task"]["id"]);
    let mut changed_conversion = conversion;
    changed_conversion["task"]["title"] = json!("Different task");
    let (status, _) = rpc(
        &service,
        "CreateTaskFromMessage",
        &admin.token,
        changed_conversion,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (_, member_token) = reviewer(&service, &admin.token).await;
    let (status,_) = rpc(&service,"CreateTaskFromMessage",&member_token,json!({"messageId":reply["id"],"expectedRevision":1,"task":{"projectId":project.id,"boardId":board.id,"column":board.columns[0],"title":"Not a lead","priority":"medium"}})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let discussion = ok(
        &service,
        "ListProjectDiscussion",
        &admin.token,
        json!({"projectId":project.id}),
    )
    .await;
    assert_eq!(discussion["messages"].as_array().unwrap().len(), 2);
    let deleted = ok(
        &service,
        "DeleteProjectMessage",
        &admin.token,
        json!({"messageId":message["id"],"expectedRevision":2}),
    )
    .await;
    assert_eq!(deleted["message"]["deleted"], true);
    let discussion = ok(
        &service,
        "ListProjectDiscussion",
        &admin.token,
        json!({"projectId":project.id}),
    )
    .await;
    assert!(
        discussion["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["parentId"] == message["id"])
    );
}

#[tokio::test]
async fn exact_revision_reviews_cancel_on_edit_and_survive_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("conversations.sqlite3");
    let service = Arc::new(OfficePreviewService::open(&path).await.unwrap());
    let admin = setup(&service).await;
    let (reviewer_id, reviewer_token) = reviewer(&service, &admin.token).await;
    let reports = ok(&service, "ListReports", &admin.token, json!({})).await;
    let report_id = reports["reports"][0]["id"].clone();
    let mut report =
        ok(&service, "GetReport", &admin.token, json!({"id":report_id})).await["report"].clone();
    let workspace = service.workspace(&admin.token).await.unwrap();
    let linked_message = ok(&service,"SaveProjectMessage",&admin.token,json!({"message":{"projectId":report["projectId"],"body":"Discuss this exact edition","references":[{"kind":"report","id":report_id,"revision":1}]}})).await["message"].clone();
    let linked_reply = ok(&service,"SaveProjectMessage",&admin.token,json!({"message":{"projectId":report["projectId"],"body":"Reply keeps context","parentId":linked_message["id"],"references":[{"kind":"report","id":report_id,"revision":1}]}})).await["message"].clone();
    assert_eq!(linked_reply["references"][0]["revision"], 1);
    assert!(!workspace.projects.is_empty());
    let request = json!({"reportId":report_id,"reportRevision":1,"reviewerIds":[reviewer_id],"requestId":"first-review"});
    let review = ok(
        &service,
        "RequestReportReview",
        &admin.token,
        request.clone(),
    )
    .await["reviews"][0]
        .clone();
    assert_eq!(review["status"], "pending");
    let inbox = ok(&service, "ListNotifications", &reviewer_token, json!({})).await;
    let review_notice = inbox["notifications"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["sourceKind"] == "report_review" && n["sourceId"] == review["id"])
        .unwrap();
    let (status, _) = rpc(
        &service,
        "UpdateNotification",
        &reviewer_token,
        json!({"id":review_notice["id"],"expectedRevision":1,"action":"acknowledge"}),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "review obligation resolves only through a review decision"
    );
    let (status,_) = rpc(&service,"CreateNotification",&reviewer_token,json!({"requestId":"spoof-review","title":"Spoof","kind":"review_request","recipientIds":[reviewer_id],"sourceKind":"report_review","sourceId":review["id"],"sourceRevision":1})).await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "only actual requester can forward a review request"
    );
    let (status,_) = rpc(&service,"CreateNotification",&admin.token,json!({"requestId":"reroute-review","title":"Spoof","kind":"review_request","recipientIds":[admin.user.id],"sourceKind":"report_review","sourceId":review["id"],"sourceRevision":1})).await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "review request cannot reroute nominated reviewer"
    );

    let retry = ok(&service, "RequestReportReview", &admin.token, request).await;
    assert_eq!(retry["reviews"][0]["id"], review["id"]);
    let (status, _) = rpc(
        &service,
        "DecideReportReview",
        &admin.token,
        json!({"reviewId":review["id"],"expectedRevision":1,"status":"approved"}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let approved = ok(&service,"DecideReportReview",&reviewer_token,json!({"reviewId":review["id"],"expectedRevision":1,"status":"approved","note":"Checked sources"})).await;
    assert_eq!(approved["review"]["status"], "approved");
    report["body"] = json!("A changed revision");
    ok(
        &service,
        "SaveReport",
        &admin.token,
        json!({"report":report,"expectedRevision":1}),
    )
    .await;
    let review2 = ok(&service,"RequestReportReview",&admin.token,json!({"reportId":report_id,"reportRevision":2,"reviewerIds":[reviewer_id],"requestId":"second-review"})).await["reviews"][0].clone();
    report["body"] = json!("A third revision");
    ok(
        &service,
        "SaveReport",
        &admin.token,
        json!({"report":report,"expectedRevision":2}),
    )
    .await;
    let reviews = ok(
        &service,
        "ListReportReviews",
        &admin.token,
        json!({"reportId":report_id}),
    )
    .await;
    assert!(
        reviews["reviews"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["id"] == review2["id"] && r["status"] == "cancelled")
    );
    service.close().await.unwrap();
    drop(service);
    let service = Arc::new(OfficePreviewService::open(&path).await.unwrap());
    let discussion = ok(
        &service,
        "ListProjectDiscussion",
        &admin.token,
        json!({"projectId":report["projectId"]}),
    )
    .await;
    let reply = discussion["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == linked_reply["id"])
        .unwrap();
    assert_eq!(reply["references"][0]["revision"], 1);
    assert_eq!(reply["parentId"], linked_message["id"]);
    let old = ok(
        &service,
        "GetReport",
        &admin.token,
        json!({"id":report_id,"revision":1}),
    )
    .await;
    assert_ne!(old["report"]["body"], "A changed revision");
    let reviews = ok(
        &service,
        "ListReportReviews",
        &admin.token,
        json!({"reportId":report_id}),
    )
    .await;
    assert!(
        reviews["reviews"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["id"] == review["id"] && r["status"] == "approved")
    );
    service.close().await.unwrap();
}

#[tokio::test]
async fn mentions_are_not_response_requests_and_invalid_links_are_atomic() {
    let service = Arc::new(OfficePreviewService::new());
    let admin = setup(&service).await;
    let (member_id, member_token) = reviewer(&service, &admin.token).await;
    let workspace = service.workspace(&admin.token).await.unwrap();
    let task = &workspace.tasks[0];
    ok(
        &service,
        "SaveTaskComment",
        &admin.token,
        json!({"taskId":task.id,"body":"An ordinary mention","mentionIds":[member_id]}),
    )
    .await;
    let inbox = ok(&service, "ListNotifications", &member_token, json!({})).await;
    assert!(
        inbox["notifications"]
            .as_array()
            .unwrap()
            .iter()
            .all(|n| n["kind"] != "response_request")
    );
    let saved = ok(
        &service,
        "SaveTaskComment",
        &admin.token,
        json!({"taskId":task.id,"body":"Please respond","responseRecipientIds":[member_id]}),
    )
    .await;
    let inbox = ok(&service, "ListNotifications", &member_token, json!({})).await;
    assert_eq!(
        inbox["notifications"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|n| n["kind"] == "response_request")
            .count(),
        1
    );
    assert_eq!(
        inbox["notifications"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["kind"] == "response_request")
            .unwrap()["sourceId"],
        saved["comment"]["id"]
    );
    ok(&service, "SaveTaskComment", &admin.token, json!({"taskId":task.id,"commentId":saved["comment"]["id"],"expectedRevision":1,"body":"Edited request wording","responseRecipientIds":[member_id]})).await;
    let inbox = ok(&service, "ListNotifications", &member_token, json!({})).await;
    assert_eq!(
        inbox["notifications"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|n| n["kind"] == "response_request")
            .count(),
        1,
        "body edits must not request work again"
    );
    let reports = ok(
        &service,
        "ListReports",
        &admin.token,
        json!({"projectId":task.project_id}),
    )
    .await;
    let reply = ok(&service,"SaveTaskComment",&admin.token,json!({"taskId":task.id,"body":"Threaded reply","parentId":saved["comment"]["id"],"references":[{"kind":"report","id":reports["reports"][0]["id"],"revision":1}]})).await;
    ok(
        &service,
        "DeleteTaskComment",
        &admin.token,
        json!({"taskId":task.id,"commentId":saved["comment"]["id"],"expectedRevision":2}),
    )
    .await;
    let discussion = ok(
        &service,
        "ListTaskDiscussion",
        &admin.token,
        json!({"taskId":task.id}),
    )
    .await;
    assert!(
        discussion["comments"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["id"] == reply["comment"]["id"]
                && c["parentId"] == saved["comment"]["id"]
                && c["references"][0]["revision"] == 1)
    );
    let (status, _) = rpc(
        &service,
        "SaveTaskComment",
        &admin.token,
        json!({"taskId":task.id,"body":"Invalid","mentionIds":["missing"]}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status,_) = rpc(&service,"SaveTaskComment",&admin.token,json!({"taskId":task.id,"body":"Invalid","references":[{"kind":"report","id":"missing","revision":1}]})).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn stable_mentions_reject_disabled_recipients_and_cross_project_references() {
    let service = Arc::new(OfficePreviewService::new());
    let admin = setup(&service).await;
    let (member_id, member_token) = reviewer(&service, &admin.token).await;
    let workspace = service.workspace(&admin.token).await.unwrap();
    let project = &workspace.projects[0];
    let task = &workspace.tasks[0];
    let saved = ok(&service,"SaveTaskComment",&admin.token,json!({"taskId":task.id,"body":"Question","mentionIds":[member_id,member_id],"responseRecipientIds":[member_id,member_id]})).await;
    let mut member = workspace
        .members
        .iter()
        .find(|m| m.id == member_id)
        .cloned();
    if member.is_none() {
        member = service
            .workspace(&admin.token)
            .await
            .unwrap()
            .members
            .into_iter()
            .find(|m| m.id == member_id);
    }
    let mut member = serde_json::to_value(member.unwrap()).unwrap();
    member["name"] = json!("Renamed");
    ok(
        &service,
        "SaveMember",
        &admin.token,
        json!({"member":member}),
    )
    .await;
    let discussion = ok(
        &service,
        "ListTaskDiscussion",
        &admin.token,
        json!({"taskId":task.id}),
    )
    .await;
    assert!(
        discussion["comments"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["id"] == saved["comment"]["id"] && c["mentionIds"][0] == member_id)
    );
    let inbox = ok(&service, "ListNotifications", &member_token, json!({})).await;
    assert_eq!(
        inbox["notifications"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|n| n["kind"] == "response_request")
            .count(),
        1
    );
    assert_eq!(
        inbox["notifications"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|n| n["kind"] == "notice")
            .count(),
        1,
        "duplicate mentions fan out once"
    );
    let before = ok(
        &service,
        "ListProjectDiscussion",
        &admin.token,
        json!({"projectId":project.id}),
    )
    .await;
    let (status,_) = rpc(&service,"SaveProjectMessage",&admin.token,json!({"message":{"projectId":project.id,"body":"Atomic fanout","responseRecipientIds":[member_id,"missing"]}})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let after = ok(
        &service,
        "ListProjectDiscussion",
        &admin.token,
        json!({"projectId":project.id}),
    )
    .await;
    assert_eq!(before, after, "failed fanout leaves no message");
    member["status"] = json!("inactive");
    ok(
        &service,
        "SaveMember",
        &admin.token,
        json!({"member":member}),
    )
    .await;
    let (status,_) = rpc(&service,"SaveProjectMessage",&admin.token,json!({"message":{"projectId":project.id,"body":"Disabled recipient","responseRecipientIds":[member_id]}})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let other = ok(
        &service,
        "SaveProject",
        &admin.token,
        json!({"project":{"name":"Other","status":"active"}}),
    )
    .await["project"]
        .clone();
    let report = ok(&service,"SaveReport",&admin.token,json!({"report":{"title":"Other findings","kind":"research","status":"draft","projectId":other["id"]}})).await["report"].clone();
    let (status,_) = rpc(&service,"SaveProjectMessage",&admin.token,json!({"message":{"projectId":project.id,"body":"Cross project","references":[{"kind":"report","id":report["id"],"revision":1}]}})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status,_) = rpc(&service,"RequestReportReview",&admin.token,json!({"reportId":report["id"],"reportRevision":1,"reviewerIds":[admin.user.id],"requestId":"self"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn source_resolution_preserves_deleted_reply_context_and_notification_privacy() {
    let service = Arc::new(OfficePreviewService::new());
    let admin = setup(&service).await;
    let (member_id, member_token) = reviewer(&service, &admin.token).await;
    ok(&service,"SaveMember",&admin.token,json!({"member":{"name":"Outsider","email":"outsider@example.test","role":"viewer","status":"active"},"password":"conversation-password-123"})).await;
    let outsider = service
        .authenticate(LoginRequest {
            email: "outsider@example.test".into(),
            password: "conversation-password-123".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    let workspace = service.workspace(&admin.token).await.unwrap();
    let task = &workspace.tasks[0];
    let parent = ok(
        &service,
        "SaveTaskComment",
        &admin.token,
        json!({"taskId":task.id,"body":"A source","responseRecipientIds":[member_id]}),
    )
    .await["comment"]
        .clone();
    let reply = ok(
        &service,
        "SaveTaskComment",
        &member_token,
        json!({"taskId":task.id,"body":"A reply","parentId":parent["id"]}),
    )
    .await["comment"]
        .clone();
    ok(
        &service,
        "DeleteTaskComment",
        &admin.token,
        json!({"taskId":task.id,"commentId":parent["id"],"expectedRevision":1}),
    )
    .await;
    for (comment, revision) in [(&parent, 1), (&parent, 2), (&reply, 1)] {
        let source = ok(
            &service,
            "ResolveSource",
            &outsider.token,
            json!({"kind":"task_comment","id":comment["id"],"revision":revision}),
        )
        .await;
        assert_eq!(source["taskId"], task.id);
        assert_eq!(source["projectId"], task.project_id);
        assert_eq!(source["revision"], revision);
        assert!(
            source.get("body").is_none(),
            "navigation context must not expose source body"
        );
    }
    let (status, _) = rpc(
        &service,
        "ResolveSource",
        &member_token,
        json!({"kind":"task_comment","id":parent["id"],"revision":99}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let inbox = ok(&service, "ListNotifications", &member_token, json!({})).await;
    let notice = inbox["notifications"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["kind"] == "response_request")
        .unwrap();
    let source = ok(
        &service,
        "ResolveSource",
        &member_token,
        json!({"kind":"notification","id":notice["id"]}),
    )
    .await;
    assert_eq!(source["kind"], "task_comment");
    assert_eq!(source["revision"], 1);
    assert_eq!(source["taskId"], task.id);
    let (status, _) = rpc(
        &service,
        "ResolveSource",
        &outsider.token,
        json!({"kind":"notification","id":notice["id"]}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = rpc(
        &service,
        "ResolveSource",
        &outsider.token,
        json!({"kind":"task","id":task.id,"revision":1}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn response_results_require_authorship_and_source_project_context() {
    let service = Arc::new(OfficePreviewService::new());
    let admin = setup(&service).await;
    let (member_id, member_token) = reviewer(&service, &admin.token).await;
    let workspace = service.workspace(&admin.token).await.unwrap();
    let task = &workspace.tasks[0];
    let source = ok(
        &service,
        "SaveTaskComment",
        &admin.token,
        json!({"taskId":task.id,"body":"Please answer","responseRecipientIds":[member_id]}),
    )
    .await["comment"]
        .clone();
    let inbox = ok(&service, "ListNotifications", &member_token, json!({})).await;
    let notification = inbox["notifications"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["kind"] == "response_request")
        .unwrap();
    let (status,_) = rpc(&service,"UpdateNotification",&member_token,json!({"id":notification["id"],"expectedRevision":1,"action":"acknowledge","resultKind":"task_comment","resultId":source["id"],"resultRevision":1})).await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "another author's comment is not the recipient's answer"
    );
    let other = ok(
        &service,
        "SaveProject",
        &admin.token,
        json!({"project":{"name":"Other project","status":"active"}}),
    )
    .await["project"]
        .clone();
    let report=ok(&service,"SaveReport",&member_token,json!({"report":{"title":"Unrelated output","kind":"research","status":"draft","projectId":other["id"]}})).await["report"].clone();
    let (status,_) = rpc(&service,"UpdateNotification",&member_token,json!({"id":notification["id"],"expectedRevision":1,"action":"acknowledge","resultKind":"report","resultId":report["id"],"resultRevision":1})).await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "an answer cannot point into another project"
    );
    let reply = ok(
        &service,
        "SaveTaskComment",
        &member_token,
        json!({"taskId":task.id,"body":"The requested answer","parentId":source["id"]}),
    )
    .await["comment"]
        .clone();
    let acknowledged=ok(&service,"UpdateNotification",&member_token,json!({"id":notification["id"],"expectedRevision":1,"action":"acknowledge","resultKind":"task_comment","resultId":reply["id"],"resultRevision":1})).await["notification"].clone();
    assert_eq!(acknowledged["status"], "acknowledged");
    assert_eq!(acknowledged["resultId"], reply["id"]);
    ok(
        &service,
        "DeleteTaskComment",
        &member_token,
        json!({"taskId":task.id,"commentId":reply["id"],"expectedRevision":1}),
    )
    .await;
    let retry=ok(&service,"UpdateNotification",&member_token,json!({"id":notification["id"],"expectedRevision":1,"action":"acknowledge","resultKind":"task_comment","resultId":reply["id"],"resultRevision":1})).await;
    assert_eq!(
        retry["notification"]["revision"], acknowledged["revision"],
        "safe retry uses retained exact answer even after deletion"
    );
}

#[tokio::test]
async fn nominated_reviewer_cannot_approve_a_revision_they_edited() {
    let service = Arc::new(OfficePreviewService::new());
    let admin = setup(&service).await;
    let (member_id, member_token) = reviewer(&service, &admin.token).await;
    let reports = ok(&service, "ListReports", &admin.token, json!({})).await;
    let mut report = ok(
        &service,
        "GetReport",
        &admin.token,
        json!({"id":reports["reports"][0]["id"]}),
    )
    .await["report"]
        .clone();
    report["body"] = json!("Written by the proposed reviewer");
    let report = ok(
        &service,
        "SaveReport",
        &member_token,
        json!({"report":report,"expectedRevision":1}),
    )
    .await["report"]
        .clone();
    assert_ne!(
        report["authorId"], member_id,
        "original authorship stays with the report creator"
    );
    let (status,_) = rpc(&service,"RequestReportReview",&admin.token,json!({"reportId":report["id"],"reportRevision":2,"reviewerIds":[member_id],"requestId":"editor-self-review"})).await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "exact revision editor must not review their own work"
    );
    let reviews = ok(
        &service,
        "ListReportReviews",
        &admin.token,
        json!({"reportId":report["id"]}),
    )
    .await;
    assert!(
        reviews
            .get("reviews")
            .is_none_or(|r| r.as_array().unwrap().is_empty())
    );
}

#[tokio::test]
async fn removed_recipients_and_deleted_conversations_cancel_attention_once() {
    let service = Arc::new(OfficePreviewService::new());
    let admin = setup(&service).await;
    let (member_id, member_token) = reviewer(&service, &admin.token).await;
    let workspace = service.workspace(&admin.token).await.unwrap();
    let task = &workspace.tasks[0];
    let comment=ok(&service,"SaveTaskComment",&admin.token,json!({"taskId":task.id,"body":"A request","mentionIds":[member_id],"responseRecipientIds":[member_id]})).await["comment"].clone();
    let inbox = ok(&service, "ListNotifications", &member_token, json!({})).await;
    let automatic = inbox["notifications"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["kind"] == "response_request")
        .unwrap()
        .clone();
    let mention = inbox["notifications"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["kind"] == "notice")
        .unwrap()
        .clone();
    let manual=ok(&service,"CreateNotification",&admin.token,json!({"requestId":"manual-comment-request","title":"Another question","kind":"response_request","recipientIds":[member_id],"sourceKind":"task_comment","sourceId":comment["id"],"sourceRevision":1})).await["notifications"][0].clone();
    ok(
        &service,
        "UpdateNotification",
        &member_token,
        json!({"id":automatic["id"],"expectedRevision":1,"action":"claim","claimId":"one-attempt"}),
    )
    .await;
    let edited=ok(&service,"SaveTaskComment",&admin.token,json!({"taskId":task.id,"commentId":comment["id"],"expectedRevision":1,"body":"No longer requesting a response","mentionIds":[member_id]})).await["comment"].clone();
    let inbox = ok(&service, "ListNotifications", &member_token, json!({})).await;
    let states = inbox["notifications"].as_array().unwrap();
    let cancelled = states.iter().find(|n| n["id"] == automatic["id"]).unwrap();
    assert_eq!(cancelled["status"], "cancelled");
    assert_eq!(cancelled["revision"], 3);
    assert_eq!(
        states.iter().find(|n| n["id"] == manual["id"]).unwrap()["status"],
        "pending",
        "recipient edits preserve separately sent requests"
    );
    assert_eq!(
        states.iter().find(|n| n["id"] == mention["id"]).unwrap()["status"],
        "pending"
    );
    ok(&service,"SaveTaskComment",&admin.token,json!({"taskId":task.id,"commentId":comment["id"],"expectedRevision":2,"body":edited["body"],"mentionIds":[member_id]})).await;
    let feedback = ok(
        &service,
        "ListActivity",
        &admin.token,
        json!({"sourceKind":"notification","sourceId":automatic["id"]}),
    )
    .await;
    assert_eq!(
        feedback["entries"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["kind"] == "notification_cancel")
            .count(),
        1,
        "sender sees exactly one cancellation feedback"
    );
    ok(
        &service,
        "DeleteTaskComment",
        &admin.token,
        json!({"taskId":task.id,"commentId":comment["id"],"expectedRevision":2}),
    )
    .await;
    let inbox = ok(&service, "ListNotifications", &member_token, json!({})).await;
    assert!(
        inbox["notifications"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|n| n["sourceId"] == comment["id"])
            .all(|n| n["status"] == "cancelled")
    );
    let message=ok(&service,"SaveProjectMessage",&admin.token,json!({"message":{"projectId":task.project_id,"body":"A project request","responseRecipientIds":[member_id]}})).await["message"].clone();
    let inbox = ok(&service, "ListNotifications", &member_token, json!({})).await;
    let request = inbox["notifications"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["sourceId"] == message["id"])
        .unwrap()
        .clone();
    ok(&service,"UpdateNotification",&member_token,json!({"id":request["id"],"expectedRevision":1,"action":"claim","claimId":"project-attempt"})).await;
    ok(
        &service,
        "DeleteProjectMessage",
        &admin.token,
        json!({"messageId":message["id"],"expectedRevision":1}),
    )
    .await;
    let inbox = ok(&service, "ListNotifications", &member_token, json!({})).await;
    assert_eq!(
        inbox["notifications"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["id"] == request["id"])
            .unwrap()["status"],
        "cancelled"
    );
    let (status,_) = rpc(&service,"UpdateNotification",&member_token,json!({"id":request["id"],"expectedRevision":1,"action":"claim","claimId":"project-attempt"})).await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "cancelled source cannot be claimed again"
    );
    let history = ok(&service, "PollNotifications", &member_token, json!({})).await;
    assert_eq!(
        history["notifications"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|n| n["id"] == request["id"] && n["revision"] == 1)
            .count(),
        1,
        "only one original explicit request exists"
    );
}

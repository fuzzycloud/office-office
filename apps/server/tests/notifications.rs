use connectrpc::ErrorCode;
use office_server::{EngineCommand, EngineOutcome, OfficePreviewService, proto::office::v1::*};

async fn admin(service: &OfficePreviewService) -> BootstrapAdminResponse {
    service
        .bootstrap(BootstrapAdminRequest {
            name: "Admin".into(),
            email: "admin@example.test".into(),
            password: "notification-password-123".into(),
            workspace_name: "Office".into(),
            ..Default::default()
        })
        .await
        .unwrap()
}
async fn member(
    service: &OfficePreviewService,
    admin: &str,
    name: &str,
    role: &str,
) -> (Member, String) {
    let email = format!("{name}@example.test");
    let EngineOutcome::Member(saved) = service
        .execute(
            admin,
            EngineCommand::SaveMember(SaveMemberRequest {
                member: Some(Member {
                    name: name.into(),
                    email: email.clone(),
                    role: role.into(),
                    status: "active".into(),
                    ..Default::default()
                })
                .into(),
                password: "notification-password-123".into(),
                ..Default::default()
            }),
        )
        .await
        .unwrap()
    else {
        panic!("wrong outcome")
    };
    let login = service
        .authenticate(LoginRequest {
            email,
            password: "notification-password-123".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    (saved.member.unwrap(), login.token)
}
fn create(request_id: &str, recipients: &[&str]) -> CreateNotificationRequest {
    CreateNotificationRequest {
        request_id: request_id.into(),
        title: "Review the findings".into(),
        body: "Private details".into(),
        kind: "review_request".into(),
        recipient_ids: recipients.iter().map(|s| (*s).into()).collect(),
        ..Default::default()
    }
}
fn update(n: &Notification, action: &str, claim_id: &str) -> UpdateNotificationRequest {
    UpdateNotificationRequest {
        id: n.id.clone(),
        expected_revision: n.revision,
        action: action.into(),
        claim_id: claim_id.into(),
        ..Default::default()
    }
}
async fn poll(
    service: &OfficePreviewService,
    token: &str,
    cursor: &str,
    size: u32,
) -> PollNotificationsResponse {
    service
        .poll_notifications(
            token,
            PollNotificationsRequest {
                after_cursor: cursor.into(),
                page_size: size,
                ..Default::default()
            },
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn cursors_replay_every_snapshot_after_offline_and_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("notifications.sqlite3");
    let service = OfficePreviewService::open(&path).await.unwrap();
    let admin = admin(&service).await;
    let (reader, token) = member(&service, &admin.token, "reader", "viewer").await;
    assert_eq!(poll(&service, &token, "", 1).await.next_cursor, "0");
    let n = service
        .create_notification(&admin.token, create("first", &[&reader.id]))
        .await
        .unwrap()
        .notifications
        .remove(0);
    service
        .create_notification(&admin.token, create("hidden", &[&admin.user.id]))
        .await
        .unwrap();
    let first = poll(&service, &token, "0", 1).await;
    assert_eq!(first.notifications[0].revision, 1);
    assert!(!first.has_more);
    assert_eq!(first.next_cursor, "2");
    assert_eq!(first.notifications[0].read_at, 0);
    let read = service
        .update_notification(&token, update(&n, "read", ""))
        .await
        .unwrap()
        .notification
        .unwrap();
    assert_eq!(read.status, "pending");
    assert!(read.read_at > 0);
    let acknowledged = service
        .update_notification(&token, update(&read, "acknowledge", ""))
        .await
        .unwrap()
        .notification
        .unwrap();
    assert_eq!(acknowledged.status, "acknowledged");
    let offline = poll(&service, &token, "0", 1).await;
    assert!(offline.has_more);
    assert_eq!(offline.next_cursor, "1");
    let second = poll(&service, &token, &offline.next_cursor, 1).await;
    assert_eq!(second.notifications[0].revision, 2);
    assert!(second.has_more);
    assert_eq!(second.next_cursor, "3");
    let last = poll(&service, &token, &second.next_cursor, 1).await;
    assert_eq!(last.notifications[0].revision, 3);
    assert_eq!(last.next_cursor, "4");
    assert!(!last.has_more);
    assert!(
        poll(&service, &token, "4", 1)
            .await
            .notifications
            .is_empty()
    );
    for cursor in ["-1", "1x", "+1", "5", "18446744073709551616"] {
        assert_eq!(
            service
                .poll_notifications(
                    &token,
                    PollNotificationsRequest {
                        after_cursor: cursor.into(),
                        ..Default::default()
                    }
                )
                .await
                .unwrap_err()
                .code,
            ErrorCode::InvalidArgument
        );
    }
    service.close().await.unwrap();
    drop(service);
    let service = OfficePreviewService::open(&path).await.unwrap();
    let replay = poll(&service, &token, "0", 100).await;
    assert_eq!(replay.notifications.len(), 3);
    assert_eq!(replay.notifications[0].status, "pending");
    assert_eq!(replay.notifications[2].status, "acknowledged");
    assert_eq!(replay.next_cursor, "4");
    let retry = service
        .create_notification(&admin.token, create("first", &[&reader.id]))
        .await
        .unwrap();
    assert_eq!(retry.notifications[0].id, n.id);
    assert_eq!(poll(&service, &token, "4", 100).await.next_cursor, "4");
    service.close().await.unwrap();
}

#[tokio::test]
async fn visibility_is_personal_and_viewers_can_handle_their_inbox() {
    let service = OfficePreviewService::new();
    let admin = admin(&service).await;
    let (sender, sender_token) = member(&service, &admin.token, "sender", "member").await;
    let (reader, reader_token) = member(&service, &admin.token, "reader", "viewer").await;
    let n = service
        .create_notification(&sender_token, create("private", &[&reader.id]))
        .await
        .unwrap()
        .notifications
        .remove(0);
    assert_eq!(n.sender_id, sender.id);
    assert_eq!(n.updated_by, sender.id);
    assert!(
        poll(&service, &sender_token, "0", 100)
            .await
            .notifications
            .is_empty()
    );
    assert!(
        poll(&service, &admin.token, "0", 100)
            .await
            .notifications
            .is_empty()
    );
    for token in [&sender_token, &admin.token] {
        assert_eq!(
            service
                .list_notifications(token, ListNotificationsRequest::default())
                .await
                .unwrap()
                .total_count,
            0
        );
    }
    assert_eq!(
        service
            .list_notifications(
                &sender_token,
                ListNotificationsRequest {
                    scope: "sent".into(),
                    ..Default::default()
                }
            )
            .await
            .unwrap()
            .total_count,
        1
    );
    assert_eq!(
        service
            .list_notifications(
                &admin.token,
                ListNotificationsRequest {
                    scope: "all".into(),
                    ..Default::default()
                }
            )
            .await
            .unwrap()
            .total_count,
        1
    );
    assert_eq!(
        service
            .list_notifications(
                &reader_token,
                ListNotificationsRequest {
                    scope: "all".into(),
                    ..Default::default()
                }
            )
            .await
            .unwrap_err()
            .code,
        ErrorCode::PermissionDenied
    );
    assert_eq!(
        service
            .create_notification(&reader_token, create("denied", &[&sender.id]))
            .await
            .unwrap_err()
            .code,
        ErrorCode::PermissionDenied
    );
    assert_eq!(
        service
            .update_notification(&sender_token, update(&n, "acknowledge", ""))
            .await
            .unwrap_err()
            .code,
        ErrorCode::PermissionDenied
    );
    let ack = service
        .update_notification(&reader_token, update(&n, "acknowledge", ""))
        .await
        .unwrap()
        .notification
        .unwrap();
    assert_eq!(ack.status, "acknowledged");
    assert_eq!(ack.updated_by, reader.id);
    assert_eq!(
        service
            .update_notification(&reader_token, update(&n, "acknowledge", ""))
            .await
            .unwrap()
            .notification
            .unwrap()
            .revision,
        2
    );
    assert!(
        service
            .workspace(&admin.token)
            .await
            .unwrap()
            .activity
            .iter()
            .all(|a| !a.summary.contains("Private details"))
    );
}

#[tokio::test]
async fn fanout_is_atomic_and_idempotent_payloads_are_bound_to_sender() {
    let service = OfficePreviewService::new();
    let admin = admin(&service).await;
    let (reader, token) = member(&service, &admin.token, "reader", "member").await;
    assert!(
        service
            .create_notification(&admin.token, create("invalid", &[&reader.id, "missing"]))
            .await
            .is_err()
    );
    assert_eq!(poll(&service, &token, "0", 100).await.next_cursor, "0");
    let request = create("dedup", &[&reader.id, &reader.id]);
    let n = service
        .create_notification(&admin.token, request.clone())
        .await
        .unwrap();
    assert_eq!(n.notifications.len(), 1);
    let retry = service
        .create_notification(&admin.token, request.clone())
        .await
        .unwrap();
    assert_eq!(n.notifications[0].id, retry.notifications[0].id);
    let mut changed = request;
    changed.body.push('!');
    assert_eq!(
        service
            .create_notification(&admin.token, changed)
            .await
            .unwrap_err()
            .code,
        ErrorCode::AlreadyExists
    );
    let mut missing_source = create("bad-source", &[&reader.id]);
    missing_source.source_kind = "task".into();
    missing_source.source_id = "missing".into();
    assert!(
        service
            .create_notification(&admin.token, missing_source)
            .await
            .is_err()
    );
    assert_eq!(poll(&service, &token, "0", 100).await.next_cursor, "1");
    let own = service
        .create_notification(&token, create("dedup", &[&reader.id]))
        .await
        .unwrap();
    assert_ne!(own.notifications[0].id, n.notifications[0].id);
}

#[tokio::test]
async fn atomic_claims_revision_conflicts_and_retry_do_not_duplicate_work() {
    let service = OfficePreviewService::new();
    let admin = admin(&service).await;
    let (reader, token) = member(&service, &admin.token, "worker", "member").await;
    let n = service
        .create_notification(&admin.token, create("work", &[&reader.id]))
        .await
        .unwrap()
        .notifications
        .remove(0);
    let (a, b) = tokio::join!(
        service.update_notification(&token, update(&n, "claim", "run-a")),
        service.update_notification(&token, update(&n, "claim", "run-b"))
    );
    assert!(a.is_ok());
    assert_eq!(b.unwrap_err().code, ErrorCode::Aborted);
    let claimed = a.unwrap().notification.unwrap();
    assert_eq!(claimed.status, "claimed");
    assert_eq!(
        service
            .update_notification(&token, update(&n, "claim", "run-a"))
            .await
            .unwrap()
            .notification
            .unwrap()
            .revision,
        2
    );
    assert_eq!(
        service
            .update_notification(&token, update(&n, "read", ""))
            .await
            .unwrap_err()
            .code,
        ErrorCode::Aborted
    );
    assert_eq!(
        service
            .update_notification(&token, update(&claimed, "acknowledge", "run-b"))
            .await
            .unwrap_err()
            .code,
        ErrorCode::Aborted
    );
    assert_eq!(
        service
            .update_notification(&token, update(&claimed, "acknowledge", ""))
            .await
            .unwrap_err()
            .code,
        ErrorCode::Aborted
    );
    let ack = service
        .update_notification(&token, update(&claimed, "acknowledge", "run-a"))
        .await
        .unwrap()
        .notification
        .unwrap();
    assert_eq!(ack.status, "acknowledged");
    assert_eq!(
        service
            .update_notification(&token, update(&claimed, "acknowledge", "run-a"))
            .await
            .unwrap()
            .notification
            .unwrap()
            .revision,
        3
    );
    assert_eq!(
        poll(&service, &token, "0", 100).await.notifications.len(),
        3
    );
}

async fn rpc(
    service: std::sync::Arc<OfficePreviewService>,
    method: &str,
    token: &str,
    body: serde_json::Value,
) -> (axum::http::StatusCode, serde_json::Value) {
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    let app = axum::Router::new().nest_service(
        "/rpc",
        service
            .register(connectrpc::Router::new())
            .into_axum_service(),
    );
    let request = axum::http::Request::builder()
        .method("POST")
        .uri(format!("/rpc/office.v1.OfficeService/{method}"))
        .header("content-type", "application/json")
        .header("connect-protocol-version", "1")
        .header("authorization", format!("Bearer {token}"))
        .body(axum::body::Body::from(body.to_string()))
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn rpc_adapters_and_live_key_member_revocation_protect_notifications() {
    use axum::http::StatusCode;
    use serde_json::json;
    let service = std::sync::Arc::new(OfficePreviewService::new());
    let admin = admin(&service).await;
    let EngineOutcome::Member(saved) = service
        .execute(
            &admin.token,
            EngineCommand::SaveMember(SaveMemberRequest {
                member: Some(Member {
                    name: "Agent".into(),
                    kind: "agent".into(),
                    role: "viewer".into(),
                    status: "active".into(),
                    ..Default::default()
                })
                .into(),
                ..Default::default()
            }),
        )
        .await
        .unwrap()
    else {
        panic!("wrong outcome")
    };
    let agent = saved.member.unwrap();
    let secret = saved.secret;
    let key = saved.agent_key.unwrap();
    let session = service.exchange_agent_key(&secret).await.unwrap();
    let (status, response) = rpc(
        service.clone(),
        "CreateNotification",
        &admin.token,
        json!({"requestId":"rpc", "title":"Review", "recipientIds":[agent.id]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let n = &response["notifications"][0];
    let (status, response) = rpc(
        service.clone(),
        "ListNotifications",
        &session.token,
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(response["totalCount"], 1);
    let (status, response) = rpc(
        service.clone(),
        "PollNotifications",
        &session.token,
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(response["notifications"][0]["status"], "pending");
    let (status, response) = rpc(
        service.clone(),
        "UpdateNotification",
        &session.token,
        json!({"id":n["id"], "expectedRevision":1,"action":"acknowledge"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(response["notification"]["status"], "acknowledged");
    let (status, _) = rpc(
        service.clone(),
        "RevokeAgentKey",
        &admin.token,
        json!({"id":key.id}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        service
            .poll_notifications(&session.token, PollNotificationsRequest::default())
            .await
            .unwrap_err()
            .code,
        ErrorCode::Unauthenticated
    );
    let rotated = service
        .rotate_agent_key(&admin.token, &agent.id)
        .await
        .unwrap();
    let session = service.exchange_agent_key(&rotated.secret).await.unwrap();
    let mut disabled = agent;
    disabled.status = "inactive".into();
    service
        .execute(
            &admin.token,
            EngineCommand::SaveMember(SaveMemberRequest {
                member: Some(disabled).into(),
                ..Default::default()
            }),
        )
        .await
        .unwrap();
    assert_eq!(
        service
            .list_notifications(&session.token, ListNotificationsRequest::default())
            .await
            .unwrap_err()
            .code,
        ErrorCode::Unauthenticated
    );
    assert_eq!(
        service
            .update_notification(
                &session.token,
                UpdateNotificationRequest {
                    id: n["id"].as_str().unwrap().into(),
                    action: "read".into(),
                    expected_revision: 2,
                    ..Default::default()
                }
            )
            .await
            .unwrap_err()
            .code,
        ErrorCode::Unauthenticated
    );
}

#[tokio::test]
async fn claimed_work_survives_restart_until_explicit_dismissal_or_cancellation() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("claimed.sqlite3");
    let service = OfficePreviewService::open(&path).await.unwrap();
    let admin = admin(&service).await;
    let (reader, token) = member(&service, &admin.token, "worker", "member").await;
    let claimed = service
        .create_notification(&admin.token, create("claim", &[&reader.id]))
        .await
        .unwrap()
        .notifications
        .remove(0);
    let claimed = service
        .update_notification(&token, update(&claimed, "claim", "uncertain-run"))
        .await
        .unwrap()
        .notification
        .unwrap();
    let cancel = service
        .create_notification(&admin.token, create("cancel", &[&reader.id]))
        .await
        .unwrap()
        .notifications
        .remove(0);
    service.close().await.unwrap();
    drop(service);
    let service = OfficePreviewService::open(&path).await.unwrap();
    let inbox = service
        .list_notifications(
            &token,
            ListNotificationsRequest {
                page_size: 1,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(inbox.total_count, 2);
    assert_eq!(inbox.notifications[0].id, cancel.id);
    assert_eq!(inbox.next_offset, 1);
    let second = service
        .list_notifications(
            &token,
            ListNotificationsRequest {
                offset: inbox.next_offset,
                page_size: 1,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(second.notifications[0].status, "claimed");
    assert_eq!(second.notifications[0].claim_id, "uncertain-run");
    let dismissed = service
        .update_notification(&token, update(&claimed, "dismiss", ""))
        .await
        .unwrap()
        .notification
        .unwrap();
    assert_eq!(dismissed.status, "dismissed");
    assert_eq!(
        service
            .update_notification(&token, update(&cancel, "cancel", ""))
            .await
            .unwrap_err()
            .code,
        ErrorCode::PermissionDenied
    );
    let cancelled = service
        .update_notification(&admin.token, update(&cancel, "cancel", ""))
        .await
        .unwrap()
        .notification
        .unwrap();
    assert_eq!(cancelled.status, "cancelled");
    assert_eq!(
        service
            .update_notification(&admin.token, update(&cancel, "cancel", ""))
            .await
            .unwrap()
            .notification
            .unwrap()
            .revision,
        2
    );
    assert_eq!(
        service
            .update_notification(&token, update(&cancelled, "claim", "new-run"))
            .await
            .unwrap_err()
            .code,
        ErrorCode::Aborted
    );
    service.close().await.unwrap();
}

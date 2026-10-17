use office_server::{EngineCommand, EngineOutcome, OfficePreviewService, proto::office::v1::*};

#[tokio::test]
async fn assigning_a_new_task_notifies_its_agent_once() {
    let service = OfficePreviewService::new();
    let admin = service
        .bootstrap(BootstrapAdminRequest {
            name: "Admin".into(),
            email: "admin@example.test".into(),
            password: "attention-password-123".into(),
            workspace_name: "Attention".into(),
            load_demo_data: false,
            ..Default::default()
        })
        .await
        .unwrap();
    let EngineOutcome::Member(saved) = service
        .execute(
            &admin.token,
            EngineCommand::SaveMember(SaveMemberRequest {
                member: Some(Member {
                    name: "Researcher".into(),
                    kind: "agent".into(),
                    role: "member".into(),
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
    let session = service.exchange_agent_key(&saved.secret).await.unwrap();
    let EngineOutcome::Project(project) = service
        .execute(
            &admin.token,
            EngineCommand::SaveProject(SaveProjectRequest {
                project: Some(Project {
                    name: "Research".into(),
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
    let project = project.project.unwrap();
    let workspace = service.workspace(&admin.token).await.unwrap();
    let board = workspace
        .boards
        .iter()
        .find(|b| b.project_id == project.id)
        .unwrap();
    let EngineOutcome::Task(saved) = service
        .execute(
            &admin.token,
            EngineCommand::SaveTask(SaveTaskRequest {
                task: Some(Task {
                    project_id: project.id,
                    board_id: board.id.clone(),
                    column: board.columns[0].clone(),
                    title: "Investigate customer requests".into(),
                    assignee_id: agent.id.clone(),
                    priority: "medium".into(),
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
    let task = saved.task.unwrap();
    let first = service
        .poll_notifications(&session.token, PollNotificationsRequest::default())
        .await
        .unwrap();
    assert_eq!(
        first.notifications.len(),
        1,
        "new assignment must reach the assignee through existing polling"
    );
    let notice = &first.notifications[0];
    assert_eq!(notice.kind, "work_request");
    assert_eq!(notice.source_kind, "task");
    assert_eq!(notice.source_id, task.id);
    assert_eq!(notice.sender_id, admin.user.id);
    assert_eq!(notice.recipient_id, agent.id);
    service
        .execute(
            &admin.token,
            EngineCommand::SaveTask(SaveTaskRequest {
                task: Some(task).into(),
                ..Default::default()
            }),
        )
        .await
        .unwrap();
    let retry = service
        .poll_notifications(
            &session.token,
            PollNotificationsRequest {
                after_cursor: first.next_cursor,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(
        retry.notifications.is_empty(),
        "saving an unchanged assignment must not notify twice"
    );
    let before_reserved = feed(&service, &admin.token, "", 100).await;
    for prefix in [
        "task_comment:",
        "project_message:",
        "task-assignment:",
        "review:",
    ] {
        assert_eq!(
            service
                .create_notification(
                    &admin.token,
                    CreateNotificationRequest {
                        request_id: format!("{prefix}manual"),
                        title: "Do not impersonate an automatic workflow".into(),
                        kind: "response_request".into(),
                        recipient_ids: vec![agent.id.clone()],
                        ..Default::default()
                    }
                )
                .await
                .unwrap_err()
                .code,
            connectrpc::ErrorCode::InvalidArgument
        );
    }
    assert_eq!(feed(&service, &admin.token, "", 100).await, before_reserved);
    assert!(
        service
            .poll_notifications(
                &session.token,
                PollNotificationsRequest {
                    after_cursor: retry.next_cursor,
                    ..Default::default()
                }
            )
            .await
            .unwrap()
            .notifications
            .is_empty()
    );
}

async fn bootstrap(service: &OfficePreviewService) -> BootstrapAdminResponse {
    service
        .bootstrap(BootstrapAdminRequest {
            name: "Shared name".into(),
            email: "admin@example.test".into(),
            password: "attention-password-123".into(),
            workspace_name: "Attention".into(),
            ..Default::default()
        })
        .await
        .unwrap()
}
async fn agent(service: &OfficePreviewService, token: &str) -> (Member, String) {
    let EngineOutcome::Member(saved) = service
        .execute(
            token,
            EngineCommand::SaveMember(SaveMemberRequest {
                member: Some(Member {
                    name: "Shared name".into(),
                    kind: "agent".into(),
                    role: "member".into(),
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
    let session = service.exchange_agent_key(&saved.secret).await.unwrap();
    (saved.member.unwrap(), session.token)
}
async fn project_task(service: &OfficePreviewService, token: &str, assignee: &str) -> Task {
    let EngineOutcome::Project(saved) = service
        .execute(
            token,
            EngineCommand::SaveProject(SaveProjectRequest {
                project: Some(Project {
                    name: "Shared work".into(),
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
    let project = saved.project.unwrap();
    let workspace = service.workspace(token).await.unwrap();
    let board = workspace
        .boards
        .iter()
        .find(|b| b.project_id == project.id)
        .unwrap();
    let EngineOutcome::Task(saved) = service
        .execute(
            token,
            EngineCommand::SaveTask(SaveTaskRequest {
                task: Some(Task {
                    project_id: project.id,
                    board_id: board.id.clone(),
                    column: board.columns[0].clone(),
                    title: "Visible business change".into(),
                    assignee_id: assignee.into(),
                    priority: "medium".into(),
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
    saved.task.unwrap()
}
async fn feed(
    service: &OfficePreviewService,
    token: &str,
    cursor: &str,
    size: u32,
) -> PollActivityResponse {
    service
        .poll_activity(
            token,
            PollActivityRequest {
                after_cursor: cursor.into(),
                page_size: size,
                ..Default::default()
            },
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn feed_identity_private_feedback_and_assignment_reconciliation_survive_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("activity.sqlite3");
    let service = OfficePreviewService::open(&path).await.unwrap();
    let admin = bootstrap(&service).await;
    let (assigned, assigned_token) = agent(&service, &admin.token).await;
    let (other, other_token) = agent(&service, &admin.token).await;
    let mut task = project_task(&service, &admin.token, &assigned.id).await;
    let initial = feed(&service, &admin.token, "", 100).await;
    let task_entry = initial
        .entries
        .iter()
        .find(|v| v.source_kind == "task" && v.source_id == task.id)
        .unwrap();
    assert_eq!(
        task_entry.actor_id, admin.user.id,
        "duplicate display names must not select an actor"
    );
    assert_eq!(task_entry.actor_kind, "human");
    assert!(initial.next_cursor.starts_with("activity:v1:"));
    let member_feed = feed(&service, &assigned_token, "", 100).await;
    assert!(
        !member_feed.entries.iter().any(|v| v.admin_only),
        "security administration must not enter member feeds"
    );
    assert!(
        service
            .workspace(&other_token)
            .await
            .unwrap()
            .activity
            .is_empty(),
        "legacy unstructured security history is Admin-only"
    );
    let outsider_feed = feed(&service, &other_token, "", 100).await;
    assert!(
        !outsider_feed
            .entries
            .iter()
            .any(|v| v.source_kind == "notification")
    );
    let notification = service
        .poll_notifications(&assigned_token, PollNotificationsRequest::default())
        .await
        .unwrap()
        .notifications
        .remove(0);
    let read = service
        .update_notification(
            &assigned_token,
            UpdateNotificationRequest {
                id: notification.id,
                expected_revision: 1,
                action: "read".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .notification
        .unwrap();
    assert_eq!(
        read.status, "pending",
        "read is independent from unresolved attention"
    );
    let claimed = service
        .update_notification(
            &assigned_token,
            UpdateNotificationRequest {
                id: read.id.clone(),
                expected_revision: read.revision,
                action: "claim".into(),
                claim_id: "attempt-1".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .notification
        .unwrap();
    let feedback = feed(&service, &admin.token, &initial.next_cursor, 1).await;
    assert_eq!(feedback.entries[0].kind, "notification_read");
    assert_eq!(feedback.entries[0].actor_id, assigned.id);
    assert!(feedback.has_more);
    let claim_feedback = feed(&service, &admin.token, &feedback.next_cursor, 100).await;
    assert_eq!(claim_feedback.entries[0].kind, "notification_claim");
    let project_feedback = service
        .list_activity(
            &admin.token,
            ListActivityRequest {
                module: "projects".into(),
                project_id: task.project_id.clone(),
                source_kind: "notification".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        project_feedback.total_count, 3,
        "created/read/claim feedback belongs to the source project"
    );
    assert!(
        feed(&service, &other_token, &initial.next_cursor, 100)
            .await
            .entries
            .is_empty()
    );
    let before_retry = feed(&service, &admin.token, "", 100).await.next_cursor;
    service
        .update_notification(
            &assigned_token,
            UpdateNotificationRequest {
                id: claimed.id.clone(),
                expected_revision: read.revision,
                action: "claim".into(),
                claim_id: "attempt-1".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    service
        .execute(
            &admin.token,
            EngineCommand::SaveTask(SaveTaskRequest {
                task: Some(task.clone()).into(),
                ..Default::default()
            }),
        )
        .await
        .unwrap();
    assert_eq!(
        feed(&service, &admin.token, "", 100).await.next_cursor,
        before_retry,
        "no-op retries must not append feed events"
    );
    task.assignee_id = other.id.clone();
    let EngineOutcome::Task(saved) = service
        .execute(
            &admin.token,
            EngineCommand::SaveTask(SaveTaskRequest {
                task: Some(task).into(),
                ..Default::default()
            }),
        )
        .await
        .unwrap()
    else {
        panic!("wrong outcome")
    };
    let mut task = saved.task.unwrap();
    let old = service
        .list_notifications(&assigned_token, ListNotificationsRequest::default())
        .await
        .unwrap();
    assert_eq!(
        old.notifications[0].status, "cancelled",
        "reassignment cancels even claimed old work"
    );
    assert_eq!(
        service
            .list_notifications(&other_token, ListNotificationsRequest::default())
            .await
            .unwrap()
            .notifications[0]
            .status,
        "pending"
    );
    task.assignee_id.clear();
    service
        .execute(
            &admin.token,
            EngineCommand::SaveTask(SaveTaskRequest {
                task: Some(task).into(),
                ..Default::default()
            }),
        )
        .await
        .unwrap();
    assert_eq!(
        service
            .list_notifications(&other_token, ListNotificationsRequest::default())
            .await
            .unwrap()
            .notifications[0]
            .status,
        "cancelled"
    );
    for cursor in [
        "0",
        "activity:v2:0",
        "activity:v1:-1",
        "activity:v1:999999",
        "activity:v1:18446744073709551616",
    ] {
        assert_eq!(
            service
                .poll_activity(
                    &admin.token,
                    PollActivityRequest {
                        after_cursor: cursor.into(),
                        ..Default::default()
                    }
                )
                .await
                .unwrap_err()
                .code,
            connectrpc::ErrorCode::InvalidArgument
        );
    }
    assert_eq!(
        service
            .poll_notifications(
                &assigned_token,
                PollNotificationsRequest {
                    after_cursor: initial.next_cursor,
                    ..Default::default()
                }
            )
            .await
            .unwrap_err()
            .code,
        connectrpc::ErrorCode::InvalidArgument
    );
    let before_restart = feed(&service, &admin.token, "", 100).await;
    service.close().await.unwrap();
    drop(service);
    let service = OfficePreviewService::open(&path).await.unwrap();
    let replay = feed(&service, &admin.token, "", 100).await;
    assert_eq!(replay, before_restart);
    let old_poll = service
        .poll_notifications(&assigned_token, PollNotificationsRequest::default())
        .await
        .unwrap();
    assert_eq!(
        old_poll.notifications[0].status, "pending",
        "old notification cursor still replays immutable snapshots"
    );
    assert_eq!(old_poll.notifications.last().unwrap().status, "cancelled");
    service.close().await.unwrap();
}

#[tokio::test]
async fn failed_durable_feed_append_rolls_back_records_notifications_and_cursors() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("rollback.sqlite3");
    let service = OfficePreviewService::open(&path).await.unwrap();
    let admin = bootstrap(&service).await;
    let (assigned, assigned_token) = agent(&service, &admin.token).await;
    let task = project_task(&service, &admin.token, "").await;
    let before = feed(&service, &admin.token, "", 100).await;
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TRIGGER reject_feed BEFORE INSERT ON events WHEN NEW.event_type='feed_entry' BEGIN SELECT RAISE(ABORT, 'test feed write failure'); END;").unwrap();
    let mut assigned_task = task.clone();
    assigned_task.assignee_id = assigned.id.clone();
    assert_eq!(
        service
            .execute(
                &admin.token,
                EngineCommand::SaveTask(SaveTaskRequest {
                    task: Some(assigned_task.clone()).into(),
                    ..Default::default()
                })
            )
            .await
            .err()
            .unwrap()
            .code,
        connectrpc::ErrorCode::Internal
    );
    assert_eq!(
        service.workspace(&admin.token).await.unwrap().tasks[0],
        task
    );
    assert_eq!(feed(&service, &admin.token, "", 100).await, before);
    assert!(
        service
            .poll_notifications(&assigned_token, PollNotificationsRequest::default())
            .await
            .unwrap()
            .notifications
            .is_empty()
    );
    conn.execute_batch("DROP TRIGGER reject_feed;").unwrap();
    service
        .execute(
            &admin.token,
            EngineCommand::SaveTask(SaveTaskRequest {
                task: Some(assigned_task).into(),
                ..Default::default()
            }),
        )
        .await
        .unwrap();
    let after = feed(&service, &admin.token, "", 100).await;
    assert_ne!(after.next_cursor, before.next_cursor);
    service.close().await.unwrap();
    drop(service);
    let service = OfficePreviewService::open(&path).await.unwrap();
    assert_eq!(feed(&service, &admin.token, "", 100).await, after);
    assert_eq!(
        service
            .poll_notifications(&assigned_token, PollNotificationsRequest::default())
            .await
            .unwrap()
            .notifications
            .len(),
        1
    );
    service.close().await.unwrap();
}

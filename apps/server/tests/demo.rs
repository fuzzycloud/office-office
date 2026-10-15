use connectrpc::ErrorCode;
use office_server::{
    EngineCommand, EngineOutcome, OfficePreviewService,
    proto::office::v1::{
        BootstrapAdminRequest, Customer, LoginRequest, Member, SaveCustomerRequest,
        SaveMemberRequest,
    },
};

fn registration(load_demo_data: bool) -> BootstrapAdminRequest {
    BootstrapAdminRequest {
        name: "Scenario Admin".into(),
        email: "admin@example.test".into(),
        password: "scenario-password-123".into(),
        workspace_name: "Scenario Office".into(),
        load_demo_data,
        ..Default::default()
    }
}

#[tokio::test]
async fn opted_in_scenario_runs_commands_and_replays_generated_records() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("scenario.sqlite3");
    let service = OfficePreviewService::open(&path).await.unwrap();
    let admin = service.bootstrap(registration(true)).await.unwrap();
    let workspace = service.workspace(&admin.token).await.unwrap();
    assert!(workspace.demo_mode);
    assert!(workspace.persistent_storage);
    assert_eq!(workspace.customers.len(), 3);
    assert_eq!(workspace.projects.len(), 3);
    assert_eq!(workspace.boards.len(), 4);
    assert_eq!(workspace.tasks.len(), 10);
    assert_eq!(workspace.posts.len(), 3);
    assert!(
        workspace
            .members
            .iter()
            .any(|member| member.name.contains("(sample)") && member.status == "pending")
    );
    for id in workspace
        .customers
        .iter()
        .map(|item| &item.id)
        .chain(workspace.projects.iter().map(|item| &item.id))
        .chain(workspace.boards.iter().map(|item| &item.id))
        .chain(workspace.tasks.iter().map(|item| &item.id))
    {
        assert!(
            uuid::Uuid::parse_str(id).is_ok(),
            "scenario must use normal generated record IDs"
        );
    }
    assert!(
        workspace
            .connections
            .iter()
            .all(|channel| channel.demo && channel.status == "disconnected")
    );
    assert!(workspace.posts.iter().all(|post| post.status == "draft"));
    let sample_task = workspace
        .tasks
        .iter()
        .find(|task| task.title == "Sample task — plan launch")
        .unwrap();
    assert_eq!(sample_task.comment_count, 3);
    let discussion = service
        .task_discussion(&admin.token, &sample_task.id)
        .await
        .unwrap();
    assert_eq!(discussion.comments.len(), 3);
    assert!(
        discussion
            .comments
            .iter()
            .all(|comment| comment.body.starts_with("Sample comment:"))
    );
    assert!(
        workspace
            .tasks
            .iter()
            .any(|task| task.assignee_id.is_empty())
    );
    assert!(workspace.tasks.iter().any(|task| task.due_date.is_empty()));
    let db = rusqlite::Connection::open(&path).unwrap();
    let mut statement = db
        .prepare("SELECT DISTINCT event_type FROM events ORDER BY event_type")
        .unwrap();
    let kinds: Vec<String> = statement
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    for kind in [
        "demo_initialized",
        "member",
        "customer",
        "project",
        "board",
        "task",
        "task_comment",
        "task_activity",
        "report",
        "connection",
        "post",
        "activity",
    ] {
        assert!(
            kinds.iter().any(|value| value == kind),
            "missing command-produced {kind} event"
        );
    }
    assert_eq!(
        db.query_row::<i64, _, _>("SELECT count(*) FROM passwords", [], |row| row.get(0))
            .unwrap(),
        1,
        "sample teammates must not receive shared demo passwords"
    );
    let count: i64 = db
        .query_row("SELECT count(*) FROM events", [], |row| row.get(0))
        .unwrap();
    drop(statement);
    drop(db);
    let customer_id = workspace.customers[0].id.clone();
    service.close().await.unwrap();
    drop(service);

    let service = OfficePreviewService::open(&path).await.unwrap();
    let workspace = service.workspace(&admin.token).await.unwrap();
    assert!(workspace.demo_mode && workspace.persistent_storage);
    assert_eq!(workspace.customers[0].id, customer_id);
    let duplicate = service.bootstrap(registration(true)).await;
    assert!(matches!(duplicate, Err(error) if error.code == ErrorCode::AlreadyExists));
    let db = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        db.query_row::<i64, _, _>("SELECT count(*) FROM events", [], |row| row.get(0))
            .unwrap(),
        count
    );
    drop(db);
    service.close().await.unwrap();
}

#[tokio::test]
async fn direct_typed_and_json_commands_keep_validation_permissions_and_events() {
    let service = OfficePreviewService::new();
    let admin = service.bootstrap(registration(false)).await.unwrap();
    let workspace = service.workspace(&admin.token).await.unwrap();
    assert!(!workspace.demo_mode && !workspace.persistent_storage);
    assert!(workspace.customers.is_empty());
    assert!(workspace.projects.is_empty());
    // No HTTP server or API client: this DTO enters the same actor pipeline.
    let command: EngineCommand = serde_json::from_value(serde_json::json!({
        "type":"save_customer", "data":{"customer":{
            "name":"Scenario Contact", "company":"Scenario Studio", "email":"contact@example.test", "status":"active"
        }}
    })).unwrap();
    let EngineOutcome::Customer(created) = service.execute(&admin.token, command).await.unwrap()
    else {
        panic!("wrong command outcome")
    };
    let customer_id = created.customer.unwrap().id;
    let before = service
        .workspace(&admin.token)
        .await
        .unwrap()
        .activity
        .len();
    let invalid = service
        .execute(
            &admin.token,
            EngineCommand::SaveCustomer(SaveCustomerRequest {
                customer: Some(Customer {
                    name: "".into(),
                    company: "Invalid".into(),
                    status: "active".into(),
                    ..Default::default()
                })
                .into(),
                ..Default::default()
            }),
        )
        .await;
    assert!(matches!(invalid, Err(error) if error.code == ErrorCode::InvalidArgument));
    assert_eq!(
        service
            .workspace(&admin.token)
            .await
            .unwrap()
            .activity
            .len(),
        before
    );
    let EngineOutcome::Member(_) = service
        .execute(
            &admin.token,
            EngineCommand::SaveMember(SaveMemberRequest {
                member: Some(Member {
                    name: "Scenario Viewer".into(),
                    email: "viewer@example.test".into(),
                    role: "viewer".into(),
                    status: "active".into(),
                    access: vec!["customers".into()],
                    ..Default::default()
                })
                .into(),
                password: "scenario-viewer-password-123".into(),
                ..Default::default()
            }),
        )
        .await
        .unwrap()
    else {
        panic!("wrong command outcome")
    };
    let viewer = service
        .authenticate(LoginRequest {
            email: "viewer@example.test".into(),
            password: "scenario-viewer-password-123".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    let forbidden = service
        .execute(
            &viewer.token,
            EngineCommand::SaveCustomer(SaveCustomerRequest {
                customer: Some(Customer {
                    id: customer_id.clone(),
                    name: "Forbidden change".into(),
                    company: "Scenario Studio".into(),
                    status: "active".into(),
                    ..Default::default()
                })
                .into(),
                ..Default::default()
            }),
        )
        .await;
    assert!(matches!(forbidden, Err(error) if error.code == ErrorCode::PermissionDenied));
    assert_eq!(
        service.workspace(&viewer.token).await.unwrap().customers[0].name,
        "Scenario Contact"
    );
    let channel = service
        .execute(
            &admin.token,
            EngineCommand::CreateSampleSocialChannel {
                platform: "Test".into(),
                name: "Sample channel".into(),
            },
        )
        .await;
    assert!(matches!(channel, Err(error) if error.code == ErrorCode::PermissionDenied));
    service.close().await.unwrap();
}

#[tokio::test]
async fn failed_scenario_rolls_back_bootstrap_records_and_demo_marker() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("rollback.sqlite3");
    let service = OfficePreviewService::open(&path).await.unwrap();
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("CREATE TRIGGER reject_scenario BEFORE INSERT ON events WHEN NEW.event_type = 'post' BEGIN SELECT RAISE(ABORT, 'scenario fault'); END;").unwrap();
    assert!(service.bootstrap(registration(true)).await.is_err());
    assert_eq!(
        db.query_row::<i64, _, _>("SELECT count(*) FROM events", [], |row| row.get(0))
            .unwrap(),
        0
    );
    assert_eq!(
        db.query_row::<i64, _, _>("SELECT count(*) FROM passwords", [], |row| row.get(0))
            .unwrap(),
        0
    );
    assert_eq!(
        db.query_row::<i64, _, _>("SELECT setup FROM private_config WHERE id=1", [], |row| row
            .get(0))
            .unwrap(),
        0
    );
    drop(db);
    let admin = service.bootstrap(registration(false)).await.unwrap();
    let workspace = service.workspace(&admin.token).await.unwrap();
    assert!(!workspace.demo_mode);
    assert_eq!(workspace.members.len(), 1);
    assert!(
        workspace.customers.is_empty()
            && workspace.projects.is_empty()
            && workspace.tasks.is_empty()
    );
    service.close().await.unwrap();
}

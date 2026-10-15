use std::sync::Arc;

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use connectrpc::Router as ConnectRouter;
use http_body_util::BodyExt;
use office_server::{
    EngineCommand, EngineOutcome, OfficePreviewService,
    proto::office::v1::{OfficeServiceExt, SaveProfileRequest},
};
use serde_json::{Value, json};
use tower::ServiceExt;

fn make_app(service: Arc<OfficePreviewService>) -> Router {
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

async fn bootstrap(app: &Router) -> Value {
    ok(
        app,
        "BootstrapAdmin",
        None,
        json!({
            "name":"Admin", "email":"admin@example.test",
            "password":"admin-password-123", "workspaceName":"Office"
        }),
    )
    .await
}

#[tokio::test]
async fn all_active_roles_can_edit_only_their_own_profile() {
    let service = Arc::new(OfficePreviewService::new());
    let app = make_app(service.clone());
    let admin = bootstrap(&app).await;
    let admin_token = admin["token"].as_str().unwrap();
    let admin_id = admin["user"]["id"].as_str().unwrap();
    assert_eq!(
        rpc(&app, "SaveProfile", None, json!({"bio":"anonymous"}))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );

    for role in ["admin", "manager", "member", "viewer"] {
        let name = format!("{role} user");
        let email = format!("profile-{role}@example.test");
        let created = ok(
            &app,
            "SaveMember",
            Some(admin_token),
            json!({
                "member":{"name":name,"email":email,"role":role,"status":"active"},
                "password":"profile-password-123"
            }),
        )
        .await;
        let member_id = created["member"]["id"].as_str().unwrap();
        let login = ok(
            &app,
            "Login",
            None,
            json!({
                "email":email,"password":"profile-password-123"
            }),
        )
        .await;
        let token = login["token"].as_str().unwrap();
        let bio = format!("Profile for {role} 🌿");
        let avatar_url = format!("https://images.example.test/{role}.png");
        let saved = ok(
            &app,
            "SaveProfile",
            Some(token),
            json!({
                "bio":bio,"avatarUrl":avatar_url
            }),
        )
        .await;
        assert_eq!(saved["member"]["id"], member_id);
        assert_eq!(saved["member"]["bio"], bio);
        assert_eq!(saved["member"]["avatarUrl"], avatar_url);
        assert_eq!(saved["member"]["role"], role);
        assert_eq!(saved["member"]["status"], "active");
        assert_eq!(saved["member"]["name"], name);
        assert_eq!(saved["member"]["email"], email);
        assert_eq!(
            rpc(
                &app,
                "SaveMember",
                Some(token),
                json!({
                    "member":{"id":admin_id,"name":"Changed","role":"viewer","status":"inactive"}
                })
            )
            .await
            .0,
            if role == "admin" {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::FORBIDDEN
            }
        );
        if role == "viewer" {
            ok(
                &app,
                "SaveMember",
                Some(admin_token),
                json!({"member":{
                    "id":member_id,"name":name,"email":email,
                    "role":"viewer","status":"inactive"
                }}),
            )
            .await;
            assert_eq!(
                rpc(&app, "SaveProfile", Some(token), json!({"bio":"too late"}))
                    .await
                    .0,
                StatusCode::UNAUTHORIZED
            );
        }
    }

    let agent = ok(
        &app,
        "SaveMember",
        Some(admin_token),
        json!({
            "member":{"name":"Profile agent","kind":"agent","role":"viewer","status":"active"}
        }),
    )
    .await;
    let secret = agent["secret"].as_str().unwrap();
    let key_id = agent["agentKey"]["id"].as_str().unwrap();
    let exchanged = ok(&app, "ExchangeAgentKey", None, json!({"key":secret})).await;
    let agent_token = exchanged["token"].as_str().unwrap();
    let saved = ok(
        &app,
        "SaveProfile",
        Some(agent_token),
        json!({
            "bio":"Agent biography","avatarUrl":"https://images.example.test/agent.png"
        }),
    )
    .await;
    assert_eq!(saved["member"]["id"], agent["member"]["id"]);
    assert_eq!(saved["member"]["kind"], "agent");
    assert_eq!(saved["member"]["role"], "viewer");
    assert_eq!(saved["member"]["status"], "active");
    let keys = ok(&app, "ListAgentKeys", Some(admin_token), json!({})).await;
    assert!(
        keys["keys"]
            .as_array()
            .unwrap()
            .iter()
            .any(|key| key["id"] == key_id)
    );
    let reexchanged = ok(&app, "ExchangeAgentKey", None, json!({"key":secret})).await;
    assert_eq!(reexchanged["user"]["bio"], "Agent biography");

    let workspace = ok(&app, "GetWorkspace", Some(admin_token), json!({})).await;
    assert!(
        workspace["members"]
            .as_array()
            .unwrap()
            .iter()
            .any(|member| {
                member["id"] == agent["member"]["id"] && member["bio"] == "Agent biography"
            })
    );
    assert!(
        workspace["activity"]
            .as_array()
            .unwrap()
            .iter()
            .any(|activity| {
                activity["actorName"] == "Profile agent"
                    && activity["summary"] == "Member profile saved"
            })
    );
}

#[tokio::test]
async fn profile_validation_applies_to_self_and_admin_edits() {
    let service = Arc::new(OfficePreviewService::new());
    let app = make_app(service.clone());
    let admin = bootstrap(&app).await;
    let token = admin["token"].as_str().unwrap();
    let admin_id = admin["user"]["id"].as_str().unwrap();
    for (bio, avatar_url) in [
        ("x".repeat(2001), String::new()),
        (
            String::new(),
            format!("https://example.test/{}", "x".repeat(2048)),
        ),
        (String::new(), "http://example.test/avatar.png".into()),
        (
            String::new(),
            "https://user:secret@example.test/avatar.png".into(),
        ),
        (String::new(), "https://example.test/avatar\\path".into()),
    ] {
        assert_eq!(
            rpc(
                &app,
                "SaveProfile",
                Some(token),
                json!({
                    "bio":bio,"avatarUrl":avatar_url
                })
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            rpc(
                &app,
                "SaveMember",
                Some(token),
                json!({
                    "member":{"id":admin_id,"name":"Admin","email":"admin@example.test",
                        "role":"admin","status":"active","bio":bio,"avatarUrl":avatar_url}
                })
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    let bio = "界".repeat(666) + "a" + "b";
    assert_eq!(bio.len(), 2000);
    let saved = ok(&app, "SaveProfile", Some(token), json!({"bio":bio})).await;
    assert_eq!(saved["member"]["bio"], bio);
    assert_eq!(saved["member"]["avatarUrl"].as_str().unwrap_or(""), "");
    let cleared = ok(&app, "SaveProfile", Some(token), json!({})).await;
    assert_eq!(cleared["member"]["bio"].as_str().unwrap_or(""), "");
    assert_eq!(cleared["member"]["avatarUrl"].as_str().unwrap_or(""), "");
}

#[tokio::test]
async fn typed_profile_command_uses_the_same_persisted_event_path_and_legacy_events_replay() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("office.sqlite3");
    let service = Arc::new(OfficePreviewService::open(&path).await.unwrap());
    let app = make_app(service.clone());
    let admin = bootstrap(&app).await;
    let token = admin["token"].as_str().unwrap().to_owned();
    let admin_id = admin["user"]["id"].as_str().unwrap().to_owned();
    let command: EngineCommand = serde_json::from_value(json!({
        "type":"save_profile", "data":{"bio":"Typed command","avatarUrl":"https://example.test/a.png"}
    }))
    .unwrap();
    let EngineOutcome::Profile(saved) = service.execute(&token, command).await.unwrap() else {
        panic!("expected profile outcome");
    };
    assert_eq!(saved.member.unwrap().bio, "Typed command");
    service.close().await.unwrap();
    drop(app);
    drop(service);

    let conn = rusqlite::Connection::open(&path).unwrap();
    let payload: String = conn
        .query_row(
            "SELECT payload FROM events WHERE event_type = 'member' ORDER BY sequence LIMIT 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let mut legacy: Value = serde_json::from_str(&payload).unwrap();
    legacy.as_object_mut().unwrap().remove("bio");
    legacy.as_object_mut().unwrap().remove("avatar_url");
    legacy.as_object_mut().unwrap().remove("avatarUrl");
    conn.execute(
        "UPDATE events SET payload = ?1 WHERE event_type = 'member' AND sequence = (SELECT MIN(sequence) FROM events WHERE event_type = 'member')",
        [legacy.to_string()],
    )
    .unwrap();
    drop(conn);

    let service = Arc::new(OfficePreviewService::open(&path).await.unwrap());
    let app = make_app(service.clone());
    let workspace = ok(&app, "GetWorkspace", Some(&token), json!({})).await;
    let member = workspace["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == admin_id)
        .unwrap();
    assert_eq!(member["bio"], "Typed command");
    assert_eq!(member["avatarUrl"], "https://example.test/a.png");
    let EngineOutcome::Profile(cleared) = service
        .execute(
            &token,
            EngineCommand::SaveProfile(SaveProfileRequest::default()),
        )
        .await
        .unwrap()
    else {
        panic!("expected profile outcome");
    };
    assert!(cleared.member.unwrap().bio.is_empty());
    service.close().await.unwrap();
    drop(app);
    drop(service);

    let service = Arc::new(OfficePreviewService::open(&path).await.unwrap());
    let app = make_app(service.clone());
    let workspace = ok(&app, "GetWorkspace", Some(&token), json!({})).await;
    let member = workspace["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == admin_id)
        .unwrap();
    assert_eq!(member["bio"].as_str().unwrap_or(""), "");
    assert_eq!(member["avatarUrl"].as_str().unwrap_or(""), "");
    service.close().await.unwrap();
}

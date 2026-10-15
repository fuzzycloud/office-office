use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use connectrpc::Router as ConnectRouter;
use http_body_util::BodyExt;
use office_server::{OfficePreviewService, proto::office::v1::OfficeServiceExt};
use serde_json::{Value, json};
use std::sync::Arc;
use tower::ServiceExt;

fn app() -> Router {
    Router::new().nest_service(
        "/rpc",
        Arc::new(OfficePreviewService::new())
            .register(ConnectRouter::new())
            .into_axum_service(),
    )
}
async fn rpc(app: Router, method: &str, token: Option<&str>, body: Value) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method("POST")
        .uri(format!("/rpc/office.v1.OfficeService/{method}"))
        .header("content-type", "application/json")
        .header("connect-protocol-version", "1");
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let response = app
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
        app.clone(),
        "BootstrapAdmin",
        None,
        json!({
            "name":"Preview Admin", "email":"admin@example.test",
            "password":"sample-password-123", "workspaceName":"Preview Office",
            "loadDemoData":true
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["token"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn setup_auth_and_preview_records_through_rpc() {
    let app = app();
    let (status, setup) = rpc(app.clone(), "GetSetupStatus", None, json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(setup["needsSetup"], true);
    assert_eq!(setup["demoMode"], true);
    assert_eq!(
        rpc(app.clone(), "GetWorkspace", None, json!({})).await.0,
        StatusCode::UNAUTHORIZED
    );
    let token = bootstrap(&app).await;
    let (_, setup) = rpc(app.clone(), "GetSetupStatus", None, json!({})).await;
    assert!(!setup["needsSetup"].as_bool().unwrap_or(false));
    let (status, workspace) = rpc(app.clone(), "GetWorkspace", Some(&token), json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(workspace["demoMode"], true);
    let sample_member = workspace["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|member| member["name"] == "Maya Rao (sample)")
        .unwrap();
    assert!(
        sample_member["email"]
            .as_str()
            .unwrap()
            .ends_with("@example.test")
    );
    assert_eq!(sample_member["status"], "pending");
    let connection_id = workspace["connections"][0]["id"].as_str().unwrap();
    assert_eq!(workspace["connections"][0]["demo"], true);
    let (status, customer) = rpc(
        app.clone(),
        "SaveCustomer",
        Some(&token),
        json!({"customer":{
            "name":"New Customer", "company":"Sample Co", "email":"person@example.test",
            "status":"active", "notes":"preview only"
        }}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{customer}");
    assert!(customer["customer"]["id"].as_str().unwrap().len() > 10);
    let customer_id = customer["customer"]["id"].as_str().unwrap();
    let (status, project) = rpc(app.clone(), "SaveProject", Some(&token), json!({
        "project": {"name":"Preview launch", "customerId":customer_id, "status":"on_hold", "targetDate":"2026-12-31"}
    })).await;
    assert_eq!(status, StatusCode::OK, "{project}");
    assert_eq!(project["project"]["status"], "on_hold");
    let (status, post) = rpc(app.clone(), "SavePost", Some(&token), json!({
        "post": {"connectionId":connection_id, "content":"Sample scheduled post", "status":"queued", "scheduledAt":"2026-12-31T09:00:00Z"}
    })).await;
    assert_eq!(status, StatusCode::OK, "{post}");
    assert_eq!(post["post"]["status"], "queued");
    let (status, settings) = rpc(app.clone(), "SaveSettings", Some(&token), json!({
        "settings": {"workspaceName":"Preview Office", "defaultTheme":"nord", "timezone":"Asia/Kolkata"}
    })).await;
    assert_eq!(status, StatusCode::OK, "{settings}");
    assert_eq!(settings["settings"]["defaultTheme"], "nord");
    let (status, invalid_date) = rpc(
        app.clone(),
        "SaveProject",
        Some(&token),
        json!({
            "project": {"name":"Invalid date", "status":"active", "targetDate":"2026-99-99"}
        }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{invalid_date}");
    let (status, invalid) = rpc(
        app.clone(),
        "SavePost",
        Some(&token),
        json!({"post":{
            "connectionId":connection_id, "content":"Would publish", "status":"published"
        }}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{invalid}");
    assert_eq!(
        rpc(
            app.clone(),
            "SaveProject",
            Some(&token),
            json!({"project":{"name":"Invalid link","status":"active","customerId":"missing","targetDate":"2026-02-30"}})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let (status, login) = rpc(
        app.clone(),
        "Login",
        None,
        json!({"email":"admin@example.test","password":"sample-password-123"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{login}");
}

#[tokio::test]
async fn concurrent_bootstrap_only_creates_one_admin() {
    let app = app();
    let a = rpc(
        app.clone(),
        "BootstrapAdmin",
        None,
        json!({"name":"A","email":"a@example.test","password":"password12345","workspaceName":"Office"}),
    );
    let b = rpc(
        app.clone(),
        "BootstrapAdmin",
        None,
        json!({"name":"B","email":"b@example.test","password":"password12345","workspaceName":"Office"}),
    );
    let (a, b) = tokio::join!(a, b);
    assert_eq!(
        [a.0, b.0].iter().filter(|s| **s == StatusCode::OK).count(),
        1
    );
    let token = if a.0 == StatusCode::OK {
        a.1["token"].as_str().unwrap()
    } else {
        b.1["token"].as_str().unwrap()
    };
    let (_, state) = rpc(app, "GetWorkspace", Some(token), json!({})).await;
    assert_eq!(state["members"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn current_role_permissions_are_checked_after_jwt_issue() {
    let app = app();
    let admin = bootstrap(&app).await;
    let (status, member) = rpc(app.clone(), "SaveMember", Some(&admin), json!({
        "member":{"name":"Worker","email":"worker@example.test","role":"member","status":"active","access":["customers"]},
        "password":"temporary-pass-123"
    })).await;
    assert_eq!(status, StatusCode::OK, "{member}");
    let member_id = member["member"]["id"].as_str().unwrap();
    let (_, login) = rpc(
        app.clone(),
        "Login",
        None,
        json!({"email":"worker@example.test","password":"temporary-pass-123"}),
    )
    .await;
    let worker = login["token"].as_str().unwrap();
    let (_, workspace) = rpc(app.clone(), "GetWorkspace", Some(worker), json!({})).await;
    assert!(!workspace["customers"].as_array().unwrap().is_empty());
    assert!(!workspace["projects"].as_array().unwrap().is_empty());
    assert!(
        workspace["permissions"]
            .as_array()
            .unwrap()
            .contains(&json!("projects:write"))
    );
    assert_eq!(
        rpc(
            app.clone(),
            "SaveProject",
            Some(worker),
            json!({"project":{"name":"Denied","status":"active"}})
        )
        .await
        .0,
        StatusCode::OK
    );
    let (status, _) = rpc(app.clone(), "SaveMember", Some(&admin), json!({
        "member":{"id":member_id,"name":"Worker","email":"worker@example.test","role":"viewer","status":"active","access":[]}
    })).await;
    assert_eq!(status, StatusCode::OK);
    let (_, workspace) = rpc(app.clone(), "GetWorkspace", Some(worker), json!({})).await;
    assert!(!workspace["customers"].as_array().unwrap().is_empty());
    assert!(
        !workspace["permissions"]
            .as_array()
            .unwrap()
            .contains(&json!("projects:write"))
    );
    assert_eq!(
        rpc(
            app.clone(),
            "SaveCustomer",
            Some(worker),
            json!({"customer":{"name":"Denied","company":"Sample","status":"active"}})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, _) = rpc(app.clone(), "SaveMember", Some(&admin), json!({
        "member":{"id":member_id,"name":"Worker","email":"worker@example.test","role":"viewer","status":"active","access":["customers"]}
    })).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        rpc(
            app.clone(),
            "SaveCustomer",
            Some(worker),
            json!({"customer":{"name":"Denied","company":"Sample","status":"active"}})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, _) = rpc(app.clone(), "SaveMember", Some(&admin), json!({
        "member":{"id":member_id,"name":"Worker","email":"worker@example.test","role":"viewer","status":"inactive","access":["customers"]}
    })).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        rpc(app, "GetWorkspace", Some(worker), json!({})).await.0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn tampered_jwt_is_rejected() {
    let app = app();
    let token = bootstrap(&app).await;
    let mut tampered = token.clone();
    tampered.push('x');
    assert_eq!(
        rpc(app, "GetWorkspace", Some(&tampered), json!({})).await.0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn fixed_roles_auto_keys_rotation_and_ai_admins() {
    let app = app();
    let admin = bootstrap(&app).await;
    assert_eq!(
        rpc(app.clone(), "ListRoles", None, json!({})).await.0,
        StatusCode::UNAUTHORIZED
    );
    let (status, roles) = rpc(app.clone(), "ListRoles", Some(&admin), json!({})).await;
    assert_eq!(status, StatusCode::OK);
    let roles = roles["roles"].as_array().unwrap();
    assert_eq!(roles.len(), 4);
    for (role, writes) in [
        (
            "admin",
            vec![
                "team",
                "customers",
                "projects",
                "reports",
                "social",
                "settings",
            ],
        ),
        (
            "manager",
            vec!["customers", "projects", "reports", "social"],
        ),
        ("member", vec!["projects", "reports"]),
        ("viewer", vec![]),
    ] {
        let permissions = roles.iter().find(|item| item["id"] == role).unwrap()["permissions"]
            .as_array()
            .unwrap();
        for module in [
            "team",
            "customers",
            "projects",
            "reports",
            "social",
            "settings",
        ] {
            assert!(permissions.contains(&json!(format!("{module}:read"))));
            assert_eq!(
                permissions.contains(&json!(format!("{module}:write"))),
                writes.contains(&module)
            );
        }
    }
    let (_, created) = rpc(app.clone(), "SaveMember", Some(&admin), json!({"member":{"name":"AI Admin", "kind":"agent", "role":"admin", "status":"active", "access":[]}})).await;
    let member_id = created["member"]["id"].as_str().unwrap();
    let secret = created["secret"].as_str().unwrap();
    assert!(secret.starts_with("oo_"));
    assert_eq!(created["agentKey"]["memberId"], member_id);
    assert!(
        created["agentKey"]["scopes"]
            .as_array()
            .is_none_or(Vec::is_empty)
    );
    let (_, exchanged) = rpc(app.clone(), "ExchangeAgentKey", None, json!({"key":secret})).await;
    let ai_token = exchanged["token"].as_str().unwrap();
    let (_, child) = rpc(
        app.clone(),
        "SaveMember",
        Some(ai_token),
        json!({"member":{"name":"Child AI", "kind":"agent", "role":"member", "status":"active"}}),
    )
    .await;
    assert!(child["secret"].as_str().unwrap().starts_with("oo_"));
    let (_, updated) = rpc(app.clone(), "SaveMember", Some(ai_token), json!({"member":{"id":member_id, "name":"AI Admin", "kind":"agent", "role":"admin", "status":"active"}})).await;
    assert!(updated["secret"].as_str().is_none_or(str::is_empty));
    let (status, rotated) = rpc(
        app.clone(),
        "RotateAgentKey",
        Some(&admin),
        json!({"memberId":member_id}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{rotated}");
    assert_ne!(rotated["secret"], created["secret"]);
    assert_eq!(
        rpc(app.clone(), "GetWorkspace", Some(ai_token), json!({}))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        rpc(app.clone(), "ExchangeAgentKey", None, json!({"key":secret}))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let (_, new_exchange) = rpc(
        app.clone(),
        "ExchangeAgentKey",
        None,
        json!({"key":rotated["secret"]}),
    )
    .await;
    let new_ai_token = new_exchange["token"].as_str().unwrap();
    assert_eq!(
        rpc(app.clone(), "ListAgentKeys", Some(new_ai_token), json!({}))
            .await
            .0,
        StatusCode::OK
    );
    let (_, child_exchange) = rpc(
        app.clone(),
        "ExchangeAgentKey",
        None,
        json!({"key":child["secret"]}),
    )
    .await;
    let child_token = child_exchange["token"].as_str().unwrap();
    assert_eq!(
        rpc(
            app.clone(),
            "RotateAgentKey",
            Some(child_token),
            json!({"memberId":member_id})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
}

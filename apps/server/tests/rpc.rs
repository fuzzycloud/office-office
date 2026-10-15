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
            "password":"sample-password-123", "workspaceName":"Preview Office"
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
    assert_eq!(workspace["members"][0]["email"], "maya@example.test");
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
        "post": {"connectionId":"demo-social-1", "content":"Sample scheduled post", "status":"queued", "scheduledAt":"2026-12-31T09:00:00Z"}
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
            "connectionId":"demo-social-1", "content":"Would publish", "status":"published"
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
    assert_eq!(state["members"].as_array().unwrap().len(), 2); // one seed, one real admin
}

#[tokio::test]
async fn current_role_and_module_access_are_checked_after_jwt_issue() {
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
    assert!(workspace["projects"].as_array().is_none_or(Vec::is_empty));
    assert_eq!(
        rpc(
            app.clone(),
            "SaveProject",
            Some(worker),
            json!({"project":{"name":"Denied","status":"active"}})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, _) = rpc(app.clone(), "SaveMember", Some(&admin), json!({
        "member":{"id":member_id,"name":"Worker","email":"worker@example.test","role":"viewer","status":"active","access":[]}
    })).await;
    assert_eq!(status, StatusCode::OK);
    let (_, workspace) = rpc(app.clone(), "GetWorkspace", Some(worker), json!({})).await;
    assert!(workspace["customers"].as_array().is_none_or(Vec::is_empty));
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

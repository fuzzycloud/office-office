use std::sync::Arc;

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, header},
    middleware,
};
use connectrpc::Router as ConnectRouter;
use http_body_util::BodyExt;
use office_server::{
    EngineCommand, EngineOutcome, OfficePreviewService, browser_session, proto::office::v1::*,
};
use serde_json::{Value, json};
use tower::ServiceExt;

fn app(service: Arc<OfficePreviewService>, secure: bool) -> Router {
    let connect = service.clone().register(ConnectRouter::new());
    Router::new()
        .merge(browser_session::router(service.clone(), secure))
        .merge(office_server::files::router(service))
        .nest_service("/rpc", connect.into_axum_service())
        .route(
            "/mcp",
            axum::routing::get(|headers: axum::http::HeaderMap| async move {
                if headers.contains_key(header::AUTHORIZATION) {
                    StatusCode::OK
                } else {
                    StatusCode::UNAUTHORIZED
                }
            }),
        )
        .layer(middleware::from_fn(browser_session::bridge_cookie))
}

fn request(path: &str) -> axum::http::request::Builder {
    Request::builder()
        .method("POST")
        .uri(path)
        .header("host", "office.test")
        .header("content-type", "application/json")
}

async fn json_body(response: axum::response::Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

fn bootstrap_body() -> Value {
    json!({"name":"Admin", "email":"admin@example.test", "password":"test-password-123", "workspaceName":"Cookie Office"})
}

#[tokio::test]
async fn browser_login_bootstrap_session_and_logout_do_not_expose_tokens() {
    for (secure, host, expected_secure) in [
        (false, "localhost", false),
        (true, "localhost", true),
        (false, "office.test", true),
    ] {
        let service = Arc::new(OfficePreviewService::new());
        let app = app(service.clone(), secure);
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/auth/bootstrap")
                    .header("host", host)
                    .header("content-type", "application/json")
                    .header("x-office-csrf", "1")
                    .header("origin", format!("http://{host}"))
                    .body(Body::from(bootstrap_body().to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let set_cookie = response.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .to_owned();
        assert!(set_cookie.contains("HttpOnly"));
        assert!(set_cookie.contains("SameSite=Lax"));
        assert!(set_cookie.contains("Path=/"));
        assert!(set_cookie.contains("Max-Age=604800"));
        assert_eq!(set_cookie.contains("Secure"), expected_secure);
        let cookie = set_cookie.split(';').next().unwrap();
        let body = json_body(response).await;
        assert!(body.get("token").is_none());
        assert!(body["expiresAt"].as_i64().unwrap() > 0);
        assert_eq!(body["user"]["name"], "Admin");
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/auth/session")
                    .header("cookie", cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(json_body(response).await["user"]["role"], "admin");
        let response = app
            .clone()
            .oneshot(
                request("/auth/login")
                    .header("x-office-csrf", "1")
                    .body(Body::from(
                        json!({"email":"admin@example.test","password":"test-password-123"})
                            .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(json_body(response).await.get("token").is_none());
        let response = app
            .clone()
            .oneshot(
                request("/auth/logout")
                    .header("x-office-csrf", "1")
                    .header("cookie", "office_session=expired")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert!(
            response.headers()[header::SET_COOKIE]
                .to_str()
                .unwrap()
                .contains("Max-Age=0")
        );
        // Stateless logout only clears the client cookie; it does not revoke a copied JWT.
        assert_eq!(
            app.clone()
                .oneshot(
                    Request::builder()
                        .uri("/auth/session")
                        .header("cookie", cookie)
                        .body(Body::empty())
                        .unwrap()
                )
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        for bad in [
            "",
            "office_session=invalid",
            &format!("{cookie}; {cookie}"),
            "office_session=abc def",
        ] {
            assert_eq!(
                app.clone()
                    .oneshot(
                        Request::builder()
                            .uri("/auth/session")
                            .header("cookie", bad)
                            .body(Body::empty())
                            .unwrap()
                    )
                    .await
                    .unwrap()
                    .status(),
                StatusCode::UNAUTHORIZED
            );
        }
        service.close().await.unwrap();
    }
}

#[tokio::test]
async fn csrf_checks_and_bearer_precedence_protect_cookie_rpc_and_files() {
    let service = Arc::new(OfficePreviewService::new());
    let admin = service
        .bootstrap(BootstrapAdminRequest {
            name: "Admin".into(),
            email: "admin@example.test".into(),
            password: "test-password-123".into(),
            workspace_name: "Office".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    let app = app(service.clone(), false);
    let cookie = format!("office_session={}", admin.token);
    for path in ["/auth/login", "/auth/bootstrap", "/auth/logout"] {
        for (csrf, origin, site) in [
            ("", "https://office.test", "same-origin"),
            ("1", "https://evil.test", "same-origin"),
            ("1", "https://office.test", "cross-site"),
            ("1", "null", "same-origin"),
        ] {
            assert_eq!(
                app.clone()
                    .oneshot(
                        request(path)
                            .header("x-office-csrf", csrf)
                            .header("origin", origin)
                            .header("sec-fetch-site", site)
                            .body(Body::from("{}"))
                            .unwrap()
                    )
                    .await
                    .unwrap()
                    .status(),
                StatusCode::FORBIDDEN
            );
        }
    }
    let rpc = "/rpc/office.v1.OfficeService/GetWorkspace";
    let response = app
        .clone()
        .oneshot(
            request(rpc)
                .header("cookie", &cookie)
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let response = app
        .clone()
        .oneshot(
            request(rpc)
                .header("cookie", &cookie)
                .header("x-office-csrf", "1")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    for bearer in ["Bearer invalid", "Basic invalid", ""] {
        let response = app
            .clone()
            .oneshot(
                request(rpc)
                    .header("cookie", &cookie)
                    .header("authorization", bearer)
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    let response = app
        .clone()
        .oneshot(
            request(rpc)
                .header("authorization", format!("Bearer {}", admin.token))
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        app.clone()
            .oneshot(
                Request::builder()
                    .uri("/mcp")
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap()
            )
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        app.clone()
            .oneshot(
                request("/api/files")
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap()
            )
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/files/missing/content")
                .header("cookie", &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_ne!(response.status(), StatusCode::UNAUTHORIZED);
    service.close().await.unwrap();
}

#[tokio::test]
async fn existing_browser_cookie_uses_live_role_and_status() {
    let service = Arc::new(OfficePreviewService::new());
    let admin = service
        .bootstrap(BootstrapAdminRequest {
            name: "Admin".into(),
            email: "admin@example.test".into(),
            password: "test-password-123".into(),
            workspace_name: "Office".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    let EngineOutcome::Member(created) = service
        .execute(
            &admin.token,
            EngineCommand::SaveMember(SaveMemberRequest {
                member: Some(Member {
                    name: "Colleague".into(),
                    email: "colleague@example.test".into(),
                    role: "manager".into(),
                    status: "active".into(),
                    kind: "human".into(),
                    ..Default::default()
                })
                .into(),
                password: "test-colleague-password".into(),
                ..Default::default()
            }),
        )
        .await
        .unwrap()
    else {
        panic!("expected member")
    };
    let mut colleague = created.member.unwrap();
    let login = service
        .authenticate(LoginRequest {
            email: colleague.email.clone(),
            password: "test-colleague-password".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    let cookie = format!("office_session={}", login.token);
    let app = app(service.clone(), false);
    let rpc = "/rpc/office.v1.OfficeService/SaveCustomer";
    let save = || {
        request(rpc)
            .header("cookie", &cookie)
            .header("x-office-csrf", "1")
            .body(Body::from(
                json!({"customer":{"name":"Customer","company":"Office","status":"lead"}})
                    .to_string(),
            ))
            .unwrap()
    };
    assert_eq!(
        app.clone().oneshot(save()).await.unwrap().status(),
        StatusCode::OK
    );
    colleague.role = "viewer".into();
    service
        .execute(
            &admin.token,
            EngineCommand::SaveMember(SaveMemberRequest {
                member: Some(colleague.clone()).into(),
                ..Default::default()
            }),
        )
        .await
        .unwrap();
    assert_eq!(
        app.clone().oneshot(save()).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
    let current = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/auth/session")
                .header("cookie", &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(json_body(current).await["user"]["role"], "viewer");
    colleague.status = "inactive".into();
    service
        .execute(
            &admin.token,
            EngineCommand::SaveMember(SaveMemberRequest {
                member: Some(colleague).into(),
                ..Default::default()
            }),
        )
        .await
        .unwrap();
    let current = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/auth/session")
                .header("cookie", &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(current.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        app.oneshot(save()).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    service.close().await.unwrap();
}

//! Browser credentials stay in an HttpOnly cookie. Domain authorization still runs
//! through the same actor-backed service as explicit bearer clients.
use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use connectrpc::{ConnectError, ErrorCode};
use serde::Serialize;

use crate::{
    OfficePreviewService,
    proto::office::v1::{BootstrapAdminRequest, LoginRequest, Member},
};

pub const SESSION_SECONDS: i64 = 7 * 24 * 60 * 60;
const COOKIE_NAME: &str = "office_session";

#[derive(Clone)]
struct BrowserState {
    service: Arc<OfficePreviewService>,
    secure_cookies: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginReply {
    user: Member,
    expires_at: i64,
}

/// Mount alongside RPC and files. `secure_cookies` forces Secure regardless of Host;
/// otherwise only a literal loopback Host or localhost permits development HTTP.
pub fn router(service: Arc<OfficePreviewService>, secure_cookies: bool) -> Router {
    Router::new()
        .route("/auth/login", post(login))
        .route("/auth/bootstrap", post(bootstrap))
        .route("/auth/session", get(session))
        .route("/auth/logout", post(logout))
        .layer(middleware::from_fn(auth_guard))
        .with_state(BrowserState {
            service,
            secure_cookies,
        })
}

fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(serde_json::json!({"error": message}))).into_response()
}

fn service_error(err: ConnectError) -> Response {
    let status = match err.code {
        ErrorCode::Unauthenticated => StatusCode::UNAUTHORIZED,
        ErrorCode::PermissionDenied => StatusCode::FORBIDDEN,
        ErrorCode::InvalidArgument => StatusCode::BAD_REQUEST,
        ErrorCode::AlreadyExists | ErrorCode::FailedPrecondition => StatusCode::CONFLICT,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    // Authentication responses must never reflect credentials supplied by clients.
    error(
        status,
        match status {
            StatusCode::UNAUTHORIZED => "session expired or invalid credentials",
            StatusCode::BAD_REQUEST => "invalid authentication request",
            StatusCode::CONFLICT => "workspace already initialized",
            _ => "authentication operation failed",
        },
    )
}

fn single_header<'a>(headers: &'a HeaderMap, name: &str) -> Result<Option<&'a str>, ()> {
    let mut values = headers.get_all(name).iter();
    let value = values
        .next()
        .map(|value| value.to_str().map_err(|_| ()))
        .transpose()?;
    if values.next().is_some() {
        return Err(());
    }
    Ok(value)
}

fn valid_source(headers: &HeaderMap) -> bool {
    let Ok(site) = single_header(headers, "sec-fetch-site") else {
        return false;
    };
    if site.is_some_and(|site| !matches!(site, "same-origin" | "same-site" | "none")) {
        return false;
    }
    let Ok(origin) = single_header(headers, "origin") else {
        return false;
    };
    let Some(origin) = origin else {
        return true;
    };
    if origin
        .chars()
        .any(|ch| ch.is_whitespace() || ch.is_control() || ch == '\\')
    {
        return false;
    }
    let Ok(origin) = url::Url::parse(origin) else {
        return false;
    };
    if !matches!(origin.scheme(), "http" | "https")
        || origin.host().is_none()
        || !origin.username().is_empty()
        || origin.password().is_some()
        || origin.path() != "/"
        || origin.query().is_some()
        || origin.fragment().is_some()
    {
        return false;
    }
    let Ok(Some(host)) = single_header(headers, "host") else {
        return false;
    };
    if host.chars().any(|ch| {
        ch.is_whitespace() || ch.is_control() || matches!(ch, '/' | '\\' | '?' | '#' | '@')
    }) {
        return false;
    }
    let Ok(expected) = url::Url::parse(&format!("{}://{host}", origin.scheme())) else {
        return false;
    };
    origin.host() == expected.host()
        && origin.port_or_known_default() == expected.port_or_known_default()
}

fn csrf(headers: &HeaderMap) -> bool {
    matches!(single_header(headers, "x-office-csrf"), Ok(Some("1"))) && valid_source(headers)
}

async fn auth_guard(request: Request, next: Next) -> Response {
    let mut response = if !valid_source(request.headers())
        || request.method() == Method::POST && !csrf(request.headers())
    {
        error(StatusCode::FORBIDDEN, "same-origin CSRF header required")
    } else {
        next.run(request).await
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn session_token(headers: &HeaderMap) -> Result<Option<String>, ()> {
    let mut token = None;
    for value in headers.get_all(header::COOKIE) {
        let value = value.to_str().map_err(|_| ())?;
        for part in value.split(';').map(str::trim) {
            let Some((name, value)) = part.split_once('=') else {
                if part == COOKIE_NAME {
                    return Err(());
                }
                continue;
            };
            if name.trim() != COOKIE_NAME {
                continue;
            }
            if name != COOKIE_NAME
                || token.is_some()
                || value.is_empty()
                || !value
                    .bytes()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, b'-' | b'_' | b'.'))
                || value.split('.').count() != 3
                || value.split('.').any(str::is_empty)
            {
                return Err(());
            }
            token = Some(value.to_owned());
        }
    }
    Ok(token)
}

/// Only RPC and files inherit browser cookies. An explicit Authorization header,
/// including an invalid one, always retains precedence. MCP never inherits them.
pub async fn bridge_cookie(mut request: Request, next: Next) -> Response {
    let path = request.uri().path();
    let protected = path == "/rpc"
        || path.starts_with("/rpc/")
        || path == "/api/files"
        || path.starts_with("/api/files/");
    if protected && !request.headers().contains_key(header::AUTHORIZATION) {
        let token = match session_token(request.headers()) {
            Ok(token) => token,
            Err(()) => return error(StatusCode::UNAUTHORIZED, "invalid session cookie"),
        };
        if let Some(token) = token {
            let safe = matches!(
                *request.method(),
                Method::GET | Method::HEAD | Method::OPTIONS
            );
            if !valid_source(request.headers()) || !safe && !csrf(request.headers()) {
                return error(StatusCode::FORBIDDEN, "same-origin CSRF header required");
            }
            let Ok(value) = HeaderValue::from_str(&format!("Bearer {token}")) else {
                return error(StatusCode::UNAUTHORIZED, "invalid session cookie");
            };
            request.headers_mut().insert(header::AUTHORIZATION, value);
        }
    }
    next.run(request).await
}

fn cookie(value: &str, max_age: i64, secure: bool) -> HeaderValue {
    HeaderValue::from_str(&format!(
        "{COOKIE_NAME}={value}; Max-Age={max_age}; Path=/; HttpOnly; SameSite=Lax{}",
        if secure { "; Secure" } else { "" }
    ))
    .expect("server-generated cookie value")
}

fn login_response(token: &str, user: Member, expires_at: i64, secure: bool) -> Response {
    let mut response = Json(LoginReply { user, expires_at }).into_response();
    response
        .headers_mut()
        .insert(header::SET_COOKIE, cookie(token, SESSION_SECONDS, secure));
    response
}

fn secure_cookie(state: &BrowserState, headers: &HeaderMap) -> bool {
    if state.secure_cookies {
        return true;
    }
    let Ok(Some(host)) = single_header(headers, "host") else {
        return true;
    };
    if host.contains('@') {
        return true;
    }
    let Ok(authority) = host.parse::<axum::http::uri::Authority>() else {
        return true;
    };
    let host = authority.host();
    let host = host
        .strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .unwrap_or(host);
    !(host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback()))
}

async fn login(
    State(state): State<BrowserState>,
    headers: HeaderMap,
    Json(request): Json<LoginRequest>,
) -> Response {
    match state.service.authenticate(request).await {
        Ok(reply) => login_response(
            &reply.token,
            reply.user.unwrap(),
            reply.expires_at,
            secure_cookie(&state, &headers),
        ),
        Err(err) => service_error(err),
    }
}

async fn bootstrap(
    State(state): State<BrowserState>,
    headers: HeaderMap,
    Json(request): Json<BootstrapAdminRequest>,
) -> Response {
    match state.service.bootstrap(request).await {
        Ok(reply) => login_response(
            &reply.token,
            reply.user.unwrap(),
            reply.expires_at,
            secure_cookie(&state, &headers),
        ),
        Err(err) => service_error(err),
    }
}

async fn session(State(state): State<BrowserState>, headers: HeaderMap) -> Response {
    let Ok(Some(token)) = session_token(&headers) else {
        return error(StatusCode::UNAUTHORIZED, "session required");
    };
    match state.service.workspace(&token).await {
        Ok(workspace) => {
            Json(serde_json::json!({"user": workspace.current_user.unwrap()})).into_response()
        }
        Err(err) => service_error(err),
    }
}

async fn logout(State(state): State<BrowserState>, headers: HeaderMap) -> Response {
    let mut response = StatusCode::NO_CONTENT.into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        cookie("", 0, secure_cookie(&state, &headers)),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use tower::ServiceExt;

    #[tokio::test]
    async fn only_explicit_loopback_hosts_permit_insecure_development_cookies() {
        let service = Arc::new(OfficePreviewService::new());
        let mut state = BrowserState {
            service: service.clone(),
            secure_cookies: false,
        };
        assert!(secure_cookie(&state, &HeaderMap::new()));
        for (host, expected) in [
            ("localhost:5173", false),
            ("LOCALHOST", false),
            ("127.0.0.1:8080", false),
            ("[::1]:8080", false),
            ("office.example", true),
            ("localhost.evil.example", true),
            ("192.168.1.2", true),
            ("127.1", true),
            ("user@localhost", true),
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(header::HOST, HeaderValue::from_str(host).unwrap());
            assert_eq!(secure_cookie(&state, &headers), expected, "{host}");
        }
        state.secure_cookies = true;
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_static("localhost"));
        assert!(secure_cookie(&state, &headers));
        service.close().await.unwrap();
    }

    #[test]
    fn source_validation_uses_deployed_host_and_rejects_ambiguous_headers() {
        for (host, origin, expected) in [
            ("office.example:443", "https://office.example", true),
            ("office.example", "https://office.example:443", true),
            ("localhost:5173", "http://localhost:5173", true),
            ("[::1]:5173", "http://[::1]:5173", true),
            ("office.example", "https://office.example:8443", false),
            ("office.example", "https://evil.example", false),
            (
                "office.example",
                "https://office.example@evil.example",
                false,
            ),
            ("office.example", "https://office.example/path", false),
            ("office.example", "null", false),
            ("office.example", "file://office.example", false),
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(header::HOST, HeaderValue::from_str(host).unwrap());
            headers.insert(header::ORIGIN, HeaderValue::from_str(origin).unwrap());
            assert_eq!(valid_source(&headers), expected, "{host} / {origin}");
        }
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_static("office.example"));
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://office.example"),
        );
        headers.append(
            header::ORIGIN,
            HeaderValue::from_static("https://evil.example"),
        );
        assert!(!valid_source(&headers));
        headers.remove(header::ORIGIN);
        headers.insert("x-office-csrf", HeaderValue::from_static("1"));
        headers.append("x-office-csrf", HeaderValue::from_static("1"));
        assert!(!csrf(&headers));
    }

    #[test]
    fn cookie_parser_rejects_duplicates_across_cookie_headers() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("other=value; office_session=abc.def.ghi"),
        );
        assert_eq!(
            session_token(&headers).unwrap().as_deref(),
            Some("abc.def.ghi")
        );
        headers.append(
            header::COOKIE,
            HeaderValue::from_static("office_session=abc.def.ghi"),
        );
        assert!(session_token(&headers).is_err());
    }

    #[tokio::test]
    async fn expired_signed_cookie_is_rejected_and_logout_still_clears_it() {
        let mut actor = crate::WorkspaceActor::new();
        let initialized = actor
            .bootstrap(BootstrapAdminRequest {
                name: "Admin".into(),
                email: "admin@example.test".into(),
                password: "test-password-123".into(),
                workspace_name: "Office".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        let expired = crate::Claims {
            sub: initialized.user.unwrap().id,
            iss: crate::ISSUER.into(),
            aud: crate::AUDIENCE.into(),
            iat: 1,
            exp: 2,
            key_id: None,
        };
        let token = jsonwebtoken::encode(
            &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256),
            &expired,
            &jsonwebtoken::EncodingKey::from_secret(&actor.key),
        )
        .unwrap();
        let service = Arc::new(OfficePreviewService {
            actor: kathputli::spawn(actor, 128),
            closed: std::sync::atomic::AtomicBool::new(false),
            file_storage: None,
        });
        let app = router(service.clone(), false);
        let cookie = format!("office_session={token}");
        let response = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/auth/session")
                    .header(header::COOKIE, &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .method(Method::POST)
                    .uri("/auth/logout")
                    .header(header::COOKIE, &cookie)
                    .header("x-office-csrf", "1")
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
        service.close().await.unwrap();
    }
}

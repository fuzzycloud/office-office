use std::sync::Arc;

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use connectrpc::Router as ConnectRouter;
use http_body_util::BodyExt;
use office_server::{
    AuthConfig, BoardStore, OfficeBoardService, empty_board, proto::office::v1::OfficeServiceExt,
};
use serde_json::{Value, json};
use tower::ServiceExt;

fn rpc(method: &str, token: Option<&str>, body: Value) -> Request<Body> {
    let mut request = Request::builder()
        .method("POST")
        .uri(format!("/rpc/office.v1.OfficeService/{method}"))
        .header("content-type", "application/json")
        .header("connect-protocol-version", "1");
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    request.body(Body::from(body.to_string())).unwrap()
}

#[tokio::test]
async fn actual_rpc_routes_enforce_auth_and_persist_agent_updates() {
    let dir = std::env::temp_dir().join(format!("office-rpc-{}", std::process::id()));
    let path = dir.join("board.json");
    let store = BoardStore::new(&path);
    let service = Arc::new(OfficeBoardService::new(
        store.clone(),
        AuthConfig {
            human_token: "human-test".into(),
            agent_token: "agent-test".into(),
        },
    ));
    let router = Router::new().nest_service(
        "/rpc",
        service.register(ConnectRouter::new()).into_axum_service(),
    );
    let denied = router
        .clone()
        .oneshot(rpc("GetBoard", None, json!({})))
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
    let denied_save = router
        .clone()
        .oneshot(rpc(
            "SaveBoard",
            Some("bad-token"),
            json!({"boardJson":"{}"}),
        ))
        .await
        .unwrap();
    assert_eq!(denied_save.status(), StatusCode::UNAUTHORIZED);

    let mut board = empty_board();
    board["projects"] =
        json!([{"id":"smoke-project", "title":"RPC smoke test", "status":"on_hold"}]);
    board["targets"] = json!([{"id":"smoke-target", "title":"Verified saves", "current":1, "target":2, "unit":"saves"}]);
    board["prices"] = json!([{"id":"smoke-price", "amountMinor":25000, "currency":"INR", "effectiveOn":"2026-10-15", "projectId":"smoke-project"}]);
    let saved = router
        .clone()
        .oneshot(rpc(
            "SaveBoard",
            Some("agent-test"),
            json!({"boardJson":board.to_string()}),
        ))
        .await
        .unwrap();
    assert_eq!(saved.status(), StatusCode::OK);
    assert_eq!(store.load().await.unwrap(), board);

    let read = router
        .oneshot(rpc("GetBoard", Some("human-test"), json!({})))
        .await
        .unwrap();
    assert_eq!(read.status(), StatusCode::OK);
    let bytes = read.into_body().collect().await.unwrap().to_bytes();
    let response: Value = serde_json::from_slice(&bytes).unwrap();
    let actual: Value = serde_json::from_str(response["boardJson"].as_str().unwrap()).unwrap();
    assert_eq!(actual, board);
    tokio::fs::remove_dir_all(dir).await.unwrap();
}

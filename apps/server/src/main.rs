use std::{net::SocketAddr, sync::Arc};

use axum::{Router, routing::get};
use connectrpc::Router as ConnectRouter;
use office_server::{
    AuthConfig, BoardStore, OfficeBoardService, proto::office::v1::OfficeServiceExt,
};
use tower_http::services::{ServeDir, ServeFile};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let auth = AuthConfig::from_env().map_err(std::io::Error::other)?;
    let addr: SocketAddr = std::env::var("ADDR")
        .unwrap_or_else(|_| "127.0.0.1:8080".to_owned())
        .parse()?;
    let path = std::env::var("OFFICE_DATA_PATH").unwrap_or_else(|_| "data/board.json".to_owned());
    let service = Arc::new(OfficeBoardService::new(BoardStore::new(path), auth));
    let connect = service.register(ConnectRouter::new());
    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .nest_service("/rpc", connect.into_axum_service())
        .fallback_service(
            ServeDir::new("apps/web/dist")
                .not_found_service(ServeFile::new("apps/web/dist/index.html")),
        );
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "office board server listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        let _ = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("register SIGTERM")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = terminate => {} }
}

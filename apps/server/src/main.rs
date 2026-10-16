use std::{net::SocketAddr, sync::Arc};

use axum::{Router, routing::get};
use connectrpc::Router as ConnectRouter;
use office_server::{OfficePreviewService, proto::office::v1::OfficeServiceExt};
use tower_http::services::{ServeDir, ServeFile};

mod mcp;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let addr: SocketAddr = std::env::var("ADDR")
        .unwrap_or_else(|_| "127.0.0.1:8080".to_owned())
        .parse()?;
    if !addr.ip().is_loopback() && std::env::var("OFFICE_ALLOW_REMOTE").as_deref() != Ok("true") {
        return Err("remote binding requires OFFICE_ALLOW_REMOTE=true; protect bootstrap behind a private ingress".into());
    }
    let demo = std::env::var("OFFICE_DEMO_MODE").as_deref() == Ok("true");
    let service = Arc::new(
        if demo {
            OfficePreviewService::new()
        } else {
            let path = std::env::var("OFFICE_DATABASE_PATH")
                .unwrap_or_else(|_| "data/office-office.sqlite3".to_owned());
            OfficePreviewService::open(path).await?
        }
        .with_file_storage_from_env()?,
    );
    let connect = service.clone().register(ConnectRouter::new());
    let mcp_config = mcp::config(std::env::var("OFFICE_MCP_ALLOWED_HOSTS").ok().as_deref())?;
    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .merge(mcp::router(service.clone(), mcp_config))
        .merge(office_server::files::router(service.clone()))
        .nest_service("/rpc", connect.into_axum_service())
        .fallback_service(
            ServeDir::new("apps/web/dist").fallback(ServeFile::new("apps/web/dist/index.html")),
        );
    let listener = tokio::net::TcpListener::bind(addr).await?;
    if demo {
        tracing::warn!(%addr, "Office Office: temporary in-memory storage; accounts and records reset on restart");
    } else {
        tracing::info!(%addr, "Office Office: SQLite events restored; external publishing is unavailable");
    }
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    service.close().await?;
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

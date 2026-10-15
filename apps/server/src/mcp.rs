//! Stateless MCP transport for the same workspace policy used by ConnectRPC.

use std::sync::Arc;

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, header},
    response::{IntoResponse, Response},
    routing::any,
};
use office_server::{
    OfficePreviewService,
    proto::office::v1::{Board, Task},
};
use rmcp::{
    ErrorData as McpError, RoleServer, ServerHandler,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
        JsonObject, ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerInfo, Tool,
        ToolAnnotations, ToolsCapability, object,
    },
    service::RequestContext,
    transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
    },
};
use serde_json::{Value, json};

struct OfficeMcp {
    service: Arc<OfficePreviewService>,
    secret: String,
}

pub fn router(service: Arc<OfficePreviewService>) -> Router {
    Router::new().route(
        "/mcp",
        any(move |request: Request<Body>| {
            let service = service.clone();
            async move { handle(service, request).await }
        }),
    )
}

async fn handle(service: Arc<OfficePreviewService>, request: Request<Body>) -> Response {
    // Browser origins are intentionally unsupported for this agent endpoint.
    if request.headers().contains_key(header::ORIGIN) {
        return (StatusCode::FORBIDDEN, "MCP requests must not send Origin").into_response();
    }
    let Some(secret) = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| value.starts_with("oo_") && !value.contains(char::is_whitespace))
    else {
        return (
            StatusCode::UNAUTHORIZED,
            "An Office Office agent bearer key is required",
        )
            .into_response();
    };
    if service.agent_validate_key(secret).await.is_err() {
        return (
            StatusCode::UNAUTHORIZED,
            "Agent key invalid, expired, or revoked",
        )
            .into_response();
    }

    // Each HTTP request owns its handler and bearer. No session can retain a
    // handler across requests or bind a second credential to the first one.
    let handler = OfficeMcp {
        service,
        secret: secret.to_owned(),
    };
    let config = StreamableHttpServerConfig::default()
        .with_legacy_session_mode(false)
        .with_json_response(true)
        .with_max_request_body_bytes(256 * 1024);
    let transport = StreamableHttpService::new(
        move || {
            Ok(OfficeMcp {
                service: handler.service.clone(),
                secret: handler.secret.clone(),
            })
        },
        Arc::new(LocalSessionManager::default()),
        config,
    );
    transport.handle(request).await.map(Body::new)
}

fn schema(value: Value) -> Arc<JsonObject> {
    Arc::new(object(value))
}

fn tools() -> Vec<Tool> {
    let read = ToolAnnotations::new()
        .read_only(true)
        .destructive(false)
        .idempotent(true)
        .open_world(false);
    let write = ToolAnnotations::new()
        .read_only(false)
        .destructive(true)
        .idempotent(false)
        .open_world(false);
    vec![
        Tool::new(
            "office_get_workspace",
            "Read the Office Office workspace visible to this agent key. Optionally limit projects, boards and tasks to one project.",
            schema(json!({"type":"object","properties":{"project_id":{"type":"string","description":"Optional project ID to filter project records"}},"additionalProperties":false})),
        )
        .with_raw_output_schema(schema(json!({"type":"object","properties":{"workspace":{"type":"object"}},"required":["workspace"]})))
        .with_annotations(read),
        Tool::new(
            "office_save_task",
            "Create or replace a project task. Provide an existing ID to update it; omit ID to create one. Requires project write scope.",
            schema(json!({"type":"object","properties":{"id":{"type":"string"},"project_id":{"type":"string","minLength":1},"board_id":{"type":"string","minLength":1},"column":{"type":"string","minLength":1,"maxLength":80},"title":{"type":"string","minLength":1,"maxLength":200},"description":{"type":"string","maxLength":4000},"assignee_id":{"type":"string"},"priority":{"type":"string","enum":["low","medium","high","urgent"],"default":"medium"},"due_date":{"type":"string","pattern":"^$|^[0-9]{4}-[0-9]{2}-[0-9]{2}$"}},"required":["project_id","board_id","column","title"],"additionalProperties":false})),
        )
        .with_raw_output_schema(schema(json!({"type":"object","properties":{"task":{"type":"object"}},"required":["task"]})))
        .with_annotations(write.clone()),
        Tool::new(
            "office_save_board",
            "Create or replace a project board. Provide an existing ID to update it; omit ID to create one. Requires project write scope.",
            schema(json!({"type":"object","properties":{"id":{"type":"string"},"project_id":{"type":"string","minLength":1},"name":{"type":"string","minLength":1,"maxLength":120},"columns":{"type":"array","minItems":1,"maxItems":20,"uniqueItems":true,"items":{"type":"string","minLength":1,"maxLength":80}}},"required":["project_id","name","columns"],"additionalProperties":false})),
        )
        .with_raw_output_schema(schema(json!({"type":"object","properties":{"board":{"type":"object"}},"required":["board"]})))
        .with_annotations(write),
    ]
}

fn string_arg(args: &JsonObject, name: &str) -> Result<String, String> {
    match args.get(name) {
        None => Ok(String::new()),
        Some(Value::String(value)) => Ok(value.clone()),
        Some(_) => Err(format!("{name} must be a string")),
    }
}

fn columns_arg(args: &JsonObject) -> Result<Vec<String>, String> {
    match args.get("columns") {
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_owned)
                    .ok_or("columns must contain strings".to_owned())
            })
            .collect(),
        None => Ok(Vec::new()),
        _ => Err("columns must be an array of strings".to_owned()),
    }
}

fn success(value: Value) -> CallToolResponse {
    let mut result = CallToolResult::success(vec![ContentBlock::text(value.to_string())]);
    result.structured_content = Some(value);
    result.into()
}

fn failure(message: impl Into<String>) -> CallToolResponse {
    CallToolResult::error(vec![ContentBlock::text(message.into())]).into()
}

impl ServerHandler for OfficeMcp {
    fn get_info(&self) -> ServerInfo {
        let mut info = ServerInfo::default();
        info.server_info = Implementation::new("office-office", env!("CARGO_PKG_VERSION"));
        let mut capabilities = ServerCapabilities::default();
        capabilities.tools = Some(ToolsCapability::default());
        info.capabilities = capabilities;
        info.instructions = Some("Office Office demo workspace records. All tool calls use the bearer key supplied on this HTTP request.".to_owned());
        info
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        Ok(ListToolsResult {
            tools: tools(),
            ..Default::default()
        })
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        tools().into_iter().find(|tool| tool.name == name)
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        let args = request.arguments.unwrap_or_default();
        let answer = match request.name.as_ref() {
            "office_get_workspace" => {
                let project_id = match string_arg(&args, "project_id") {
                    Ok(value) => value,
                    Err(message) => return Ok(failure(message)),
                };
                match self.service.agent_workspace(&self.secret).await {
                    Ok(mut workspace) => {
                        if !project_id.is_empty() {
                            workspace.projects.retain(|item| item.id == project_id);
                            workspace
                                .boards
                                .retain(|item| item.project_id == project_id);
                            workspace.tasks.retain(|item| item.project_id == project_id);
                        }
                        match serde_json::to_value(workspace) {
                            Ok(value) => success(json!({"workspace":value})),
                            Err(_) => failure("Workspace response unavailable. Retry the request."),
                        }
                    }
                    Err(_) => failure(
                        "Workspace access denied or unavailable. Check the key's read scope and try again.",
                    ),
                }
            }
            "office_save_task" => {
                let parsed = (|| -> Result<Task, String> {
                    Ok(Task {
                        id: string_arg(&args, "id")?,
                        project_id: string_arg(&args, "project_id")?,
                        board_id: string_arg(&args, "board_id")?,
                        column: string_arg(&args, "column")?,
                        title: string_arg(&args, "title")?,
                        description: string_arg(&args, "description")?,
                        assignee_id: string_arg(&args, "assignee_id")?,
                        priority: match string_arg(&args, "priority")?.as_str() {
                            "" => "medium".to_owned(),
                            value => value.to_owned(),
                        },
                        due_date: string_arg(&args, "due_date")?,
                        ..Default::default()
                    })
                })();
                match parsed {
                    Ok(task) => match self.service.agent_save_task(&self.secret, task).await {
                        Ok(saved) => match serde_json::to_value(saved) {
                            Ok(value) => success(json!({"task":value})),
                            Err(_) => failure(
                                "Task response unavailable. Read the workspace before retrying.",
                            ),
                        },
                        Err(_) => failure(
                            "Task could not be saved. Check project write scope, board, column and task fields.",
                        ),
                    },
                    Err(message) => failure(message),
                }
            }
            "office_save_board" => {
                let parsed = (|| -> Result<Board, String> {
                    Ok(Board {
                        id: string_arg(&args, "id")?,
                        project_id: string_arg(&args, "project_id")?,
                        name: string_arg(&args, "name")?,
                        columns: columns_arg(&args)?,
                        ..Default::default()
                    })
                })();
                match parsed {
                    Ok(board) => match self.service.agent_save_board(&self.secret, board).await {
                        Ok(saved) => match serde_json::to_value(saved) {
                            Ok(value) => success(json!({"board":value})),
                            Err(_) => failure(
                                "Board response unavailable. Read the workspace before retrying.",
                            ),
                        },
                        Err(_) => failure(
                            "Board could not be saved. Check project write scope and board fields.",
                        ),
                    },
                    Err(message) => failure(message),
                }
            }
            _ => return Err(McpError::invalid_params("unknown Office Office tool", None)),
        };
        Ok(answer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use connectrpc::Router as ConnectRouter;
    use http_body_util::BodyExt;
    use office_server::proto::office::v1::OfficeServiceExt;
    use tower::ServiceExt;

    fn app(service: Arc<OfficePreviewService>) -> Router {
        router(service.clone()).nest_service(
            "/rpc",
            service.register(ConnectRouter::new()).into_axum_service(),
        )
    }

    async fn rpc(app: &Router, method: &str, token: Option<&str>, body: Value) -> Value {
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
        assert_eq!(response.status(), StatusCode::OK);
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
    }

    async fn mcp(
        app: &Router,
        token: Option<&str>,
        origin: Option<&str>,
        payload: Value,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method("POST")
            .uri("/mcp")
            .header("host", "127.0.0.1:8080")
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream");
        if let Some(token) = token {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        if let Some(origin) = origin {
            request = request.header("origin", origin);
        }
        let response = app
            .clone()
            .oneshot(request.body(Body::from(payload.to_string())).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn key(app: &Router, scopes: &[&str]) -> (String, String, String) {
        let bootstrap = rpc(
            app,
            "BootstrapAdmin",
            None,
            json!({"name":"Admin","email":"mcp@example.test","password":"sample-password-123","workspaceName":"Office"}),
        )
        .await;
        let admin = bootstrap["token"].as_str().unwrap().to_owned();
        let created = rpc(
            app,
            "CreateAgentKey",
            Some(&admin),
            json!({"name":"MCP test","scopes":scopes,"expiresInDays":30}),
        )
        .await;
        (
            admin,
            created["secret"].as_str().unwrap().to_owned(),
            created["key"]["id"].as_str().unwrap().to_owned(),
        )
    }

    #[tokio::test]
    async fn requires_request_bearer_and_rejects_browser_origin() {
        let app = app(Arc::new(OfficePreviewService::new()));
        let (_, secret, _) = key(&app, &["projects:read"]).await;
        let init = json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}});
        assert_eq!(
            mcp(&app, None, None, init.clone()).await.0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            mcp(&app, Some("wrong"), None, init.clone()).await.0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            mcp(&app, Some(&secret), Some("http://evil.test"), init.clone())
                .await
                .0,
            StatusCode::FORBIDDEN
        );
        let (status, body) = mcp(&app, Some(&secret), None, init).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["result"]["serverInfo"]["name"], "office-office");
    }

    #[tokio::test]
    async fn lists_reads_checks_scope_and_revocation() {
        let app = app(Arc::new(OfficePreviewService::new()));
        let (admin, secret, key_id) = key(&app, &["projects:read"]).await;
        let (_, listed) = mcp(
            &app,
            Some(&secret),
            None,
            json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
        )
        .await;
        assert_eq!(
            listed["result"]["tools"].as_array().unwrap().len(),
            3,
            "{listed}"
        );
        let (_, read) = mcp(&app, Some(&secret), None, json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"office_get_workspace","arguments":{"project_id":"demo-project-1"}}})).await;
        assert_eq!(read["result"]["isError"], false, "{read}");
        assert_eq!(
            read["result"]["structuredContent"]["workspace"]["projects"][0]["id"],
            "demo-project-1"
        );
        let (_, write) = mcp(&app, Some(&secret), None, json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"office_save_task","arguments":{"project_id":"demo-project-1","board_id":"demo-board-1","column":"Todo","title":"Denied"}}})).await;
        assert_eq!(write["result"]["isError"], true, "{write}");
        rpc(&app, "RevokeAgentKey", Some(&admin), json!({"id":key_id})).await;
        assert_eq!(
            mcp(
                &app,
                Some(&secret),
                None,
                json!({"jsonrpc":"2.0","id":5,"method":"tools/list"})
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
    }
}

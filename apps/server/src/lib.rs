use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use connectrpc::{ConnectError, RequestContext, Response, ServiceRequest, ServiceResult};
use serde_json::{Value, json};
use tokio::sync::Mutex;

pub mod proto {
    connectrpc::include_generated!();
}

use proto::office::v1::{
    GetBoardRequest, GetBoardResponse, OfficeService, SaveBoardRequest, SaveBoardResponse,
};

#[derive(Clone)]
pub struct BoardStore {
    path: PathBuf,
    write_lock: Arc<Mutex<()>>,
}

impl BoardStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            write_lock: Arc::new(Mutex::new(())),
        }
    }

    pub async fn load(&self) -> Result<Value, std::io::Error> {
        match tokio::fs::read(&self.path).await {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(empty_board()),
            Err(error) => Err(error),
        }
    }

    pub async fn save(&self, board: &Value) -> Result<(), std::io::Error> {
        let _guard = self.write_lock.lock().await;
        let parent = self
            .path
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        tokio::fs::create_dir_all(parent).await?;
        let temp_path = self.path.with_extension("json.tmp");
        tokio::fs::write(
            &temp_path,
            serde_json::to_vec_pretty(board).expect("Value serialization is infallible"),
        )
        .await?;
        tokio::fs::rename(&temp_path, &self.path).await
    }
}

pub fn empty_board() -> Value {
    json!({ "targets": [], "projects": [], "strategies": [], "prices": [], "updates": [], "connectors": [] })
}

pub fn validate_board(board: &Value) -> Result<(), String> {
    let object = board
        .as_object()
        .ok_or("board_json must be a JSON object")?;
    let allowed_top_level = [
        "targets",
        "projects",
        "strategies",
        "prices",
        "updates",
        "connectors",
    ];
    if object
        .keys()
        .any(|key| !allowed_top_level.contains(&key.as_str()))
    {
        return Err("board_json contains an unknown top-level field".to_owned());
    }
    for key in [
        "targets",
        "projects",
        "strategies",
        "prices",
        "updates",
        "connectors",
    ] {
        let values = object
            .get(key)
            .and_then(Value::as_array)
            .ok_or_else(|| format!("{key} must be an array"))?;
        for (index, value) in values.iter().enumerate() {
            let item = value
                .as_object()
                .ok_or_else(|| format!("{key}[{index}] must be an object"))?;
            let (allowed_fields, required_fields): (&[&str], &[&str]) = match key {
                "targets" => (
                    &[
                        "id", "title", "detail", "status", "owner", "current", "target", "unit",
                    ],
                    &["id", "title", "current", "target", "unit"],
                ),
                "projects" | "strategies" | "updates" => (
                    &["id", "title", "detail", "status", "owner"],
                    &["id", "title"],
                ),
                "prices" => (
                    &[
                        "id",
                        "projectId",
                        "amountMinor",
                        "currency",
                        "effectiveOn",
                        "detail",
                    ],
                    &["id", "amountMinor", "currency", "effectiveOn"],
                ),
                "connectors" => (
                    &["id", "provider", "mode", "syncStatus"],
                    &["id", "provider", "mode", "syncStatus"],
                ),
                _ => unreachable!("collection keys are enumerated above"),
            };
            if item
                .keys()
                .any(|field| !allowed_fields.contains(&field.as_str()))
            {
                return Err(format!("{key}[{index}] contains an unknown field"));
            }
            for field in required_fields {
                if !item.contains_key(*field) {
                    return Err(format!("{key}[{index}].{field} is required"));
                }
            }
            for field in [
                "id",
                "title",
                "detail",
                "status",
                "owner",
                "projectId",
                "unit",
                "provider",
                "syncStatus",
            ] {
                if item.contains_key(field) && !item.get(field).is_some_and(Value::is_string) {
                    return Err(format!("{key}[{index}].{field} must be a string"));
                }
            }
            if item
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(str::is_empty)
            {
                return Err(format!("{key}[{index}].id must not be empty"));
            }
            if matches!(key, "targets" | "projects" | "strategies" | "updates")
                && item
                    .get("title")
                    .and_then(Value::as_str)
                    .is_some_and(str::is_empty)
            {
                return Err(format!("{key}[{index}].title must not be empty"));
            }
            match key {
                "targets" => {
                    let current = item.get("current").and_then(Value::as_f64);
                    let target = item.get("target").and_then(Value::as_f64);
                    if !current.is_some_and(|number| number.is_finite() && number >= 0.0) {
                        return Err(format!(
                            "targets[{index}].current must be a nonnegative number"
                        ));
                    }
                    if !target.is_some_and(|number| number.is_finite() && number > 0.0) {
                        return Err(format!("targets[{index}].target must be a positive number"));
                    }
                }
                "prices" => {
                    if !item
                        .get("amountMinor")
                        .and_then(Value::as_i64)
                        .is_some_and(|amount| amount >= 0)
                        && !item.get("amountMinor").and_then(Value::as_u64).is_some()
                    {
                        return Err(format!(
                            "prices[{index}].amountMinor must be a nonnegative integer"
                        ));
                    }
                    if !item
                        .get("currency")
                        .and_then(Value::as_str)
                        .is_some_and(|currency| {
                            currency.len() == 3
                                && currency.bytes().all(|byte| byte.is_ascii_uppercase())
                        })
                    {
                        return Err(format!(
                            "prices[{index}].currency must be a three-letter uppercase code"
                        ));
                    }
                    if !item
                        .get("effectiveOn")
                        .and_then(Value::as_str)
                        .is_some_and(is_iso_date)
                    {
                        return Err(format!(
                            "prices[{index}].effectiveOn must be an ISO date (YYYY-MM-DD)"
                        ));
                    }
                }
                "connectors" if item.get("mode").and_then(Value::as_str) != Some("read_only") => {
                    return Err(format!("connectors[{index}].mode must be read_only"));
                }
                _ => {}
            }
        }
    }
    let projects = object
        .get("projects")
        .and_then(Value::as_array)
        .expect("required collection validated above");
    let mut project_ids = std::collections::HashSet::new();
    for (index, project) in projects.iter().enumerate() {
        if project.get("status").is_some_and(|status| {
            !matches!(status.as_str(), Some("active" | "on_hold" | "archived"))
        }) {
            return Err(format!(
                "projects[{index}].status must be active, on_hold, or archived"
            ));
        }
        let id = project
            .get("id")
            .and_then(Value::as_str)
            .expect("required field validated above");
        if !project_ids.insert(id) {
            return Err(format!("projects[{index}].id must be unique"));
        }
    }
    for (index, price) in object
        .get("prices")
        .and_then(Value::as_array)
        .expect("required collection validated above")
        .iter()
        .enumerate()
    {
        if let Some(project_id) = price
            .get("projectId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            && !project_ids.contains(project_id)
        {
            return Err(format!(
                "prices[{index}].projectId must reference an existing project"
            ));
        }
    }
    Ok(())
}

fn is_iso_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    if bytes
        .iter()
        .enumerate()
        .any(|(index, byte)| index != 4 && index != 7 && !byte.is_ascii_digit())
    {
        return false;
    }
    let Ok(year) = value[0..4].parse::<u32>() else {
        return false;
    };
    let Ok(month) = value[5..7].parse::<u32>() else {
        return false;
    };
    let Ok(day) = value[8..10].parse::<u32>() else {
        return false;
    };
    if !(1..=12).contains(&month) {
        return false;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    (1..=days).contains(&day)
}

#[derive(Clone)]
pub struct AuthConfig {
    pub human_token: Arc<str>,
    pub agent_token: Arc<str>,
}

impl AuthConfig {
    pub fn from_env() -> Result<Self, String> {
        let human = std::env::var("OFFICE_HUMAN_TOKEN")
            .map_err(|_| "OFFICE_HUMAN_TOKEN is required".to_owned())?;
        let agent = std::env::var("OFFICE_AGENT_TOKEN")
            .map_err(|_| "OFFICE_AGENT_TOKEN is required".to_owned())?;
        if human.is_empty() || agent.is_empty() || human == agent {
            return Err("human and agent tokens must be non-empty and unequal".to_owned());
        }
        Ok(Self {
            human_token: human.into(),
            agent_token: agent.into(),
        })
    }

    fn authorize(&self, ctx: &RequestContext) -> Result<(), ConnectError> {
        let token = ctx
            .header("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "));
        authorize_token(token, self.human_token.as_ref(), self.agent_token.as_ref())
    }
}

fn authorize_token(
    token: Option<&str>,
    human_token: &str,
    agent_token: &str,
) -> Result<(), ConnectError> {
    match token {
        Some(value) if value == human_token || value == agent_token => Ok(()),
        _ => Err(ConnectError::unauthenticated(
            "a valid bearer token is required",
        )),
    }
}

pub struct OfficeBoardService {
    store: BoardStore,
    auth: AuthConfig,
}
impl OfficeBoardService {
    pub fn new(store: BoardStore, auth: AuthConfig) -> Self {
        Self { store, auth }
    }
}

impl OfficeService for OfficeBoardService {
    async fn get_board<'a>(
        &'a self,
        ctx: RequestContext,
        _request: ServiceRequest<'_, GetBoardRequest>,
    ) -> ServiceResult<impl connectrpc::Encodable<GetBoardResponse> + Send + use<'a>> {
        self.auth.authorize(&ctx)?;
        let board = self.store.load().await.map_err(|error| {
            tracing::error!(%error, "could not load persisted office board");
            ConnectError::internal("could not load board")
        })?;
        Response::ok(GetBoardResponse {
            board_json: serde_json::to_string(&board).expect("Value serialization is infallible"),
            ..Default::default()
        })
    }

    async fn save_board<'a>(
        &'a self,
        ctx: RequestContext,
        request: ServiceRequest<'_, SaveBoardRequest>,
    ) -> ServiceResult<impl connectrpc::Encodable<SaveBoardResponse> + Send + use<'a>> {
        self.auth.authorize(&ctx)?;
        let board: Value = serde_json::from_str(request.board_json).map_err(|error| {
            ConnectError::invalid_argument(format!("board_json is invalid JSON: {error}"))
        })?;
        validate_board(&board).map_err(ConnectError::invalid_argument)?;
        self.store.save(&board).await.map_err(|error| {
            tracing::error!(%error, "could not persist office board");
            ConnectError::internal("could not persist board")
        })?;
        Response::ok(SaveBoardResponse {
            board_json: serde_json::to_string(&board).expect("Value serialization is infallible"),
            ..Default::default()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn board_shape_starts_with_all_empty_collections() {
        assert_eq!(
            empty_board(),
            json!({ "targets": [], "projects": [], "strategies": [], "prices": [], "updates": [], "connectors": [] })
        );
    }

    #[test]
    fn validates_project_status_and_required_collections() {
        let mut board = empty_board();
        board["projects"] =
            json!([{"id":"p1","title":"Project","detail":"","status":"active","owner":"human"}]);
        assert!(validate_board(&board).is_ok());
        board["projects"][0]["status"] = json!("paused");
        assert!(validate_board(&board).is_err());
        board.as_object_mut().unwrap().remove("updates");
        assert!(validate_board(&board).is_err());
    }

    #[test]
    fn validates_targets_prices_and_read_only_connectors() {
        let mut board = empty_board();
        board["projects"] = json!([{"id":"p1","title":"Project"}]);
        board["targets"] =
            json!([{"id":"t1","title":"Revenue","current":3,"target":10,"unit":"USD"}]);
        board["prices"] = json!([
            {"id":"price1","projectId":"p1","amountMinor":1000,"currency":"USD","effectiveOn":"2026-02-28","detail":"Project price"},
            {"id":"office-price","amountMinor":1200,"currency":"USD","effectiveOn":"2026-03-01"}
        ]);
        board["connectors"] =
            json!([{"id":"c1","provider":"google","mode":"read_only","syncStatus":"ready"}]);
        assert!(validate_board(&board).is_ok());

        board["targets"][0]["target"] = json!(0);
        assert!(validate_board(&board).is_err());
        board["targets"][0]["target"] = json!(10);
        board["targets"][0]["current"] = json!("3");
        assert!(validate_board(&board).is_err());
        board["targets"][0]["current"] = json!(3);
        board["prices"][0]["effectiveOn"] = json!("2026-02-30");
        assert!(validate_board(&board).is_err());
        board["prices"][0]["effectiveOn"] = json!("2026-02-28");
        board["prices"][0]["projectId"] = json!("missing-project");
        assert!(validate_board(&board).is_err());
        board["prices"][0]["projectId"] = json!("p1");
        board["connectors"][0]["mode"] = json!("write");
        assert!(validate_board(&board).is_err());
    }

    #[test]
    fn human_and_agent_tokens_may_read_and_save() {
        for token in ["human-secret", "agent-secret"] {
            assert!(authorize_token(Some(token), "human-secret", "agent-secret").is_ok());
        }
        assert!(authorize_token(None, "human-secret", "agent-secret").is_err());
        assert!(authorize_token(Some("invalid"), "human-secret", "agent-secret").is_err());
    }

    #[tokio::test]
    async fn persists_board_atomically_for_subsequent_reads() {
        let dir = std::env::temp_dir().join(format!("office-board-{}", std::process::id()));
        let path = dir.join("board.json");
        let store = BoardStore::new(&path);
        let board = empty_board();
        store.save(&board).await.unwrap();
        assert_eq!(store.load().await.unwrap(), board);
        let _ = tokio::fs::remove_dir_all(dir).await;
    }
}

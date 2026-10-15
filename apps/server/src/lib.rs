use std::{
    collections::HashMap,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use argon2::{
    Argon2, PasswordHash, PasswordHasher, PasswordVerifier,
    password_hash::{SaltString, rand_core::OsRng},
};
use chrono::{DateTime, NaiveDate, Utc};
use connectrpc::{ConnectError, RequestContext, Response, ServiceRequest, ServiceResult};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use katha::{Aggregate, EventWrite};
use kathputli::{Actor, ActorRef, spawn};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;
use uuid::Uuid;

pub mod proto {
    connectrpc::include_generated!();
}
mod demo;
mod storage;
use proto::office::v1::*;

const MODULES: [&str; 6] = [
    "team",
    "customers",
    "projects",
    "reports",
    "social",
    "settings",
];
const SCOPES: [&str; 8] = [
    "projects:read",
    "projects:write",
    "customers:read",
    "customers:write",
    "social:read",
    "social:write",
    "reports:read",
    "reports:write",
];
const DEFAULT_COLUMNS: [&str; 4] = ["Todo", "In progress", "Review", "Done"];
const THEMES: [&str; 35] = [
    "light",
    "dark",
    "cupcake",
    "bumblebee",
    "emerald",
    "corporate",
    "synthwave",
    "retro",
    "cyberpunk",
    "valentine",
    "halloween",
    "garden",
    "forest",
    "aqua",
    "lofi",
    "pastel",
    "fantasy",
    "wireframe",
    "black",
    "luxury",
    "dracula",
    "cmyk",
    "autumn",
    "business",
    "acid",
    "lemonade",
    "night",
    "coffee",
    "winter",
    "dim",
    "nord",
    "sunset",
    "caramellatte",
    "abyss",
    "silk",
];
const ISSUER: &str = "office-office-preview";
const AUDIENCE: &str = "office-office";
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
fn id() -> String {
    Uuid::new_v4().to_string()
}
fn bad(message: impl Into<String>) -> ConnectError {
    ConnectError::invalid_argument(message.into())
}
fn denied() -> ConnectError {
    ConnectError::permission_denied("access denied")
}
fn required(value: &str, label: &str, max: usize) -> Result<(), ConnectError> {
    if value.trim().is_empty() || value.len() > max {
        Err(bad(format!(
            "{label} is required and must be at most {max} bytes"
        )))
    } else {
        Ok(())
    }
}
fn email(value: &str) -> Result<String, ConnectError> {
    let value = value.trim().to_ascii_lowercase();
    if value.len() > 254 || !value.contains('@') || value.starts_with('@') || value.ends_with('@') {
        Err(bad("valid email required"))
    } else {
        Ok(value)
    }
}
fn allowed(value: &str, values: &[&str], label: &str) -> Result<(), ConnectError> {
    if values.contains(&value) {
        Ok(())
    } else {
        Err(bad(format!("invalid {label}")))
    }
}
fn valid_date(value: &str) -> bool {
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .is_ok_and(|date| date.format("%Y-%m-%d").to_string() == value)
}
fn sha256(value: &str) -> String {
    Sha256::digest(value.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn valid_timestamp(value: &str) -> bool {
    DateTime::parse_from_rfc3339(value).is_ok()
}
fn valid_http_url(value: &str) -> bool {
    if value
        .chars()
        .any(|ch| ch.is_whitespace() || ch.is_control() || ch == '\\')
    {
        return false;
    }
    let Ok(parsed) = url::Url::parse(value) else {
        return false;
    };
    matches!(parsed.scheme(), "http" | "https")
        && parsed.host().is_some()
        && parsed.username().is_empty()
        && parsed.password().is_none()
}

#[derive(Clone, Serialize, Deserialize)]
struct Claims {
    sub: String,
    iss: String,
    aud: String,
    iat: usize,
    exp: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    key_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    key_scopes: Option<Vec<String>>,
}

#[derive(Clone)]
struct Principal {
    member: Member,
    key_scopes: Option<Vec<String>>,
}

impl std::ops::Deref for Principal {
    type Target = Member;
    fn deref(&self) -> &Member {
        &self.member
    }
}

#[derive(Default, Clone)]
struct State {
    demo: Option<DemoInitialized>,
    settings: WorkspaceSettings,
    members: Vec<Member>,
    customers: Vec<Customer>,
    projects: Vec<Project>,
    boards: Vec<Board>,
    tasks: Vec<Task>,
    comments: Vec<TaskComment>,
    task_activity: Vec<TaskActivity>,
    reports: Vec<Report>,
    agent_keys: Vec<AgentKey>,
    connections: Vec<SocialConnection>,
    posts: Vec<ScheduledPost>,
    activity: Vec<Activity>,
}
#[derive(Clone, Serialize, Deserialize)]
struct DemoInitialized {
    scenario: String,
    version: u32,
}
// Events contain only public workspace records. Credentials and signing keys live off-log.
#[derive(Clone)]
enum Event {
    DemoInitialized(DemoInitialized),
    Member(Member),
    Customer(Customer),
    Project(Project),
    Board(Board),
    Task(Task),
    TaskComment(TaskComment),
    TaskActivity(TaskActivity),
    Report(Report),
    AgentKey(AgentKey),
    Connection(SocialConnection),
    Post(ScheduledPost),
    Settings(WorkspaceSettings),
    Activity(Activity),
}
#[derive(Clone)]
enum Edit {
    DemoInitialized(DemoInitialized),
    Member(Member),
    Customer(Customer),
    Project(Project),
    Board(Board),
    Task(Task),
    TaskComment(TaskComment),
    Report(Report),
    AgentKey(AgentKey),
    Connection(SocialConnection),
    Post(ScheduledPost),
    Settings(WorkspaceSettings),
}
struct Projection;
impl Aggregate<State, Edit, Event> for Projection {
    fn init(&self) -> State {
        State {
            settings: WorkspaceSettings {
                default_theme: "light".into(),
                timezone: "Asia/Kolkata".into(),
                ..Default::default()
            },
            ..Default::default()
        }
    }
    fn execute(&self, _state: &State, command: &Edit) -> anyhow::Result<Vec<Event>> {
        Ok(vec![match command {
            Edit::DemoInitialized(v) => Event::DemoInitialized(v.clone()),
            Edit::Member(v) => Event::Member(v.clone()),
            Edit::Customer(v) => Event::Customer(v.clone()),
            Edit::Project(v) => Event::Project(v.clone()),
            Edit::Board(v) => Event::Board(v.clone()),
            Edit::Task(v) => Event::Task(v.clone()),
            Edit::TaskComment(v) => Event::TaskComment(v.clone()),
            Edit::Report(v) => Event::Report(v.clone()),
            Edit::AgentKey(v) => Event::AgentKey(v.clone()),
            Edit::Connection(v) => Event::Connection(v.clone()),
            Edit::Post(v) => Event::Post(v.clone()),
            Edit::Settings(v) => Event::Settings(v.clone()),
        }])
    }
    fn apply(&self, mut state: State, event: &Event) -> State {
        match event {
            Event::DemoInitialized(v) => state.demo = Some(v.clone()),
            Event::Member(v) => upsert(&mut state.members, v.clone(), |x| &x.id),
            Event::Customer(v) => upsert(&mut state.customers, v.clone(), |x| &x.id),
            Event::Project(v) => upsert(&mut state.projects, v.clone(), |x| &x.id),
            Event::Board(v) => upsert(&mut state.boards, v.clone(), |x| &x.id),
            Event::Task(v) => {
                let mut task = v.clone();
                task.comment_count = state
                    .comments
                    .iter()
                    .filter(|c| c.task_id == task.id && !c.deleted)
                    .count() as u32;
                upsert(&mut state.tasks, task, |x| &x.id);
            }
            Event::TaskComment(v) => {
                upsert(&mut state.comments, v.clone(), |x| &x.id);
                if let Some(task) = state.tasks.iter_mut().find(|t| t.id == v.task_id) {
                    task.comment_count = state
                        .comments
                        .iter()
                        .filter(|c| c.task_id == v.task_id && !c.deleted)
                        .count() as u32;
                }
            }
            Event::TaskActivity(v) => state.task_activity.insert(0, v.clone()),
            Event::Report(v) => upsert(&mut state.reports, v.clone(), |x| &x.id),
            Event::AgentKey(v) => upsert(&mut state.agent_keys, v.clone(), |x| &x.id),
            Event::Connection(v) => upsert(&mut state.connections, v.clone(), |x| &x.id),
            Event::Post(v) => upsert(&mut state.posts, v.clone(), |x| &x.id),
            Event::Settings(v) => state.settings = v.clone(),
            Event::Activity(v) => state.activity.insert(0, v.clone()),
        }
        state
    }
}
fn upsert<T>(items: &mut Vec<T>, value: T, key: impl Fn(&T) -> &String) {
    if let Some(pos) = items.iter().position(|item| key(item) == key(&value)) {
        items[pos] = value;
    } else {
        items.push(value);
    }
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum EngineCommand {
    SaveMember(SaveMemberRequest),
    SaveCustomer(SaveCustomerRequest),
    SaveProject(SaveProjectRequest),
    SaveBoard(SaveBoardRequest),
    SaveTask(SaveTaskRequest),
    SaveTaskComment(SaveTaskCommentRequest),
    DeleteTaskComment(DeleteTaskCommentRequest),
    SaveReport(SaveReportRequest),
    SavePost(SavePostRequest),
    SaveSettings(SaveSettingsRequest),
    CreateSampleSocialChannel { platform: String, name: String },
}

#[derive(Serialize, Deserialize)]
pub enum EngineOutcome {
    Member(SaveMemberResponse),
    Customer(SaveCustomerResponse),
    Project(SaveProjectResponse),
    Board(SaveBoardResponse),
    Task(SaveTaskResponse),
    TaskComment(SaveTaskCommentResponse),
    DeletedTaskComment(DeleteTaskCommentResponse),
    Report(SaveReportResponse),
    Post(SavePostResponse),
    Settings(SaveSettingsResponse),
    SampleSocialChannel(SocialConnection),
}

enum Command {
    TaskDiscussion(
        String,
        String,
        oneshot::Sender<Result<ListTaskDiscussionResponse, ConnectError>>,
    ),
    AgentTaskDiscussion(
        String,
        String,
        oneshot::Sender<Result<ListTaskDiscussionResponse, ConnectError>>,
    ),
    AgentComment(
        String,
        SaveTaskCommentRequest,
        oneshot::Sender<Result<TaskComment, ConnectError>>,
    ),
    AgentDeleteComment(
        String,
        DeleteTaskCommentRequest,
        oneshot::Sender<Result<TaskComment, ConnectError>>,
    ),
    Close(oneshot::Sender<anyhow::Result<()>>),
    Status(oneshot::Sender<Result<GetSetupStatusResponse, ConnectError>>),
    Bootstrap(
        BootstrapAdminRequest,
        oneshot::Sender<Result<BootstrapAdminResponse, ConnectError>>,
    ),
    Login(
        LoginRequest,
        oneshot::Sender<Result<LoginResponse, ConnectError>>,
    ),
    ExchangeAgentKey(
        String,
        oneshot::Sender<Result<ExchangeAgentKeyResponse, ConnectError>>,
    ),
    Workspace(
        String,
        oneshot::Sender<Result<GetWorkspaceResponse, ConnectError>>,
    ),
    Execute(
        String,
        EngineCommand,
        oneshot::Sender<Result<EngineOutcome, ConnectError>>,
    ),
    ListReports(
        String,
        ListReportsRequest,
        oneshot::Sender<Result<ListReportsResponse, ConnectError>>,
    ),
    GetReport(
        String,
        GetReportRequest,
        oneshot::Sender<Result<GetReportResponse, ConnectError>>,
    ),
    ListAgentKeys(
        String,
        oneshot::Sender<Result<ListAgentKeysResponse, ConnectError>>,
    ),
    CreateAgentKey(
        String,
        CreateAgentKeyRequest,
        oneshot::Sender<Result<CreateAgentKeyResponse, ConnectError>>,
    ),
    RevokeAgentKey(
        String,
        RevokeAgentKeyRequest,
        oneshot::Sender<Result<RevokeAgentKeyResponse, ConnectError>>,
    ),
    AgentWorkspace(
        String,
        oneshot::Sender<Result<GetWorkspaceResponse, ConnectError>>,
    ),
    AgentValidate(String, oneshot::Sender<Result<(), ConnectError>>),
    AgentBoard(String, Board, oneshot::Sender<Result<Board, ConnectError>>),
    AgentTask(String, Task, oneshot::Sender<Result<Task, ConnectError>>),
    AgentListReports(
        String,
        ListReportsRequest,
        oneshot::Sender<Result<ListReportsResponse, ConnectError>>,
    ),
    AgentGetReport(
        String,
        String,
        oneshot::Sender<Result<Report, ConnectError>>,
    ),
    AgentSaveReport(
        String,
        SaveReportRequest,
        oneshot::Sender<Result<Report, ConnectError>>,
    ),
}
struct WorkspaceActor {
    state: State,
    log: Vec<EventWrite<Event, ()>>,
    passwords: HashMap<String, String>,
    agent_secrets: HashMap<String, (String, String)>,
    key: Vec<u8>,
    setup: bool,
    storage: Option<Arc<Mutex<storage::Storage>>>,
    closed: bool,
}
struct ActorSnapshot {
    state: State,
    log_len: usize,
    passwords: HashMap<String, String>,
    agent_secrets: HashMap<String, (String, String)>,
    setup: bool,
}
impl WorkspaceActor {
    fn validate_replayed_state(&self) -> anyhow::Result<()> {
        use anyhow::ensure;
        use std::collections::HashSet;

        if !self.setup {
            return Ok(());
        }
        ensure!(
            THEMES.contains(&self.state.settings.default_theme.as_str())
                && !self.state.settings.timezone.is_empty(),
            "invalid workspace settings"
        );
        let mut ids = HashSet::new();
        let mut emails = HashSet::new();
        for member in &self.state.members {
            ensure!(
                ids.insert(&member.id) && (member.email.is_empty() || emails.insert(&member.email)),
                "duplicate member identity"
            );
            ensure!(
                ["", "human", "agent"].contains(&member.kind.as_str())
                    && (member.kind == "agent" && member.email.is_empty()
                        || email(&member.email).is_ok())
                    && ["admin", "manager", "member", "viewer"].contains(&member.role.as_str()),
                "invalid member"
            );
            ensure!(
                ["active", "inactive", "pending"].contains(&member.status.as_str())
                    && member.access.iter().all(|a| MODULES.contains(&a.as_str())),
                "invalid member access or status"
            );
            ensure!(
                member.status != "active"
                    || member.kind == "agent"
                    || self.passwords.contains_key(&member.id),
                "active member has no password credential"
            );
        }
        ids.clear();
        for customer in &self.state.customers {
            ensure!(
                ids.insert(&customer.id)
                    && ["lead", "active", "inactive"].contains(&customer.status.as_str()),
                "invalid customer"
            );
            ensure!(
                customer.owner_id.is_empty()
                    || self.state.members.iter().any(|m| m.id == customer.owner_id),
                "customer owner missing"
            );
        }
        ids.clear();
        for project in &self.state.projects {
            ensure!(
                ids.insert(&project.id)
                    && ["planning", "active", "on_hold", "completed", "archived"]
                        .contains(&project.status.as_str()),
                "invalid project"
            );
            ensure!(
                project.customer_id.is_empty()
                    || self
                        .state
                        .customers
                        .iter()
                        .any(|c| c.id == project.customer_id),
                "project customer missing"
            );
            ensure!(
                project.owner_id.is_empty()
                    || self.state.members.iter().any(|m| m.id == project.owner_id),
                "project owner missing"
            );
        }
        ids.clear();
        for board in &self.state.boards {
            ensure!(
                ids.insert(&board.id)
                    && self.state.projects.iter().any(|p| p.id == board.project_id),
                "invalid board project"
            );
            ensure!(
                (1..=20).contains(&board.columns.len())
                    && board.columns.iter().all(|c| !c.trim().is_empty()),
                "invalid board columns"
            );
            let columns: HashSet<_> = board.columns.iter().collect();
            ensure!(
                columns.len() == board.columns.len(),
                "duplicate board column"
            );
        }
        ids.clear();
        for task in &self.state.tasks {
            ensure!(ids.insert(&task.id), "duplicate task id");
            let board = self.state.boards.iter().find(|b| b.id == task.board_id);
            ensure!(
                board.is_some_and(
                    |b| b.project_id == task.project_id && b.columns.contains(&task.column)
                ),
                "invalid task board or column"
            );
            ensure!(
                task.assignee_id.is_empty()
                    || self.state.members.iter().any(|m| m.id == task.assignee_id),
                "task assignee missing"
            );
        }
        ids.clear();
        for comment in &self.state.comments {
            ensure!(ids.insert(&comment.id), "duplicate comment id");
            ensure!(
                ["human", "agent"].contains(&comment.actor_kind.as_str())
                    && !comment.author_name.is_empty()
                    && comment.body.len() <= 10000
                    && (comment.deleted || !comment.body.trim().is_empty()),
                "invalid comment fields"
            );
            ensure!(
                self.state.tasks.iter().any(|t| t.id == comment.task_id),
                "comment task missing"
            );
            ensure!(
                comment.revision > 0
                    && comment.created_at > 0
                    && comment.updated_at >= comment.created_at
                    && (!comment.deleted || comment.body.is_empty()),
                "invalid comment revision or tombstone"
            );
            let author_exists = self.state.members.iter().any(|m| m.id == comment.author_id)
                || comment.actor_kind == "agent"
                    && comment
                        .author_id
                        .strip_prefix("agent:")
                        .is_some_and(|id| self.state.agent_keys.iter().any(|k| k.id == id));
            ensure!(author_exists, "comment author missing");
        }
        ids.clear();
        for activity in &self.state.task_activity {
            ensure!(
                ids.insert(&activity.id)
                    && activity.occurred_at > 0
                    && !activity.actor_name.is_empty()
                    && ["human", "agent"].contains(&activity.actor_kind.as_str()),
                "invalid task activity"
            );
            let author_exists = self.state.members.iter().any(|m| m.id == activity.actor_id)
                || activity.actor_kind == "agent"
                    && activity
                        .actor_id
                        .strip_prefix("agent:")
                        .is_some_and(|id| self.state.agent_keys.iter().any(|k| k.id == id));
            ensure!(author_exists, "task activity actor missing");
            ensure!(
                self.state.tasks.iter().any(|t| t.id == activity.task_id),
                "activity task missing"
            );
        }
        ids.clear();
        for report in &self.state.reports {
            ensure!(ids.insert(&report.id), "duplicate report id");
            ensure!(self.validate_report(report).is_ok(), "invalid report");
            ensure!(
                report.revision > 0
                    && report.created_at > 0
                    && report.updated_at >= report.created_at,
                "invalid report revision or timestamps"
            );
            ensure!(
                self.state.members.iter().any(|m| m.id == report.author_id),
                "report author missing"
            );
        }
        ids.clear();
        for key in &self.state.agent_keys {
            ensure!(
                ids.insert(&key.id) && key.scopes.iter().all(|s| SCOPES.contains(&s.as_str())),
                "invalid agent key"
            );
        }
        ids.clear();
        if let Some(marker) = &self.state.demo {
            ensure!(
                marker.scenario == "office-preview" && marker.version == 1,
                "invalid demo scenario"
            );
        }
        for connection in &self.state.connections {
            ensure!(
                ids.insert(&connection.id)
                    && self.state.demo.is_some()
                    && connection.demo
                    && connection.status == "disconnected"
                    && !connection.id.is_empty()
                    && !connection.name.is_empty(),
                "invalid sample social connection"
            );
        }
        ids.clear();
        for post in &self.state.posts {
            ensure!(
                ids.insert(&post.id)
                    && ["draft", "queued", "needs_review"].contains(&post.status.as_str()),
                "invalid social post"
            );
            ensure!(
                self.state
                    .connections
                    .iter()
                    .any(|c| c.id == post.connection_id),
                "social connection missing"
            );
        }
        ids.clear();
        for activity in &self.state.activity {
            ensure!(
                ids.insert(&activity.id) && valid_timestamp(&activity.occurred_at),
                "invalid activity"
            );
        }
        Ok(())
    }
    fn new() -> Self {
        let mut key = vec![0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut key);
        Self {
            state: Projection.init(),
            log: vec![],
            passwords: HashMap::new(),
            agent_secrets: HashMap::new(),
            key,
            setup: false,
            storage: None,
            closed: false,
        }
    }
    fn snapshot(&self) -> ActorSnapshot {
        ActorSnapshot {
            state: self.state.clone(),
            log_len: self.log.len(),
            passwords: self.passwords.clone(),
            agent_secrets: self.agent_secrets.clone(),
            setup: self.setup,
        }
    }
    async fn persist<R>(
        &mut self,
        before: ActorSnapshot,
        result: Result<R, ConnectError>,
    ) -> Result<R, ConnectError> {
        if result.is_err() || self.closed {
            self.state = before.state;
            self.passwords = before.passwords;
            self.agent_secrets = before.agent_secrets;
            self.setup = before.setup;
            self.log.truncate(before.log_len);
            return if self.closed {
                Err(ConnectError::internal("workspace closed"))
            } else {
                result
            };
        }
        if let Some(storage) = &self.storage {
            let storage = Arc::clone(storage);
            let events = self.log[before.log_len..].to_vec();
            let passwords = self.passwords.clone();
            let agent_secrets = self.agent_secrets.clone();
            let setup = self.setup;
            let saved = tokio::task::spawn_blocking(move || {
                storage
                    .lock()
                    .map_err(|_| anyhow::anyhow!("storage lock poisoned"))?
                    .append(&events, &passwords, &agent_secrets, setup)
            })
            .await;
            if !matches!(saved, Ok(Ok(()))) {
                tracing::error!("durable transaction failed: {:?}", saved);
                self.state = before.state;
                self.passwords = before.passwords;
                self.agent_secrets = before.agent_secrets;
                self.setup = before.setup;
                self.log.truncate(before.log_len);
                return Err(ConnectError::internal("workspace save failed"));
            }
            self.log.clear();
        }
        result
    }
    fn commit(&mut self, edit: Edit, actor: &str, summary: &str) {
        for event in Projection.execute(&self.state, &edit).expect("valid edit") {
            let name = match &event {
                Event::DemoInitialized(_) => "demo_initialized",
                Event::Member(_) => "member_saved",
                Event::Customer(_) => "customer_saved",
                Event::Project(_) => "project_saved",
                Event::Board(_) => "board_saved",
                Event::Task(_) => "task_saved",
                Event::TaskComment(_) => "task_comment_saved",
                Event::TaskActivity(_) => "task_activity_recorded",
                Event::Report(_) => "report_saved",
                Event::AgentKey(_) => "agent_key_saved",
                Event::Connection(_) => "connection_saved",
                Event::Post(_) => "post_saved",
                Event::Settings(_) => "settings_saved",
                Event::Activity(_) => "activity_recorded",
            };
            self.log.push(EventWrite {
                id: Uuid::new_v4(),
                correlation_id: None,
                causation_id: None,
                name: name.into(),
                data: event.clone(),
                metadata: None,
            });
            self.state = Projection.apply(std::mem::take(&mut self.state), &event);
        }
        let event = Event::Activity(Activity {
            id: id(),
            kind: "edit".into(),
            summary: summary.into(),
            actor_name: actor.into(),
            occurred_at: Utc::now().to_rfc3339(),
            ..Default::default()
        });
        self.log.push(EventWrite {
            id: Uuid::new_v4(),
            correlation_id: None,
            causation_id: None,
            name: "activity_recorded".into(),
            data: event.clone(),
            metadata: None,
        });
        self.state = Projection.apply(std::mem::take(&mut self.state), &event);
    }
    fn record_task_activity(
        &mut self,
        task_id: &str,
        actor: &Principal,
        kind: &str,
        summary: &str,
    ) {
        let event = Event::TaskActivity(TaskActivity {
            id: id(),
            task_id: task_id.into(),
            kind: kind.into(),
            summary: summary.into(),
            actor_id: actor.id.clone(),
            actor_name: actor.name.clone(),
            actor_kind: Self::actor_kind(actor).into(),
            occurred_at: now(),
            ..Default::default()
        });
        self.log.push(EventWrite {
            id: Uuid::new_v4(),
            correlation_id: None,
            causation_id: None,
            name: "task_activity_recorded".into(),
            data: event.clone(),
            metadata: None,
        });
        self.state = Projection.apply(std::mem::take(&mut self.state), &event);
    }
    fn actor_kind(actor: &Principal) -> &'static str {
        if actor.member.kind == "agent" {
            "agent"
        } else {
            "human"
        }
    }
    fn discussion_as(
        &self,
        actor: &Principal,
        task_id: &str,
    ) -> Result<ListTaskDiscussionResponse, ConnectError> {
        Self::permit(actor, "projects", false)?;
        if !self.state.tasks.iter().any(|t| t.id == task_id) {
            return Err(ConnectError::not_found("task not found"));
        }
        Ok(ListTaskDiscussionResponse {
            comments: self
                .state
                .comments
                .iter()
                .filter(|c| c.task_id == task_id)
                .cloned()
                .collect(),
            activity: self
                .state
                .task_activity
                .iter()
                .filter(|a| a.task_id == task_id)
                .cloned()
                .collect(),
            ..Default::default()
        })
    }
    fn save_comment_as(
        &mut self,
        actor: &Principal,
        request: SaveTaskCommentRequest,
        deleting: bool,
    ) -> Result<TaskComment, ConnectError> {
        Self::permit(actor, "projects", true)?;
        if !self.state.tasks.iter().any(|t| t.id == request.task_id) {
            return Err(ConnectError::not_found("task not found"));
        }
        if !deleting {
            required(&request.body, "comment body", 10000)?;
        }
        let mut comment;
        let kind;
        if request.comment_id.is_empty() {
            if deleting {
                return Err(bad("comment id required"));
            }
            if request.expected_revision != 0 {
                return Err(ConnectError::aborted("comment revision conflict"));
            }
            comment = TaskComment {
                id: id(),
                task_id: request.task_id.clone(),
                author_id: actor.id.clone(),
                author_name: actor.name.clone(),
                actor_kind: Self::actor_kind(actor).into(),
                created_at: now(),
                revision: 1,
                ..Default::default()
            };
            kind = "comment_added";
        } else {
            comment = self
                .state
                .comments
                .iter()
                .find(|c| c.id == request.comment_id && c.task_id == request.task_id)
                .cloned()
                .ok_or_else(|| ConnectError::not_found("comment not found"))?;
            if comment.author_id != actor.id
                && !(actor.role == "admin" && Self::actor_kind(actor) == "human")
            {
                return Err(denied());
            }
            if comment.revision != request.expected_revision || comment.deleted {
                return Err(ConnectError::aborted("comment revision conflict"));
            }
            comment.revision = comment
                .revision
                .checked_add(1)
                .ok_or_else(|| bad("comment revision limit"))?;
            kind = if deleting {
                "comment_deleted"
            } else {
                "comment_edited"
            };
        }
        comment.body = if deleting {
            String::new()
        } else {
            request.body.trim().into()
        };
        comment.deleted = deleting;
        comment.updated_at = now().max(comment.created_at);
        self.commit(
            Edit::TaskComment(comment.clone()),
            &actor.name,
            "Task comment updated",
        );
        self.record_task_activity(
            &request.task_id,
            actor,
            kind,
            match kind {
                "comment_added" => "Comment added",
                "comment_edited" => "Comment edited",
                _ => "Comment deleted",
            },
        );
        Ok(comment)
    }
    fn comment_agent(&self, token: &str, write: bool) -> Result<Principal, ConnectError> {
        let actor = self.user(token)?;
        Self::permit(&actor, "projects", write)?;
        Ok(actor)
    }
    fn claims(
        &self,
        member: &Member,
        credential: Option<&AgentKey>,
    ) -> Result<(String, i64), ConnectError> {
        let expiry = credential.map_or(now() + 900, |key| (now() + 900).min(key.expires_at));
        let claims = Claims {
            sub: member.id.clone(),
            iss: ISSUER.into(),
            aud: AUDIENCE.into(),
            iat: now() as usize,
            exp: expiry as usize,
            key_id: credential.map(|key| key.id.clone()),
            key_scopes: credential.map(|key| key.scopes.clone()),
        };
        let token = encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(&self.key),
        )
        .map_err(|_| ConnectError::internal("token issue failed"))?;
        Ok((token, expiry))
    }
    fn user(&self, token: &str) -> Result<Principal, ConnectError> {
        let mut validation = Validation::new(Algorithm::HS256);
        validation.leeway = 0;
        validation.set_issuer(&[ISSUER]);
        validation.set_audience(&[AUDIENCE]);
        let claims = decode::<Claims>(token, &DecodingKey::from_secret(&self.key), &validation)
            .map_err(|_| ConnectError::unauthenticated("session expired or invalid"))?
            .claims;
        let member = self
            .state
            .members
            .iter()
            .find(|m| m.id == claims.sub && m.status == "active")
            .cloned()
            .ok_or_else(|| ConnectError::unauthenticated("account inactive"))?;
        let key_scopes = if let Some(key_id) = claims.key_id {
            let issued_scopes = claims
                .key_scopes
                .ok_or_else(|| ConnectError::unauthenticated("invalid agent session"))?;
            if member.kind != "agent" {
                return Err(ConnectError::unauthenticated("invalid principal"));
            }
            let key = self
                .state
                .agent_keys
                .iter()
                .find(|key| {
                    key.id == key_id
                        && !key.revoked
                        && key.expires_at > now()
                        && key.member_id == member.id
                        && !key.issued_by.is_empty()
                })
                .ok_or_else(|| ConnectError::unauthenticated("agent key inactive"))?;
            let (_, owner) = self
                .agent_secrets
                .get(&key_id)
                .ok_or_else(|| ConnectError::unauthenticated("agent key inactive"))?;
            if owner != &member.id {
                return Err(ConnectError::unauthenticated("invalid key binding"));
            }
            Some(
                key.scopes
                    .iter()
                    .filter(|scope| issued_scopes.contains(scope))
                    .cloned()
                    .collect(),
            )
        } else {
            if claims.key_scopes.is_some()
                || member.kind == "agent"
                || !self.passwords.contains_key(&member.id)
            {
                return Err(ConnectError::unauthenticated("invalid human session"));
            }
            None
        };
        Ok(Principal { member, key_scopes })
    }
    fn permit(user: &Principal, module: &str, mutate: bool) -> Result<(), ConnectError> {
        if let Some(scopes) = &user.key_scopes {
            let allowed = scopes.iter().any(|scope| {
                scope == &format!("{module}:write") || !mutate && scope == &format!("{module}:read")
            });
            if !allowed {
                return Err(denied());
            }
        }
        if user.role != "admin" && !user.access.iter().any(|v| v == module)
            || (mutate && user.role == "viewer")
            || (mutate && matches!(module, "team" | "settings") && user.role != "admin")
        {
            Err(denied())
        } else {
            Ok(())
        }
    }
    fn active_human_admins(&self) -> usize {
        self.state
            .members
            .iter()
            .filter(|member| {
                member.kind != "agent"
                    && member.role == "admin"
                    && member.status == "active"
                    && self.passwords.contains_key(&member.id)
            })
            .count()
    }
    fn workspace(&self, user: Principal) -> GetWorkspaceResponse {
        let can = |module: &str| Self::permit(&user, module, false).is_ok();
        GetWorkspaceResponse {
            demo_mode: self.state.demo.is_some(),
            persistent_storage: self.storage.is_some(),
            settings: if user.key_scopes.is_none() || can("settings") {
                Some(self.state.settings.clone()).into()
            } else {
                None.into()
            },
            current_user: Some(user.member.clone()).into(),
            members: if can("team") {
                self.state.members.clone()
            } else {
                vec![]
            },
            customers: if can("customers") {
                self.state.customers.clone()
            } else {
                vec![]
            },
            projects: if can("projects") {
                self.state.projects.clone()
            } else {
                vec![]
            },
            boards: if can("projects") {
                self.state.boards.clone()
            } else {
                vec![]
            },
            tasks: if can("projects") {
                self.state.tasks.clone()
            } else {
                vec![]
            },
            connections: if can("social") {
                self.state.connections.clone()
            } else {
                vec![]
            },
            posts: if can("social") {
                self.state.posts.clone()
            } else {
                vec![]
            },
            activity: if can("settings") {
                self.state.activity.clone()
            } else {
                vec![]
            },
            ..Default::default()
        }
    }
    async fn hash(password: String) -> Result<String, ConnectError> {
        tokio::task::spawn_blocking(move || {
            let salt = SaltString::generate(&mut OsRng);
            Argon2::default()
                .hash_password(password.as_bytes(), &salt)
                .map(|hash| hash.to_string())
                .map_err(|_| ConnectError::internal("password hashing failed"))
        })
        .await
        .map_err(|_| ConnectError::internal("password hashing failed"))?
    }
    async fn verify(hash: String, password: String) -> bool {
        tokio::task::spawn_blocking(move || {
            PasswordHash::new(&hash).is_ok_and(|parsed| {
                Argon2::default()
                    .verify_password(password.as_bytes(), &parsed)
                    .is_ok()
            })
        })
        .await
        .unwrap_or(false)
    }
    async fn bootstrap(
        &mut self,
        request: BootstrapAdminRequest,
    ) -> Result<BootstrapAdminResponse, ConnectError> {
        if self.setup {
            return Err(ConnectError::already_exists("workspace already set up"));
        }
        required(&request.name, "name", 120)?;
        required(&request.workspace_name, "workspace name", 120)?;
        if !(12..=128).contains(&request.password.len()) {
            return Err(bad("password must be 12 to 128 bytes"));
        }
        let email = email(&request.email)?;
        if self.state.members.iter().any(|m| m.email == email) {
            return Err(ConnectError::already_exists("email already used"));
        }
        let hash = Self::hash(request.password).await?;
        let member = Member {
            id: id(),
            name: request.name.trim().into(),
            email,
            role: "admin".into(),
            kind: "human".into(),
            status: "active".into(),
            access: MODULES.iter().map(|v| (*v).into()).collect(),
            ..Default::default()
        };
        self.passwords.insert(member.id.clone(), hash);
        self.setup = true;
        self.commit(
            Edit::Member(member.clone()),
            &member.name,
            "Workspace administrator created",
        );
        self.commit(
            Edit::Settings(WorkspaceSettings {
                workspace_name: request.workspace_name.trim().into(),
                ..self.state.settings.clone()
            }),
            &member.name,
            "Workspace settings saved",
        );
        let (token, expires_at) = self.claims(&member, None)?;
        if request.load_demo_data {
            self.commit(
                Edit::DemoInitialized(DemoInitialized {
                    scenario: "office-preview".into(),
                    version: 1,
                }),
                &member.name,
                "Sample workspace initialized",
            );
            demo::register(self, &token).await?;
        }
        Ok(BootstrapAdminResponse {
            token,
            user: Some(member).into(),
            expires_at,
            ..Default::default()
        })
    }
    async fn login(&self, request: LoginRequest) -> Result<LoginResponse, ConnectError> {
        if request.password.len() > 128 {
            return Err(ConnectError::unauthenticated("invalid credentials"));
        }
        let email = email(&request.email)?;
        let member = self
            .state
            .members
            .iter()
            .find(|m| m.email == email && m.status == "active" && m.kind != "agent")
            .ok_or_else(|| ConnectError::unauthenticated("invalid credentials"))?;
        let hash = self
            .passwords
            .get(&member.id)
            .ok_or_else(|| ConnectError::unauthenticated("invalid credentials"))?;
        if !Self::verify(hash.clone(), request.password).await {
            return Err(ConnectError::unauthenticated("invalid credentials"));
        }
        let (token, expires_at) = self.claims(member, None)?;
        Ok(LoginResponse {
            token,
            user: Some(member.clone()).into(),
            expires_at,
            ..Default::default()
        })
    }
    async fn save_member(
        &mut self,
        token: String,
        request: SaveMemberRequest,
    ) -> Result<SaveMemberResponse, ConnectError> {
        let actor = self.user(&token)?;
        Self::permit(&actor, "team", true)?;
        let mut m = request.member.ok_or_else(|| bad("member required"))?;
        required(&m.name, "name", 120)?;
        if m.kind.is_empty() {
            m.kind = "human".into();
        }
        allowed(&m.kind, &["human", "agent"], "member kind")?;
        m.email = if m.kind == "agent" && m.email.trim().is_empty() {
            String::new()
        } else {
            email(&m.email)?
        };
        allowed(&m.role, &["admin", "manager", "member", "viewer"], "role")?;
        allowed(&m.status, &["active", "inactive", "pending"], "status")?;
        if m.access.iter().any(|v| !MODULES.contains(&v.as_str())) {
            return Err(bad("invalid module access"));
        }
        if m.id.is_empty() {
            m.id = id();
        } else if let Some(old) = self.state.members.iter().find(|v| v.id == m.id) {
            if (if old.kind.is_empty() {
                "human"
            } else {
                &old.kind
            }) != m.kind
            {
                return Err(bad("member kind cannot change"));
            }
        } else {
            return Err(bad("unknown member id"));
        }
        if self
            .state
            .members
            .iter()
            .any(|v| !m.email.is_empty() && v.email == m.email && v.id != m.id)
        {
            return Err(ConnectError::already_exists("email already used"));
        }
        if m.id == actor.id && (m.role != "admin" || m.status != "active") {
            return Err(bad("cannot suspend or demote your own admin account"));
        }
        if let Some(old) = self.state.members.iter().find(|v| v.id == m.id)
            && old.role == "admin"
            && old.status == "active"
            && (m.role != "admin" || m.status != "active")
            && old.kind != "agent"
            && self.active_human_admins() == 1
        {
            return Err(bad("cannot remove the last active admin"));
        }
        if m.kind == "agent" && !request.password.is_empty() {
            return Err(bad("agent members cannot have passwords"));
        }
        if !request.password.is_empty() {
            if !(12..=128).contains(&request.password.len()) {
                return Err(bad("password must be 12 to 128 bytes"));
            }
            self.passwords
                .insert(m.id.clone(), Self::hash(request.password).await?);
        }
        if m.kind == "human" && !self.passwords.contains_key(&m.id) {
            m.status = "pending".into();
        }
        self.commit(Edit::Member(m.clone()), &actor.name, "Team member saved");
        Ok(SaveMemberResponse {
            member: Some(m).into(),
            ..Default::default()
        })
    }
    fn save_customer(
        &mut self,
        token: String,
        request: SaveCustomerRequest,
    ) -> Result<SaveCustomerResponse, ConnectError> {
        let actor = self.user(&token)?;
        Self::permit(&actor, "customers", true)?;
        let mut c = request.customer.ok_or_else(|| bad("customer required"))?;
        required(&c.name, "customer name", 120)?;
        required(&c.company, "company", 120)?;
        if !c.email.is_empty() {
            c.email = email(&c.email)?;
        }
        allowed(
            &c.status,
            &["lead", "active", "inactive"],
            "customer status",
        )?;
        if !c.owner_id.is_empty() && !self.state.members.iter().any(|v| v.id == c.owner_id) {
            return Err(bad("unknown owner"));
        }
        if c.notes.len() > 4000 {
            return Err(bad("notes too long"));
        }
        if c.id.is_empty() {
            c.id = id();
        } else if !self.state.customers.iter().any(|v| v.id == c.id) {
            return Err(bad("unknown customer id"));
        }
        self.commit(Edit::Customer(c.clone()), &actor.name, "Customer saved");
        Ok(SaveCustomerResponse {
            customer: Some(c).into(),
            ..Default::default()
        })
    }
    fn save_project(
        &mut self,
        token: String,
        request: SaveProjectRequest,
    ) -> Result<SaveProjectResponse, ConnectError> {
        let actor = self.user(&token)?;
        Self::permit(&actor, "projects", true)?;
        let mut p = request.project.ok_or_else(|| bad("project required"))?;
        required(&p.name, "project name", 120)?;
        allowed(
            &p.status,
            &["planning", "active", "on_hold", "completed", "archived"],
            "project status",
        )?;
        if !p.customer_id.is_empty() && !self.state.customers.iter().any(|v| v.id == p.customer_id)
        {
            return Err(bad("unknown customer"));
        }
        if !p.owner_id.is_empty() && !self.state.members.iter().any(|v| v.id == p.owner_id) {
            return Err(bad("unknown owner"));
        }
        if p.summary.len() > 4000 {
            return Err(bad("summary too long"));
        }
        if !p.target_date.is_empty() && !valid_date(&p.target_date) {
            return Err(bad("target date must be YYYY-MM-DD"));
        }
        if p.id.is_empty() {
            p.id = id();
        } else if !self.state.projects.iter().any(|v| v.id == p.id) {
            return Err(bad("unknown project id"));
        }
        self.commit(Edit::Project(p.clone()), &actor.name, "Project saved");
        if !self.state.boards.iter().any(|v| v.project_id == p.id) {
            self.commit(
                Edit::Board(Board {
                    id: id(),
                    project_id: p.id.clone(),
                    name: "Main board".into(),
                    columns: DEFAULT_COLUMNS.iter().map(|v| (*v).into()).collect(),
                    ..Default::default()
                }),
                &actor.name,
                "Project board created",
            );
        }
        Ok(SaveProjectResponse {
            project: Some(p).into(),
            ..Default::default()
        })
    }
    fn save_board_as(
        &mut self,
        actor: &Principal,
        mut board: Board,
    ) -> Result<Board, ConnectError> {
        Self::permit(actor, "projects", true)?;
        required(&board.name, "board name", 120)?;
        if !self.state.projects.iter().any(|v| v.id == board.project_id) {
            return Err(bad("unknown project"));
        }
        if board.columns.is_empty() || board.columns.len() > 20 {
            return Err(bad("board must have 1 to 20 columns"));
        }
        let mut seen = std::collections::HashSet::new();
        for column in &board.columns {
            required(column, "column", 80)?;
            if !seen.insert(column.as_str()) {
                return Err(bad("duplicate column"));
            }
        }
        if board.id.is_empty() {
            board.id = id();
        } else {
            let old = self
                .state
                .boards
                .iter()
                .find(|v| v.id == board.id)
                .ok_or_else(|| bad("unknown board id"))?;
            if old.project_id != board.project_id {
                return Err(bad("board project cannot change"));
            }
            if self
                .state
                .tasks
                .iter()
                .any(|task| task.board_id == board.id && !seen.contains(task.column.as_str()))
            {
                return Err(bad("column contains tasks"));
            }
        }
        board.name = board.name.trim().into();
        self.commit(
            Edit::Board(board.clone()),
            &actor.name,
            "Project board saved",
        );
        Ok(board)
    }
    fn save_task_as(&mut self, actor: &Principal, mut task: Task) -> Result<Task, ConnectError> {
        Self::permit(actor, "projects", true)?;
        required(&task.title, "task title", 200)?;
        if task.description.len() > 4000 {
            return Err(bad("task description too long"));
        }
        allowed(
            &task.priority,
            &["low", "medium", "high", "urgent"],
            "task priority",
        )?;
        if !task.due_date.is_empty() && !valid_date(&task.due_date) {
            return Err(bad("due date must be YYYY-MM-DD"));
        }
        if !self.state.projects.iter().any(|v| v.id == task.project_id) {
            return Err(bad("unknown project"));
        }
        let board = self
            .state
            .boards
            .iter()
            .find(|v| v.id == task.board_id)
            .ok_or_else(|| bad("unknown board"))?;
        if board.project_id != task.project_id {
            return Err(bad("board belongs to another project"));
        }
        if !board.columns.contains(&task.column) {
            return Err(bad("unknown board column"));
        }
        if !task.assignee_id.is_empty()
            && !self.state.members.iter().any(|v| v.id == task.assignee_id)
        {
            return Err(bad("unknown assignee"));
        }
        if task.id.is_empty() {
            task.id = id();
        } else {
            let old = self
                .state
                .tasks
                .iter()
                .find(|v| v.id == task.id)
                .ok_or_else(|| bad("unknown task id"))?;
            if old.project_id != task.project_id
                && self
                    .state
                    .reports
                    .iter()
                    .any(|report| report.task_id == task.id)
            {
                return Err(bad("task is linked to a report and cannot change projects"));
            }
        }
        task.title = task.title.trim().into();
        task.comment_count = self
            .state
            .comments
            .iter()
            .filter(|c| c.task_id == task.id && !c.deleted)
            .count() as u32;
        let previous = self.state.tasks.iter().find(|t| t.id == task.id).cloned();
        self.commit(Edit::Task(task.clone()), &actor.name, "Project task saved");
        match previous {
            None => self.record_task_activity(&task.id, actor, "task_created", "Task created"),
            Some(old) => {
                if old.board_id != task.board_id
                    || old.column != task.column
                    || old.project_id != task.project_id
                {
                    let summary = if old.board_id != task.board_id {
                        let old_board = self
                            .state
                            .boards
                            .iter()
                            .find(|b| b.id == old.board_id)
                            .map(|b| b.name.as_str())
                            .unwrap_or("Previous board");
                        let new_board = self
                            .state
                            .boards
                            .iter()
                            .find(|b| b.id == task.board_id)
                            .map(|b| b.name.as_str())
                            .unwrap_or("New board");
                        format!(
                            "Task moved: {old_board} / {} → {new_board} / {}",
                            old.column, task.column
                        )
                    } else {
                        format!("Task moved: {} → {}", old.column, task.column)
                    };
                    self.record_task_activity(&task.id, actor, "task_moved", &summary);
                }
                if old.assignee_id != task.assignee_id {
                    let name = self
                        .state
                        .members
                        .iter()
                        .find(|m| m.id == task.assignee_id)
                        .map(|m| m.name.as_str())
                        .unwrap_or("Unassigned");
                    self.record_task_activity(
                        &task.id,
                        actor,
                        "task_assigned",
                        &format!("Task assignee changed to {name}"),
                    );
                }
                let mut fields = Vec::new();
                if old.title != task.title {
                    fields.push("title");
                }
                if old.description != task.description {
                    fields.push("description");
                }
                if old.priority != task.priority {
                    fields.push("priority");
                }
                if old.due_date != task.due_date {
                    fields.push("due date");
                }
                if !fields.is_empty() {
                    self.record_task_activity(
                        &task.id,
                        actor,
                        "task_updated",
                        &format!("Task {} updated", fields.join(", ")),
                    );
                }
            }
        }
        Ok(task)
    }
    fn validate_report(&self, report: &Report) -> Result<(), ConnectError> {
        required(&report.title, "report title", 160)?;
        if report.summary.len() > 2000 || report.body.len() > 200_000 {
            return Err(bad("report summary or body too long"));
        }
        if report.topic.len() > 120 || report.period.len() > 80 {
            return Err(bad("report topic or period too long"));
        }
        allowed(
            &report.kind,
            &["research", "competitor_review"],
            "report kind",
        )?;
        allowed(&report.status, &["draft", "published"], "report status")?;
        if report.status == "published" && report.body.trim().is_empty() {
            return Err(bad("published report body required"));
        }
        if !report.project_id.is_empty()
            && !self
                .state
                .projects
                .iter()
                .any(|p| p.id == report.project_id)
        {
            return Err(bad("unknown report project"));
        }
        if !report.task_id.is_empty()
            && !self
                .state
                .tasks
                .iter()
                .any(|t| t.id == report.task_id && t.project_id == report.project_id)
        {
            return Err(bad("report task must belong to project"));
        }
        if report.sources.len() > 30 {
            return Err(bad("too many report sources"));
        }
        for source in &report.sources {
            required(&source.title, "source title", 200)?;
            if source.url.len() > 2048 {
                return Err(bad("source URL too long"));
            }
            if !valid_http_url(&source.url) {
                return Err(bad("source URL must be absolute HTTP or HTTPS"));
            }
        }
        Ok(())
    }
    fn list_reports_as(
        &self,
        actor: &Principal,
        request: ListReportsRequest,
    ) -> Result<ListReportsResponse, ConnectError> {
        Self::permit(actor, "reports", false)?;
        if request.query.len() > 200 {
            return Err(bad("report query too long"));
        }
        if !request.status.is_empty() {
            allowed(&request.status, &["draft", "published"], "report status")?;
        }
        let query = request.query.trim().to_lowercase();
        let mut reports: Vec<_> = self
            .state
            .reports
            .iter()
            .filter(|report| {
                (request.status.is_empty() || report.status == request.status)
                    && (request.project_id.is_empty() || report.project_id == request.project_id)
                    && (query.is_empty()
                        || report.title.to_lowercase().contains(&query)
                        || report.summary.to_lowercase().contains(&query)
                        || report.topic.to_lowercase().contains(&query)
                        || report.period.to_lowercase().contains(&query))
            })
            .cloned()
            .collect();
        reports.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        let total_count = reports.len() as u32;
        let page_size = if request.page_size == 0 {
            20
        } else {
            request.page_size.min(100)
        } as usize;
        let offset = request.offset as usize;
        let reports: Vec<_> = reports
            .into_iter()
            .skip(offset)
            .take(page_size)
            .map(|mut report| {
                report.body.clear();
                report
            })
            .collect();
        let next_offset = if offset.saturating_add(reports.len()) < total_count as usize {
            offset.saturating_add(reports.len()) as u32
        } else {
            0
        };
        Ok(ListReportsResponse {
            reports,
            total_count,
            next_offset,
            ..Default::default()
        })
    }
    fn get_report_as(&self, actor: &Principal, id: &str) -> Result<Report, ConnectError> {
        Self::permit(actor, "reports", false)?;
        self.state
            .reports
            .iter()
            .find(|r| r.id == id)
            .cloned()
            .ok_or_else(|| ConnectError::not_found("report not found"))
    }
    fn save_report_as(
        &mut self,
        actor: &Principal,
        request: SaveReportRequest,
    ) -> Result<Report, ConnectError> {
        Self::permit(actor, "reports", true)?;
        let mut report = request.report.ok_or_else(|| bad("report required"))?;
        self.validate_report(&report)?;
        if report.id.is_empty() {
            if request.expected_revision != 0 {
                return Err(ConnectError::aborted("report revision conflict"));
            }
            report.id = id();
            report.author_id = actor.id.clone();
            report.author_name = actor.name.clone();
            report.created_at = now();
            report.revision = 1;
        } else {
            let old = self
                .state
                .reports
                .iter()
                .find(|r| r.id == report.id)
                .ok_or_else(|| ConnectError::not_found("report not found"))?;
            if request.expected_revision != old.revision {
                return Err(ConnectError::aborted("report revision conflict"));
            }
            report.author_id = old.author_id.clone();
            report.author_name = old.author_name.clone();
            report.created_at = old.created_at;
            report.revision = old
                .revision
                .checked_add(1)
                .ok_or_else(|| bad("report revision limit"))?;
        }
        report.title = report.title.trim().into();
        report.updated_at = now();
        report.updated_by = actor.name.clone();
        self.commit(Edit::Report(report.clone()), &actor.name, "Report saved");
        Ok(report)
    }
    fn admin(&self, token: &str) -> Result<Principal, ConnectError> {
        let user = self.user(token)?;
        if user.role != "admin" || user.key_scopes.is_some() {
            return Err(denied());
        }
        Ok(user)
    }
    fn list_agent_keys(&self, token: &str) -> Result<ListAgentKeysResponse, ConnectError> {
        self.admin(token)?;
        Ok(ListAgentKeysResponse {
            keys: self.state.agent_keys.clone(),
            ..Default::default()
        })
    }
    fn create_agent_key(
        &mut self,
        token: &str,
        request: CreateAgentKeyRequest,
    ) -> Result<CreateAgentKeyResponse, ConnectError> {
        let actor = self.admin(token)?;
        required(&request.name, "key name", 120)?;
        let member = self
            .state
            .members
            .iter()
            .find(|m| m.id == request.member_id && m.kind == "agent" && m.status == "active")
            .ok_or_else(|| bad("active agent member required"))?;
        if !(1..=90).contains(&request.expires_in_days) {
            return Err(bad("expiry must be 1 to 90 days"));
        }
        if request.scopes.is_empty() || request.scopes.len() > SCOPES.len() {
            return Err(bad("scopes required"));
        }
        let mut seen = std::collections::HashSet::new();
        for scope in &request.scopes {
            if !SCOPES.contains(&scope.as_str()) || !seen.insert(scope.as_str()) {
                return Err(bad("invalid or duplicate scope"));
            }
            let (module, action) = scope.split_once(':').expect("allowed scope");
            let target = Principal {
                member: member.clone(),
                key_scopes: None,
            };
            Self::permit(&target, module, action == "write")?;
        }
        let mut bytes = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        let secret = format!(
            "oo_{}",
            bytes
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        let key = AgentKey {
            id: id(),
            name: request.name.trim().into(),
            scopes: request.scopes,
            created_at: now(),
            expires_at: now() + i64::from(request.expires_in_days) * 86_400,
            revoked: false,
            member_id: member.id.clone(),
            issued_by: actor.id.clone(),
            ..Default::default()
        };
        self.agent_secrets
            .insert(key.id.clone(), (sha256(&secret), member.id.clone()));
        self.commit(
            Edit::AgentKey(key.clone()),
            &actor.name,
            "Agent key created",
        );
        Ok(CreateAgentKeyResponse {
            key: Some(key).into(),
            secret,
            ..Default::default()
        })
    }
    fn revoke_agent_key(
        &mut self,
        token: &str,
        request: RevokeAgentKeyRequest,
    ) -> Result<RevokeAgentKeyResponse, ConnectError> {
        let actor = self.admin(token)?;
        let mut key = self
            .state
            .agent_keys
            .iter()
            .find(|v| v.id == request.id)
            .cloned()
            .ok_or_else(|| bad("unknown agent key"))?;
        key.revoked = true;
        self.agent_secrets.remove(&key.id);
        self.commit(
            Edit::AgentKey(key.clone()),
            &actor.name,
            "Agent key revoked",
        );
        Ok(RevokeAgentKeyResponse {
            key: Some(key).into(),
            ..Default::default()
        })
    }
    fn agent_owner(&self, secret: &str) -> Result<(&AgentKey, Member), ConnectError> {
        if secret.len() != 67 || !secret.starts_with("oo_") {
            return Err(ConnectError::unauthenticated("invalid agent key"));
        }
        let hash = sha256(secret);
        let (key, (_, creator_id)) = self
            .state
            .agent_keys
            .iter()
            .filter(|key| {
                !key.revoked
                    && key.expires_at > now()
                    && !key.member_id.is_empty()
                    && !key.issued_by.is_empty()
            })
            .find_map(|key| {
                self.agent_secrets
                    .get(&key.id)
                    .filter(|(stored, _)| stored == &hash)
                    .map(|record| (key, record))
            })
            .ok_or_else(|| ConnectError::unauthenticated("invalid agent key"))?;
        let actor = self
            .state
            .members
            .iter()
            .find(|member| {
                member.id == *creator_id
                    && member.id == key.member_id
                    && member.kind == "agent"
                    && member.status == "active"
            })
            .cloned()
            .ok_or_else(|| ConnectError::unauthenticated("agent key owner inactive"))?;
        Ok((key, actor))
    }
    fn exchange_agent_key(&self, secret: &str) -> Result<ExchangeAgentKeyResponse, ConnectError> {
        let (key, actor) = self.agent_owner(secret)?;
        let (token, expires_at) = self.claims(&actor, Some(key))?;
        Ok(ExchangeAgentKeyResponse {
            token,
            user: Some(actor).into(),
            expires_at,
            ..Default::default()
        })
    }
    fn agent_identity(&self, token: &str, scope: &str) -> Result<Principal, ConnectError> {
        let actor = self.user(token)?;
        let (module, action) = scope.split_once(':').expect("known scope");
        Self::permit(&actor, module, action == "write")?;
        Ok(actor)
    }
    fn agent_validate_token(&self, token: &str) -> Result<(), ConnectError> {
        self.user(token).map(|_| ())
    }
    fn agent_workspace(&self, token: &str) -> Result<GetWorkspaceResponse, ConnectError> {
        let actor = self.user(token)?;
        let visible = ["projects", "customers", "social"]
            .map(|module| Self::permit(&actor, module, false).is_ok());
        let mut response = self.workspace(actor);
        response.settings = None.into();
        response.current_user = None.into();
        response.members.clear();
        response.activity.clear();
        if !visible[0] {
            response.projects.clear();
            response.boards.clear();
            response.tasks.clear();
        }
        if !visible[1] {
            response.customers.clear();
        }
        if !visible[2] {
            response.connections.clear();
            response.posts.clear();
        }
        Ok(response)
    }
    fn save_post(
        &mut self,
        token: String,
        request: SavePostRequest,
    ) -> Result<SavePostResponse, ConnectError> {
        let actor = self.user(&token)?;
        Self::permit(&actor, "social", true)?;
        let mut p = request.post.ok_or_else(|| bad("post required"))?;
        required(&p.content, "post content", 3000)?;
        allowed(
            &p.status,
            &["draft", "queued", "needs_review"],
            "post status",
        )?;
        if !self
            .state
            .connections
            .iter()
            .any(|v| v.id == p.connection_id)
        {
            return Err(bad("unknown social connection"));
        }
        if (p.status == "queued" || !p.scheduled_at.is_empty()) && !valid_timestamp(&p.scheduled_at)
        {
            return Err(bad("scheduled time must be ISO 8601"));
        }
        if p.id.is_empty() {
            p.id = id();
        } else if !self.state.posts.iter().any(|v| v.id == p.id) {
            return Err(bad("unknown post id"));
        }
        p.author_id = actor.id.clone();
        self.commit(Edit::Post(p.clone()), &actor.name, "Social draft saved");
        Ok(SavePostResponse {
            post: Some(p).into(),
            ..Default::default()
        })
    }
    fn save_settings(
        &mut self,
        token: String,
        request: SaveSettingsRequest,
    ) -> Result<SaveSettingsResponse, ConnectError> {
        let actor = self.user(&token)?;
        Self::permit(&actor, "settings", true)?;
        let s = request.settings.ok_or_else(|| bad("settings required"))?;
        required(&s.workspace_name, "workspace name", 120)?;
        allowed(&s.default_theme, &THEMES, "theme")?;
        required(&s.timezone, "timezone", 80)?;
        self.commit(
            Edit::Settings(s.clone()),
            &actor.name,
            "Workspace settings saved",
        );
        Ok(SaveSettingsResponse {
            settings: Some(s).into(),
            ..Default::default()
        })
    }
    async fn execute_core(
        &mut self,
        token: &str,
        command: EngineCommand,
    ) -> Result<EngineOutcome, ConnectError> {
        let token = token.to_owned();
        match command {
            EngineCommand::SaveMember(v) => {
                self.save_member(token, v).await.map(EngineOutcome::Member)
            }
            EngineCommand::SaveCustomer(v) => {
                self.save_customer(token, v).map(EngineOutcome::Customer)
            }
            EngineCommand::SaveProject(v) => {
                self.save_project(token, v).map(EngineOutcome::Project)
            }
            EngineCommand::SaveBoard(v) => self
                .user(&token)
                .and_then(|actor| {
                    self.save_board_as(&actor, v.board.ok_or_else(|| bad("board required"))?)
                })
                .map(|board| {
                    EngineOutcome::Board(SaveBoardResponse {
                        board: Some(board).into(),
                        ..Default::default()
                    })
                }),
            EngineCommand::SaveTask(v) => self
                .user(&token)
                .and_then(|actor| {
                    self.save_task_as(&actor, v.task.ok_or_else(|| bad("task required"))?)
                })
                .map(|task| {
                    EngineOutcome::Task(SaveTaskResponse {
                        task: Some(task).into(),
                        ..Default::default()
                    })
                }),
            EngineCommand::SaveTaskComment(v) => self
                .user(&token)
                .and_then(|actor| self.save_comment_as(&actor, v, false))
                .map(|comment| {
                    EngineOutcome::TaskComment(SaveTaskCommentResponse {
                        comment: Some(comment).into(),
                        ..Default::default()
                    })
                }),
            EngineCommand::DeleteTaskComment(v) => self
                .user(&token)
                .and_then(|actor| {
                    self.save_comment_as(
                        &actor,
                        SaveTaskCommentRequest {
                            task_id: v.task_id,
                            comment_id: v.comment_id,
                            expected_revision: v.expected_revision,
                            ..Default::default()
                        },
                        true,
                    )
                })
                .map(|comment| {
                    EngineOutcome::DeletedTaskComment(DeleteTaskCommentResponse {
                        comment: Some(comment).into(),
                        ..Default::default()
                    })
                }),
            EngineCommand::SaveReport(v) => self
                .user(&token)
                .and_then(|actor| self.save_report_as(&actor, v))
                .map(|report| {
                    EngineOutcome::Report(SaveReportResponse {
                        report: Some(report).into(),
                        ..Default::default()
                    })
                }),
            EngineCommand::SavePost(v) => self.save_post(token, v).map(EngineOutcome::Post),
            EngineCommand::SaveSettings(v) => {
                self.save_settings(token, v).map(EngineOutcome::Settings)
            }
            EngineCommand::CreateSampleSocialChannel { platform, name } => {
                let actor = self.admin(&token)?;
                if self.state.demo.is_none() {
                    return Err(denied());
                }
                required(&platform, "platform", 80)?;
                required(&name, "channel name", 120)?;
                let channel = SocialConnection {
                    id: id(),
                    platform: platform.trim().into(),
                    name: name.trim().into(),
                    status: "disconnected".into(),
                    demo: true,
                    ..Default::default()
                };
                self.commit(
                    Edit::Connection(channel.clone()),
                    &actor.name,
                    "Sample social channel created",
                );
                Ok(EngineOutcome::SampleSocialChannel(channel))
            }
        }
    }
}
#[async_trait::async_trait]
impl Actor for WorkspaceActor {
    type Msg = Command;
    async fn handle(&mut self, message: Command) {
        match message {
            Command::Close(tx) => {
                self.closed = true;
                let storage = self.storage.take();
                let result = tokio::task::spawn_blocking(move || drop(storage))
                    .await
                    .map_err(|error| anyhow::anyhow!("storage close failed: {error}"));
                let _ = tx.send(result);
            }
            Command::Status(tx) => {
                let _ = tx.send(Ok(GetSetupStatusResponse {
                    needs_setup: !self.setup,
                    demo_mode: self.state.demo.is_some() || (!self.setup && self.storage.is_none()),
                    persistent_storage: self.storage.is_some(),
                    ..Default::default()
                }));
            }
            Command::Bootstrap(v, tx) => {
                let before = self.snapshot();
                let result = self.bootstrap(v).await;
                let _ = tx.send(self.persist(before, result).await);
            }
            Command::Login(v, tx) => {
                let result = self.login(v).await;
                let _ = tx.send(result);
            }
            Command::ExchangeAgentKey(secret, tx) => {
                let _ = tx.send(self.exchange_agent_key(&secret));
            }
            Command::Workspace(t, tx) => {
                let result = self.user(&t).map(|u| self.workspace(u));
                let _ = tx.send(result);
            }
            Command::Execute(t, v, tx) => {
                let before = self.snapshot();
                let result = self.execute_core(&t, v).await;
                let _ = tx.send(self.persist(before, result).await);
            }
            Command::TaskDiscussion(t, id, tx) => {
                let _ = tx.send(
                    self.user(&t)
                        .and_then(|actor| self.discussion_as(&actor, &id)),
                );
            }
            Command::AgentTaskDiscussion(t, id, tx) => {
                let _ = tx.send(
                    self.comment_agent(&t, false)
                        .and_then(|actor| self.discussion_as(&actor, &id)),
                );
            }
            Command::AgentComment(t, request, tx) => {
                let before = self.snapshot();
                let result = self
                    .comment_agent(&t, true)
                    .and_then(|actor| self.save_comment_as(&actor, request, false));
                let _ = tx.send(self.persist(before, result).await);
            }
            Command::AgentDeleteComment(t, request, tx) => {
                let before = self.snapshot();
                let result = self.comment_agent(&t, true).and_then(|actor| {
                    self.save_comment_as(
                        &actor,
                        SaveTaskCommentRequest {
                            task_id: request.task_id,
                            comment_id: request.comment_id,
                            expected_revision: request.expected_revision,
                            ..Default::default()
                        },
                        true,
                    )
                });
                let _ = tx.send(self.persist(before, result).await);
            }
            Command::ListReports(t, v, tx) => {
                let result = self
                    .user(&t)
                    .and_then(|actor| self.list_reports_as(&actor, v));
                let _ = tx.send(result);
            }
            Command::GetReport(t, v, tx) => {
                let result = self
                    .user(&t)
                    .and_then(|actor| self.get_report_as(&actor, &v.id))
                    .map(|report| GetReportResponse {
                        report: Some(report).into(),
                        ..Default::default()
                    });
                let _ = tx.send(result);
            }
            Command::ListAgentKeys(t, tx) => {
                let _ = tx.send(self.list_agent_keys(&t));
            }
            Command::CreateAgentKey(t, v, tx) => {
                let before = self.snapshot();
                let result = self.create_agent_key(&t, v);
                let _ = tx.send(self.persist(before, result).await);
            }
            Command::RevokeAgentKey(t, v, tx) => {
                let before = self.snapshot();
                let result = self.revoke_agent_key(&t, v);
                let _ = tx.send(self.persist(before, result).await);
            }
            Command::AgentWorkspace(secret, tx) => {
                let _ = tx.send(self.agent_workspace(&secret));
            }
            Command::AgentValidate(secret, tx) => {
                let _ = tx.send(self.agent_validate_token(&secret));
            }
            Command::AgentBoard(secret, board, tx) => {
                let before = self.snapshot();
                let result = self
                    .agent_identity(&secret, "projects:write")
                    .and_then(|actor| self.save_board_as(&actor, board));
                let _ = tx.send(self.persist(before, result).await);
            }
            Command::AgentTask(secret, task, tx) => {
                let before = self.snapshot();
                let result = self
                    .comment_agent(&secret, true)
                    .and_then(|actor| self.save_task_as(&actor, task));
                let _ = tx.send(self.persist(before, result).await);
            }
            Command::AgentListReports(secret, v, tx) => {
                let result = self
                    .agent_identity(&secret, "reports:read")
                    .or_else(|_| self.agent_identity(&secret, "reports:write"))
                    .and_then(|actor| self.list_reports_as(&actor, v));
                let _ = tx.send(result);
            }
            Command::AgentGetReport(secret, id, tx) => {
                let result = self
                    .agent_identity(&secret, "reports:read")
                    .or_else(|_| self.agent_identity(&secret, "reports:write"))
                    .and_then(|actor| self.get_report_as(&actor, &id));
                let _ = tx.send(result);
            }
            Command::AgentSaveReport(secret, v, tx) => {
                let before = self.snapshot();
                let result = self
                    .agent_identity(&secret, "reports:write")
                    .and_then(|actor| self.save_report_as(&actor, v));
                let _ = tx.send(self.persist(before, result).await);
            }
        }
    }
}

pub struct OfficePreviewService {
    actor: ActorRef<Command>,
    closed: AtomicBool,
}
impl Default for OfficePreviewService {
    fn default() -> Self {
        Self::new()
    }
}
impl OfficePreviewService {
    pub fn new() -> Self {
        Self {
            actor: spawn(WorkspaceActor::new(), 128),
            closed: AtomicBool::new(false),
        }
    }
    pub async fn open(path: impl AsRef<Path>) -> anyhow::Result<Self> {
        let path = path.as_ref().to_path_buf();
        let (storage, loaded) =
            tokio::task::spawn_blocking(move || storage::Storage::open(&path)).await??;
        let mut actor = WorkspaceActor::new();
        actor.state = State {
            settings: WorkspaceSettings {
                default_theme: "light".into(),
                timezone: "Asia/Kolkata".into(),
                ..Default::default()
            },
            ..Default::default()
        };
        for event in &loaded.events {
            actor.state = Projection.apply(std::mem::take(&mut actor.state), event);
        }
        actor.passwords = loaded.passwords;
        actor.agent_secrets = loaded.agent_secrets;
        actor.key = loaded.signing_key;
        actor.setup = loaded.setup;
        if !actor.setup
            && (!loaded.events.is_empty()
                || !actor.passwords.is_empty()
                || !actor.agent_secrets.is_empty())
        {
            anyhow::bail!("uninitialized database contains workspace data");
        }
        if actor.setup
            != actor.state.members.iter().any(|m| {
                m.role == "admin" && m.status == "active" && actor.passwords.contains_key(&m.id)
            })
        {
            anyhow::bail!("durable setup state does not match administrator credentials");
        }
        if actor.setup && actor.state.settings.workspace_name.is_empty() {
            anyhow::bail!("durable workspace settings missing");
        }
        for id in actor.passwords.keys() {
            if !actor.state.members.iter().any(|m| &m.id == id) {
                anyhow::bail!("password credential has no member");
            }
        }
        for (id, (_, owner)) in &actor.agent_secrets {
            if !actor.state.members.iter().any(|m| &m.id == owner)
                || !actor
                    .state
                    .agent_keys
                    .iter()
                    .any(|k| &k.id == id && !k.revoked)
            {
                anyhow::bail!("agent credential has no active key or owner");
            }
        }
        if actor
            .state
            .agent_keys
            .iter()
            .any(|key| !key.revoked && !actor.agent_secrets.contains_key(&key.id))
        {
            anyhow::bail!("active agent key has no credential");
        }
        actor.validate_replayed_state()?;
        actor.storage = Some(Arc::new(Mutex::new(storage)));
        Ok(Self {
            actor: spawn(actor, 128),
            closed: AtomicBool::new(false),
        })
    }
    pub async fn close(&self) -> anyhow::Result<()> {
        self.closed.store(true, Ordering::Release);
        self.actor.ask(Command::Close).await??;
        Ok(())
    }
    async fn ask<R>(
        &self,
        make: impl FnOnce(oneshot::Sender<Result<R, ConnectError>>) -> Command,
    ) -> Result<R, ConnectError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(ConnectError::internal("workspace closed"));
        }
        self.actor
            .ask(make)
            .await
            .map_err(|_| ConnectError::internal("workspace unavailable"))?
    }
    pub async fn bootstrap(
        &self,
        request: BootstrapAdminRequest,
    ) -> Result<BootstrapAdminResponse, ConnectError> {
        self.ask(|tx| Command::Bootstrap(request, tx)).await
    }
    pub async fn authenticate(&self, request: LoginRequest) -> Result<LoginResponse, ConnectError> {
        self.ask(|tx| Command::Login(request, tx)).await
    }
    pub async fn exchange_agent_key(
        &self,
        key: &str,
    ) -> Result<ExchangeAgentKeyResponse, ConnectError> {
        self.ask(|tx| Command::ExchangeAgentKey(key.into(), tx))
            .await
    }
    pub async fn workspace(&self, token: &str) -> Result<GetWorkspaceResponse, ConnectError> {
        self.ask(|tx| Command::Workspace(token.into(), tx)).await
    }
    pub async fn execute(
        &self,
        token: &str,
        command: EngineCommand,
    ) -> Result<EngineOutcome, ConnectError> {
        self.ask(|tx| Command::Execute(token.into(), command, tx))
            .await
    }
    pub async fn agent_validate_token(&self, token: &str) -> Result<(), ConnectError> {
        self.ask(|tx| Command::AgentValidate(token.into(), tx))
            .await
    }
    pub async fn agent_workspace(
        &self,
        secret: &str,
    ) -> Result<GetWorkspaceResponse, ConnectError> {
        self.ask(|tx| Command::AgentWorkspace(secret.into(), tx))
            .await
    }
    pub async fn agent_save_board(
        &self,
        secret: &str,
        board: Board,
    ) -> Result<Board, ConnectError> {
        self.ask(|tx| Command::AgentBoard(secret.into(), board, tx))
            .await
    }
    pub async fn task_discussion(
        &self,
        token: &str,
        task_id: &str,
    ) -> Result<ListTaskDiscussionResponse, ConnectError> {
        self.ask(|tx| Command::TaskDiscussion(token.into(), task_id.into(), tx))
            .await
    }
    pub async fn agent_task_discussion(
        &self,
        secret: &str,
        task_id: &str,
    ) -> Result<ListTaskDiscussionResponse, ConnectError> {
        self.ask(|tx| Command::AgentTaskDiscussion(secret.into(), task_id.into(), tx))
            .await
    }
    pub async fn agent_save_task_comment(
        &self,
        secret: &str,
        request: SaveTaskCommentRequest,
    ) -> Result<TaskComment, ConnectError> {
        self.ask(|tx| Command::AgentComment(secret.into(), request, tx))
            .await
    }
    pub async fn agent_delete_task_comment(
        &self,
        secret: &str,
        request: DeleteTaskCommentRequest,
    ) -> Result<TaskComment, ConnectError> {
        self.ask(|tx| Command::AgentDeleteComment(secret.into(), request, tx))
            .await
    }
    pub async fn agent_save_task(&self, secret: &str, task: Task) -> Result<Task, ConnectError> {
        self.ask(|tx| Command::AgentTask(secret.into(), task, tx))
            .await
    }
    pub async fn agent_list_reports(
        &self,
        secret: &str,
        request: ListReportsRequest,
    ) -> Result<ListReportsResponse, ConnectError> {
        self.ask(|tx| Command::AgentListReports(secret.into(), request, tx))
            .await
    }
    pub async fn agent_get_report(&self, secret: &str, id: &str) -> Result<Report, ConnectError> {
        self.ask(|tx| Command::AgentGetReport(secret.into(), id.into(), tx))
            .await
    }
    pub async fn agent_save_report(
        &self,
        secret: &str,
        request: SaveReportRequest,
    ) -> Result<Report, ConnectError> {
        self.ask(|tx| Command::AgentSaveReport(secret.into(), request, tx))
            .await
    }
}
fn bearer(ctx: &RequestContext) -> Result<String, ConnectError> {
    ctx.header("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| ConnectError::unauthenticated("bearer token required"))
}
impl OfficeService for OfficePreviewService {
    async fn get_setup_status<'a>(
        &'a self,
        _ctx: RequestContext,
        _req: ServiceRequest<'_, GetSetupStatusRequest>,
    ) -> ServiceResult<impl connectrpc::Encodable<GetSetupStatusResponse> + Send + use<'a>> {
        Response::ok(self.ask(Command::Status).await?)
    }
    async fn bootstrap_admin<'a>(
        &'a self,
        _ctx: RequestContext,
        req: ServiceRequest<'_, BootstrapAdminRequest>,
    ) -> ServiceResult<impl connectrpc::Encodable<BootstrapAdminResponse> + Send + use<'a>> {
        Response::ok(self.bootstrap(req.to_owned_message()).await?)
    }
    async fn login<'a>(
        &'a self,
        _ctx: RequestContext,
        req: ServiceRequest<'_, LoginRequest>,
    ) -> ServiceResult<impl connectrpc::Encodable<LoginResponse> + Send + use<'a>> {
        Response::ok(self.authenticate(req.to_owned_message()).await?)
    }
    async fn exchange_agent_key<'a>(
        &'a self,
        _ctx: RequestContext,
        req: ServiceRequest<'_, ExchangeAgentKeyRequest>,
    ) -> ServiceResult<impl connectrpc::Encodable<ExchangeAgentKeyResponse> + Send + use<'a>> {
        Response::ok(self.exchange_agent_key(&req.to_owned_message().key).await?)
    }
    async fn get_workspace<'a>(
        &'a self,
        ctx: RequestContext,
        _req: ServiceRequest<'_, GetWorkspaceRequest>,
    ) -> ServiceResult<impl connectrpc::Encodable<GetWorkspaceResponse> + Send + use<'a>> {
        let token = bearer(&ctx)?;
        Response::ok(self.workspace(&token).await?)
    }
    async fn save_member<'a>(
        &'a self,
        ctx: RequestContext,
        req: ServiceRequest<'_, SaveMemberRequest>,
    ) -> ServiceResult<impl connectrpc::Encodable<SaveMemberResponse> + Send + use<'a>> {
        let token = bearer(&ctx)?;
        let EngineOutcome::Member(result) = self
            .execute(&token, EngineCommand::SaveMember(req.to_owned_message()))
            .await?
        else {
            unreachable!()
        };
        Response::ok(result)
    }
    async fn save_customer<'a>(
        &'a self,
        ctx: RequestContext,
        req: ServiceRequest<'_, SaveCustomerRequest>,
    ) -> ServiceResult<impl connectrpc::Encodable<SaveCustomerResponse> + Send + use<'a>> {
        let token = bearer(&ctx)?;
        let EngineOutcome::Customer(result) = self
            .execute(&token, EngineCommand::SaveCustomer(req.to_owned_message()))
            .await?
        else {
            unreachable!()
        };
        Response::ok(result)
    }
    async fn save_project<'a>(
        &'a self,
        ctx: RequestContext,
        req: ServiceRequest<'_, SaveProjectRequest>,
    ) -> ServiceResult<impl connectrpc::Encodable<SaveProjectResponse> + Send + use<'a>> {
        let token = bearer(&ctx)?;
        let EngineOutcome::Project(result) = self
            .execute(&token, EngineCommand::SaveProject(req.to_owned_message()))
            .await?
        else {
            unreachable!()
        };
        Response::ok(result)
    }
    async fn save_board<'a>(
        &'a self,
        ctx: RequestContext,
        req: ServiceRequest<'_, SaveBoardRequest>,
    ) -> ServiceResult<impl connectrpc::Encodable<SaveBoardResponse> + Send + use<'a>> {
        let token = bearer(&ctx)?;
        let EngineOutcome::Board(result) = self
            .execute(&token, EngineCommand::SaveBoard(req.to_owned_message()))
            .await?
        else {
            unreachable!()
        };
        Response::ok(result)
    }
    async fn save_task<'a>(
        &'a self,
        ctx: RequestContext,
        req: ServiceRequest<'_, SaveTaskRequest>,
    ) -> ServiceResult<impl connectrpc::Encodable<SaveTaskResponse> + Send + use<'a>> {
        let token = bearer(&ctx)?;
        let EngineOutcome::Task(result) = self
            .execute(&token, EngineCommand::SaveTask(req.to_owned_message()))
            .await?
        else {
            unreachable!()
        };
        Response::ok(result)
    }
    async fn list_task_discussion<'a>(
        &'a self,
        ctx: RequestContext,
        req: ServiceRequest<'_, ListTaskDiscussionRequest>,
    ) -> ServiceResult<impl connectrpc::Encodable<ListTaskDiscussionResponse> + Send + use<'a>>
    {
        Response::ok(
            self.task_discussion(&bearer(&ctx)?, &req.to_owned_message().task_id)
                .await?,
        )
    }
    async fn save_task_comment<'a>(
        &'a self,
        ctx: RequestContext,
        req: ServiceRequest<'_, SaveTaskCommentRequest>,
    ) -> ServiceResult<impl connectrpc::Encodable<SaveTaskCommentResponse> + Send + use<'a>> {
        let EngineOutcome::TaskComment(result) = self
            .execute(
                &bearer(&ctx)?,
                EngineCommand::SaveTaskComment(req.to_owned_message()),
            )
            .await?
        else {
            unreachable!()
        };
        Response::ok(result)
    }
    async fn delete_task_comment<'a>(
        &'a self,
        ctx: RequestContext,
        req: ServiceRequest<'_, DeleteTaskCommentRequest>,
    ) -> ServiceResult<impl connectrpc::Encodable<DeleteTaskCommentResponse> + Send + use<'a>> {
        let EngineOutcome::DeletedTaskComment(result) = self
            .execute(
                &bearer(&ctx)?,
                EngineCommand::DeleteTaskComment(req.to_owned_message()),
            )
            .await?
        else {
            unreachable!()
        };
        Response::ok(result)
    }
    async fn list_reports<'a>(
        &'a self,
        ctx: RequestContext,
        req: ServiceRequest<'_, ListReportsRequest>,
    ) -> ServiceResult<impl connectrpc::Encodable<ListReportsResponse> + Send + use<'a>> {
        let token = bearer(&ctx)?;
        Response::ok(
            self.ask(|tx| Command::ListReports(token, req.to_owned_message(), tx))
                .await?,
        )
    }
    async fn get_report<'a>(
        &'a self,
        ctx: RequestContext,
        req: ServiceRequest<'_, GetReportRequest>,
    ) -> ServiceResult<impl connectrpc::Encodable<GetReportResponse> + Send + use<'a>> {
        let token = bearer(&ctx)?;
        Response::ok(
            self.ask(|tx| Command::GetReport(token, req.to_owned_message(), tx))
                .await?,
        )
    }
    async fn save_report<'a>(
        &'a self,
        ctx: RequestContext,
        req: ServiceRequest<'_, SaveReportRequest>,
    ) -> ServiceResult<impl connectrpc::Encodable<SaveReportResponse> + Send + use<'a>> {
        let token = bearer(&ctx)?;
        let EngineOutcome::Report(result) = self
            .execute(&token, EngineCommand::SaveReport(req.to_owned_message()))
            .await?
        else {
            unreachable!()
        };
        Response::ok(result)
    }
    async fn list_agent_keys<'a>(
        &'a self,
        ctx: RequestContext,
        _req: ServiceRequest<'_, ListAgentKeysRequest>,
    ) -> ServiceResult<impl connectrpc::Encodable<ListAgentKeysResponse> + Send + use<'a>> {
        let token = bearer(&ctx)?;
        Response::ok(self.ask(|tx| Command::ListAgentKeys(token, tx)).await?)
    }
    async fn create_agent_key<'a>(
        &'a self,
        ctx: RequestContext,
        req: ServiceRequest<'_, CreateAgentKeyRequest>,
    ) -> ServiceResult<impl connectrpc::Encodable<CreateAgentKeyResponse> + Send + use<'a>> {
        let token = bearer(&ctx)?;
        Response::ok(
            self.ask(|tx| Command::CreateAgentKey(token, req.to_owned_message(), tx))
                .await?,
        )
    }
    async fn revoke_agent_key<'a>(
        &'a self,
        ctx: RequestContext,
        req: ServiceRequest<'_, RevokeAgentKeyRequest>,
    ) -> ServiceResult<impl connectrpc::Encodable<RevokeAgentKeyResponse> + Send + use<'a>> {
        let token = bearer(&ctx)?;
        Response::ok(
            self.ask(|tx| Command::RevokeAgentKey(token, req.to_owned_message(), tx))
                .await?,
        )
    }
    async fn save_post<'a>(
        &'a self,
        ctx: RequestContext,
        req: ServiceRequest<'_, SavePostRequest>,
    ) -> ServiceResult<impl connectrpc::Encodable<SavePostResponse> + Send + use<'a>> {
        let token = bearer(&ctx)?;
        let EngineOutcome::Post(result) = self
            .execute(&token, EngineCommand::SavePost(req.to_owned_message()))
            .await?
        else {
            unreachable!()
        };
        Response::ok(result)
    }
    async fn save_settings<'a>(
        &'a self,
        ctx: RequestContext,
        req: ServiceRequest<'_, SaveSettingsRequest>,
    ) -> ServiceResult<impl connectrpc::Encodable<SaveSettingsResponse> + Send + use<'a>> {
        let token = bearer(&ctx)?;
        let EngineOutcome::Settings(result) = self
            .execute(&token, EngineCommand::SaveSettings(req.to_owned_message()))
            .await?
        else {
            unreachable!()
        };
        Response::ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn initialized_durable_database(path: &Path) {
        let (storage, loaded) = storage::Storage::open(path).unwrap();
        let mut actor = WorkspaceActor::new();
        actor.state = State {
            settings: WorkspaceSettings {
                default_theme: "light".into(),
                timezone: "Asia/Kolkata".into(),
                ..Default::default()
            },
            ..Default::default()
        };
        actor.key = loaded.signing_key;
        actor.storage = Some(Arc::new(Mutex::new(storage)));
        let before = actor.snapshot();
        let response = actor
            .bootstrap(BootstrapAdminRequest {
                name: "Admin".into(),
                email: "admin@example.test".into(),
                password: "sample-password-123".into(),
                workspace_name: "Office".into(),
                ..Default::default()
            })
            .await;
        actor.persist(before, response).await.unwrap();
    }

    #[tokio::test]
    async fn initialized_database_rejects_valid_json_empty_record_and_missing_credentials() {
        for fault in ["record", "password"] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("office.sqlite3");
            initialized_durable_database(&path).await;
            let conn = rusqlite::Connection::open(&path).unwrap();
            if fault == "record" {
                let sequence: i64 = conn
                    .query_row("SELECT MAX(sequence) + 1 FROM events", [], |r| r.get(0))
                    .unwrap();
                conn.execute("INSERT INTO events(sequence, event_id, event_type, event_version, occurred_at, payload) VALUES(?1, ?2, 'customer', 1, ?3, '{}')",
                    rusqlite::params![sequence, id(), now()]).unwrap();
            } else {
                conn.execute("DELETE FROM passwords", []).unwrap();
            }
            drop(conn);
            assert!(
                OfficePreviewService::open(&path).await.is_err(),
                "accepted {fault}"
            );
        }
    }

    #[tokio::test]
    async fn failed_sql_commit_restores_projection_and_credentials() {
        for fault in ["settings", "passwords"] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("office.sqlite3");
            let (storage, loaded) = storage::Storage::open(&path).unwrap();
            let conn = rusqlite::Connection::open(&path).unwrap();
            let trigger = if fault == "settings" {
                "CREATE TRIGGER fail_events BEFORE INSERT ON events WHEN NEW.event_type = 'settings' BEGIN SELECT RAISE(ABORT, 'forced failure'); END;"
            } else {
                "CREATE TRIGGER fail_passwords BEFORE INSERT ON passwords BEGIN SELECT RAISE(ABORT, 'forced failure'); END;"
            };
            conn.execute_batch(trigger).unwrap();
            drop(conn);
            let mut actor = WorkspaceActor::new();
            actor.state = State::default();
            actor.key = loaded.signing_key;
            actor.storage = Some(Arc::new(Mutex::new(storage)));
            let before = actor.snapshot();
            let result = actor
                .bootstrap(BootstrapAdminRequest {
                    name: "Admin".into(),
                    email: "admin@example.test".into(),
                    password: "sample-password-123".into(),
                    workspace_name: "Office".into(),
                    ..Default::default()
                })
                .await;
            assert!(actor.persist(before, result).await.is_err(), "{fault}");
            assert!(!actor.setup);
            assert!(actor.state.members.is_empty());
            assert!(actor.passwords.is_empty());
            assert!(actor.log.is_empty());
            drop(actor);
            let (_, loaded) = storage::Storage::open(&path).unwrap();
            assert!(loaded.events.is_empty(), "{fault}");
            assert!(!loaded.setup);
            assert!(loaded.passwords.is_empty());
        }
    }

    #[tokio::test]
    async fn public_events_replay_state_without_credentials() {
        let mut actor = WorkspaceActor::new();
        let response = actor
            .bootstrap(BootstrapAdminRequest {
                name: "Admin".into(),
                email: "admin@example.test".into(),
                password: "sample-password-123".into(),
                workspace_name: "New Office".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        let member = response.user.ok_or_else(|| "missing user").unwrap();
        let replayed = actor.log.iter().fold(Projection.init(), |state, item| {
            Projection.apply(state, &item.data)
        });
        assert_eq!(replayed.members.len(), actor.state.members.len());
        assert_eq!(replayed.settings.workspace_name, "New Office");
        assert_eq!(replayed.activity.len(), actor.state.activity.len());
        assert_eq!(actor.passwords.len(), 1);
        assert!(
            !actor
                .log
                .iter()
                .any(|event| event.name.contains("password") || event.name.contains("token"))
        );
        assert!(actor.user(&response.token).is_ok());
        let mut demoted = member;
        demoted.status = "inactive".into();
        actor.commit(Edit::Member(demoted), "Admin", "Account disabled");
        assert!(actor.user(&response.token).is_err());
    }

    #[test]
    fn expired_jwt_is_rejected() {
        let mut actor = WorkspaceActor::new();
        let member = Member {
            id: id(),
            name: "Admin".into(),
            email: "admin@example.test".into(),
            role: "admin".into(),
            status: "active".into(),
            ..Default::default()
        };
        actor
            .passwords
            .insert(member.id.clone(), "hash-present".into());
        actor.commit(Edit::Member(member.clone()), "Admin", "Created");
        let expired = Claims {
            sub: member.id,
            iss: ISSUER.into(),
            aud: AUDIENCE.into(),
            iat: 1,
            exp: 2,
            key_id: None,
            key_scopes: None,
        };
        let token = encode(
            &Header::new(Algorithm::HS256),
            &expired,
            &EncodingKey::from_secret(&actor.key),
        )
        .unwrap();
        assert!(actor.user(&token).is_err());
    }

    #[tokio::test]
    async fn agent_key_expires_and_owner_permissions_are_rechecked() {
        let mut actor = WorkspaceActor::new();
        let admin = actor
            .bootstrap(BootstrapAdminRequest {
                name: "Admin".into(),
                email: "admin@example.test".into(),
                password: "sample-password-123".into(),
                workspace_name: "Office".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        let agent = Member {
            id: id(),
            name: "Planner".into(),
            kind: "agent".into(),
            role: "member".into(),
            status: "active".into(),
            access: vec!["projects".into()],
            ..Default::default()
        };
        actor.commit(Edit::Member(agent.clone()), "Admin", "Agent created");
        let issued = actor
            .create_agent_key(
                &admin.token,
                CreateAgentKeyRequest {
                    name: "Planner".into(),
                    scopes: vec!["projects:write".into()],
                    expires_in_days: 1,
                    member_id: agent.id.clone(),
                    ..Default::default()
                },
            )
            .unwrap();
        let token = actor.exchange_agent_key(&issued.secret).unwrap().token;
        assert!(actor.agent_identity(&token, "projects:write").is_ok());
        let mut owner = agent;
        owner.role = "member".into();
        owner.access.clear();
        actor.commit(Edit::Member(owner), "System", "Permission changed");
        assert!(actor.agent_identity(&token, "projects:write").is_err());
        let mut key = issued.key.unwrap();
        key.expires_at = now() - 1;
        actor.commit(Edit::AgentKey(key), "System", "Key expired");
        assert!(actor.agent_validate_token(&token).is_err());
    }

    #[tokio::test]
    async fn agent_token_keeps_issued_scope_ceiling() {
        let mut actor = WorkspaceActor::new();
        let admin = actor
            .bootstrap(BootstrapAdminRequest {
                name: "Admin".into(),
                email: "admin@example.test".into(),
                password: "sample-password-123".into(),
                workspace_name: "Office".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        let agent = Member {
            id: id(),
            name: "Planner".into(),
            kind: "agent".into(),
            role: "member".into(),
            status: "active".into(),
            access: vec!["projects".into()],
            ..Default::default()
        };
        actor.commit(Edit::Member(agent.clone()), "Admin", "Agent created");
        let issued = actor
            .create_agent_key(
                &admin.token,
                CreateAgentKeyRequest {
                    name: "Planner".into(),
                    member_id: agent.id,
                    scopes: vec!["projects:read".into()],
                    expires_in_days: 1,
                    ..Default::default()
                },
            )
            .unwrap();
        let token = actor.exchange_agent_key(&issued.secret).unwrap().token;
        assert!(actor.agent_identity(&token, "projects:read").is_ok());
        let mut key = issued.key.unwrap();
        key.scopes.push("projects:write".into());
        actor.commit(Edit::AgentKey(key.clone()), "System", "Scope widened");
        assert!(actor.agent_identity(&token, "projects:write").is_err());
        let later_token = actor.exchange_agent_key(&issued.secret).unwrap().token;
        assert!(actor.agent_identity(&later_token, "projects:write").is_ok());
        key.scopes.clear();
        key.scopes.push("projects:read".into());
        actor.commit(Edit::AgentKey(key), "System", "Scope narrowed");
        assert!(
            actor
                .agent_identity(&later_token, "projects:write")
                .is_err()
        );
    }

    #[tokio::test]
    async fn agent_admin_does_not_count_as_a_human_administrator() {
        let mut actor = WorkspaceActor::new();
        let admin = actor
            .bootstrap(BootstrapAdminRequest {
                name: "Admin".into(),
                email: "admin@example.test".into(),
                password: "sample-password-123".into(),
                workspace_name: "Office".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        actor.commit(
            Edit::Member(Member {
                id: id(),
                name: "Agent admin".into(),
                kind: "agent".into(),
                role: "admin".into(),
                status: "active".into(),
                ..Default::default()
            }),
            "Admin",
            "Agent created",
        );
        assert_eq!(actor.active_human_admins(), 1);
        let current = admin.user.unwrap();
        assert!(
            actor
                .save_member(
                    admin.token,
                    SaveMemberRequest {
                        member: Some(Member {
                            status: "inactive".into(),
                            ..current
                        })
                        .into(),
                        ..Default::default()
                    }
                )
                .await
                .is_err()
        );
        assert_eq!(actor.active_human_admins(), 1);
    }

    #[test]
    fn human_viewer_receives_basic_workspace_settings() {
        let actor = WorkspaceActor::new();
        let viewer = Principal {
            member: Member {
                id: id(),
                name: "Viewer".into(),
                kind: "human".into(),
                role: "viewer".into(),
                status: "active".into(),
                ..Default::default()
            },
            key_scopes: None,
        };
        assert!(actor.workspace(viewer).settings.is_set());
    }
}

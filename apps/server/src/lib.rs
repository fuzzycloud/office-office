use std::{
    collections::HashMap,
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
use proto::office::v1::*;

const MODULES: [&str; 5] = ["team", "customers", "projects", "social", "settings"];
const SCOPES: [&str; 6] = [
    "projects:read",
    "projects:write",
    "customers:read",
    "customers:write",
    "social:read",
    "social:write",
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

#[derive(Clone, Serialize, Deserialize)]
struct Claims {
    sub: String,
    iss: String,
    aud: String,
    iat: usize,
    exp: usize,
}

#[derive(Default, Clone)]
struct State {
    settings: WorkspaceSettings,
    members: Vec<Member>,
    customers: Vec<Customer>,
    projects: Vec<Project>,
    boards: Vec<Board>,
    tasks: Vec<Task>,
    agent_keys: Vec<AgentKey>,
    connections: Vec<SocialConnection>,
    posts: Vec<ScheduledPost>,
    activity: Vec<Activity>,
}
// Events contain only public workspace records. Credentials and signing keys live off-log.
#[derive(Clone)]
enum Event {
    Member(Member),
    Customer(Customer),
    Project(Project),
    Board(Board),
    Task(Task),
    AgentKey(AgentKey),
    Post(ScheduledPost),
    Settings(WorkspaceSettings),
    Activity(Activity),
}
#[derive(Clone)]
enum Edit {
    Member(Member),
    Customer(Customer),
    Project(Project),
    Board(Board),
    Task(Task),
    AgentKey(AgentKey),
    Post(ScheduledPost),
    Settings(WorkspaceSettings),
}
struct Projection;
impl Aggregate<State, Edit, Event> for Projection {
    fn init(&self) -> State {
        seed()
    }
    fn execute(&self, _state: &State, command: &Edit) -> anyhow::Result<Vec<Event>> {
        Ok(vec![match command {
            Edit::Member(v) => Event::Member(v.clone()),
            Edit::Customer(v) => Event::Customer(v.clone()),
            Edit::Project(v) => Event::Project(v.clone()),
            Edit::Board(v) => Event::Board(v.clone()),
            Edit::Task(v) => Event::Task(v.clone()),
            Edit::AgentKey(v) => Event::AgentKey(v.clone()),
            Edit::Post(v) => Event::Post(v.clone()),
            Edit::Settings(v) => Event::Settings(v.clone()),
        }])
    }
    fn apply(&self, mut state: State, event: &Event) -> State {
        match event {
            Event::Member(v) => upsert(&mut state.members, v.clone(), |x| &x.id),
            Event::Customer(v) => upsert(&mut state.customers, v.clone(), |x| &x.id),
            Event::Project(v) => upsert(&mut state.projects, v.clone(), |x| &x.id),
            Event::Board(v) => upsert(&mut state.boards, v.clone(), |x| &x.id),
            Event::Task(v) => upsert(&mut state.tasks, v.clone(), |x| &x.id),
            Event::AgentKey(v) => upsert(&mut state.agent_keys, v.clone(), |x| &x.id),
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
fn seed() -> State {
    State {
        settings: WorkspaceSettings {
            workspace_name: "Office Office Preview".into(),
            default_theme: "light".into(),
            timezone: "Asia/Kolkata".into(),
            ..Default::default()
        },
        members: vec![Member {
            id: "demo-member-1".into(),
            name: "Maya Rao (sample)".into(),
            email: "maya@example.test".into(),
            job_title: "Operations Lead".into(),
            department: "Operations".into(),
            role: "manager".into(),
            status: "pending".into(),
            access: vec!["customers".into(), "projects".into(), "social".into()],
            ..Default::default()
        }],
        customers: vec![Customer {
            id: "demo-customer-1".into(),
            name: "Asha Mehta".into(),
            company: "Example Studio".into(),
            email: "asha@example.test".into(),
            status: "active".into(),
            owner_id: "demo-member-1".into(),
            notes: "Sample customer — preview data".into(),
            ..Default::default()
        }],
        projects: vec![Project {
            id: "demo-project-1".into(),
            name: "Sample launch".into(),
            customer_id: "demo-customer-1".into(),
            owner_id: "demo-member-1".into(),
            status: "active".into(),
            summary: "Sample project for the preview".into(),
            target_date: "2026-12-01".into(),
            ..Default::default()
        }],
        boards: vec![Board {
            id: "demo-board-1".into(),
            project_id: "demo-project-1".into(),
            name: "Sample launch board (sample)".into(),
            columns: DEFAULT_COLUMNS.iter().map(|v| (*v).into()).collect(),
            ..Default::default()
        }],
        tasks: vec![Task {
            id: "demo-task-1".into(),
            project_id: "demo-project-1".into(),
            board_id: "demo-board-1".into(),
            column: "Todo".into(),
            title: "Sample task — plan launch".into(),
            description: "Sample task for the preview".into(),
            assignee_id: "demo-member-1".into(),
            priority: "medium".into(),
            ..Default::default()
        }],
        agent_keys: vec![],
        connections: vec![SocialConnection {
            id: "demo-social-1".into(),
            platform: "LinkedIn".into(),
            name: "Sample channel (disconnected)".into(),
            status: "disconnected".into(),
            demo: true,
            ..Default::default()
        }],
        posts: vec![ScheduledPost {
            id: "demo-post-1".into(),
            connection_id: "demo-social-1".into(),
            content: "Sample draft — this will never be published automatically.".into(),
            scheduled_at: "2026-12-01T09:00:00Z".into(),
            status: "draft".into(),
            author_id: "demo-member-1".into(),
            ..Default::default()
        }],
        activity: vec![],
    }
}

enum Command {
    Status(oneshot::Sender<Result<GetSetupStatusResponse, ConnectError>>),
    Bootstrap(
        BootstrapAdminRequest,
        oneshot::Sender<Result<BootstrapAdminResponse, ConnectError>>,
    ),
    Login(
        LoginRequest,
        oneshot::Sender<Result<LoginResponse, ConnectError>>,
    ),
    Workspace(
        String,
        oneshot::Sender<Result<GetWorkspaceResponse, ConnectError>>,
    ),
    Member(
        String,
        SaveMemberRequest,
        oneshot::Sender<Result<SaveMemberResponse, ConnectError>>,
    ),
    Customer(
        String,
        SaveCustomerRequest,
        oneshot::Sender<Result<SaveCustomerResponse, ConnectError>>,
    ),
    Project(
        String,
        SaveProjectRequest,
        oneshot::Sender<Result<SaveProjectResponse, ConnectError>>,
    ),
    Board(
        String,
        SaveBoardRequest,
        oneshot::Sender<Result<SaveBoardResponse, ConnectError>>,
    ),
    Task(
        String,
        SaveTaskRequest,
        oneshot::Sender<Result<SaveTaskResponse, ConnectError>>,
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
    Post(
        String,
        SavePostRequest,
        oneshot::Sender<Result<SavePostResponse, ConnectError>>,
    ),
    Settings(
        String,
        SaveSettingsRequest,
        oneshot::Sender<Result<SaveSettingsResponse, ConnectError>>,
    ),
}
struct WorkspaceActor {
    state: State,
    log: Vec<EventWrite<Event, ()>>,
    passwords: HashMap<String, String>,
    agent_secrets: HashMap<String, (String, String)>,
    key: Vec<u8>,
    setup: bool,
}
impl WorkspaceActor {
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
        }
    }
    fn commit(&mut self, edit: Edit, actor: &str, summary: &str) {
        for event in Projection.execute(&self.state, &edit).expect("valid edit") {
            let name = match &event {
                Event::Member(_) => "member_saved",
                Event::Customer(_) => "customer_saved",
                Event::Project(_) => "project_saved",
                Event::Board(_) => "board_saved",
                Event::Task(_) => "task_saved",
                Event::AgentKey(_) => "agent_key_saved",
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
    fn claims(&self, member: &Member) -> Result<(String, i64), ConnectError> {
        let expiry = now() + 900;
        let claims = Claims {
            sub: member.id.clone(),
            iss: ISSUER.into(),
            aud: AUDIENCE.into(),
            iat: now() as usize,
            exp: expiry as usize,
        };
        let token = encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(&self.key),
        )
        .map_err(|_| ConnectError::internal("token issue failed"))?;
        Ok((token, expiry))
    }
    fn user(&self, token: &str) -> Result<Member, ConnectError> {
        let mut validation = Validation::new(Algorithm::HS256);
        validation.set_issuer(&[ISSUER]);
        validation.set_audience(&[AUDIENCE]);
        let claims = decode::<Claims>(token, &DecodingKey::from_secret(&self.key), &validation)
            .map_err(|_| ConnectError::unauthenticated("session expired or invalid"))?
            .claims;
        self.state
            .members
            .iter()
            .find(|m| {
                m.id == claims.sub && m.status == "active" && self.passwords.contains_key(&m.id)
            })
            .cloned()
            .ok_or_else(|| ConnectError::unauthenticated("account inactive"))
    }
    fn permit(user: &Member, module: &str, mutate: bool) -> Result<(), ConnectError> {
        if user.role == "admin" {
            return Ok(());
        }
        if !user.access.iter().any(|v| v == module)
            || (mutate && user.role == "viewer")
            || (mutate && matches!(module, "team" | "settings"))
        {
            Err(denied())
        } else {
            Ok(())
        }
    }
    fn workspace(&self, user: Member) -> GetWorkspaceResponse {
        let can = |module: &str| user.role == "admin" || user.access.iter().any(|v| v == module);
        GetWorkspaceResponse {
            demo_mode: true,
            settings: Some(self.state.settings.clone()).into(),
            current_user: Some(user.clone()).into(),
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
        let (token, expires_at) = self.claims(&member)?;
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
            .find(|m| m.email == email && m.status == "active")
            .ok_or_else(|| ConnectError::unauthenticated("invalid credentials"))?;
        let hash = self
            .passwords
            .get(&member.id)
            .ok_or_else(|| ConnectError::unauthenticated("invalid credentials"))?;
        if !Self::verify(hash.clone(), request.password).await {
            return Err(ConnectError::unauthenticated("invalid credentials"));
        }
        let (token, expires_at) = self.claims(member)?;
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
        m.email = email(&m.email)?;
        allowed(&m.role, &["admin", "manager", "member", "viewer"], "role")?;
        allowed(&m.status, &["active", "inactive", "pending"], "status")?;
        if m.access.iter().any(|v| !MODULES.contains(&v.as_str())) {
            return Err(bad("invalid module access"));
        }
        if m.id.is_empty() {
            m.id = id();
        } else if !self.state.members.iter().any(|v| v.id == m.id) {
            return Err(bad("unknown member id"));
        }
        if self
            .state
            .members
            .iter()
            .any(|v| v.email == m.email && v.id != m.id)
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
            && self
                .state
                .members
                .iter()
                .filter(|v| v.role == "admin" && v.status == "active")
                .count()
                == 1
        {
            return Err(bad("cannot remove the last active admin"));
        }
        if !request.password.is_empty() {
            if !(12..=128).contains(&request.password.len()) {
                return Err(bad("password must be 12 to 128 bytes"));
            }
            self.passwords
                .insert(m.id.clone(), Self::hash(request.password).await?);
        }
        if !self.passwords.contains_key(&m.id) {
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
    fn save_board_as(&mut self, actor: &Member, mut board: Board) -> Result<Board, ConnectError> {
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
    fn save_task_as(&mut self, actor: &Member, mut task: Task) -> Result<Task, ConnectError> {
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
        } else if !self.state.tasks.iter().any(|v| v.id == task.id) {
            return Err(bad("unknown task id"));
        }
        task.title = task.title.trim().into();
        self.commit(Edit::Task(task.clone()), &actor.name, "Project task saved");
        Ok(task)
    }
    fn admin(&self, token: &str) -> Result<Member, ConnectError> {
        let user = self.user(token)?;
        if user.role != "admin" {
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
            Self::permit(&actor, module, action == "write")?;
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
            ..Default::default()
        };
        self.agent_secrets
            .insert(key.id.clone(), (sha256(&secret), actor.id.clone()));
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
            .filter(|key| !key.revoked && key.expires_at > now())
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
                    && member.status == "active"
                    && self.passwords.contains_key(&member.id)
            })
            .cloned()
            .ok_or_else(|| ConnectError::unauthenticated("agent key owner inactive"))?;
        Ok((key, actor))
    }
    fn agent_identity(&self, secret: &str, scope: &str) -> Result<Member, ConnectError> {
        let (key, mut actor) = self.agent_owner(secret)?;
        if !key.scopes.iter().any(|v| v == scope) {
            return Err(denied());
        }
        let (module, action) = scope.split_once(':').expect("known scope");
        Self::permit(&actor, module, action == "write")?;
        actor.name = format!("{} (AI: {})", actor.name, key.name);
        Ok(actor)
    }
    fn agent_validate_key(&self, secret: &str) -> Result<(), ConnectError> {
        self.agent_owner(secret).map(|_| ())
    }
    fn agent_workspace(&self, secret: &str) -> Result<GetWorkspaceResponse, ConnectError> {
        let (key, actor) = self.agent_owner(secret)?;
        let visible = ["projects", "customers", "social"].map(|module| {
            key.scopes
                .iter()
                .any(|scope| scope.starts_with(&format!("{module}:")))
                && Self::permit(&actor, module, false).is_ok()
        });
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
}
#[async_trait::async_trait]
impl Actor for WorkspaceActor {
    type Msg = Command;
    async fn handle(&mut self, message: Command) {
        match message {
            Command::Status(tx) => {
                let _ = tx.send(Ok(GetSetupStatusResponse {
                    needs_setup: !self.setup,
                    demo_mode: true,
                    ..Default::default()
                }));
            }
            Command::Bootstrap(v, tx) => {
                let result = self.bootstrap(v).await;
                let _ = tx.send(result);
            }
            Command::Login(v, tx) => {
                let result = self.login(v).await;
                let _ = tx.send(result);
            }
            Command::Workspace(t, tx) => {
                let result = self.user(&t).map(|u| self.workspace(u));
                let _ = tx.send(result);
            }
            Command::Member(t, v, tx) => {
                let result = self.save_member(t, v).await;
                let _ = tx.send(result);
            }
            Command::Customer(t, v, tx) => {
                let result = self.save_customer(t, v);
                let _ = tx.send(result);
            }
            Command::Project(t, v, tx) => {
                let result = self.save_project(t, v);
                let _ = tx.send(result);
            }
            Command::Board(t, v, tx) => {
                let result = self
                    .user(&t)
                    .and_then(|actor| {
                        self.save_board_as(&actor, v.board.ok_or_else(|| bad("board required"))?)
                    })
                    .map(|board| SaveBoardResponse {
                        board: Some(board).into(),
                        ..Default::default()
                    });
                let _ = tx.send(result);
            }
            Command::Task(t, v, tx) => {
                let result = self
                    .user(&t)
                    .and_then(|actor| {
                        self.save_task_as(&actor, v.task.ok_or_else(|| bad("task required"))?)
                    })
                    .map(|task| SaveTaskResponse {
                        task: Some(task).into(),
                        ..Default::default()
                    });
                let _ = tx.send(result);
            }
            Command::ListAgentKeys(t, tx) => {
                let _ = tx.send(self.list_agent_keys(&t));
            }
            Command::CreateAgentKey(t, v, tx) => {
                let _ = tx.send(self.create_agent_key(&t, v));
            }
            Command::RevokeAgentKey(t, v, tx) => {
                let _ = tx.send(self.revoke_agent_key(&t, v));
            }
            Command::AgentWorkspace(secret, tx) => {
                let _ = tx.send(self.agent_workspace(&secret));
            }
            Command::AgentValidate(secret, tx) => {
                let _ = tx.send(self.agent_validate_key(&secret));
            }
            Command::AgentBoard(secret, board, tx) => {
                let result = self
                    .agent_identity(&secret, "projects:write")
                    .and_then(|actor| self.save_board_as(&actor, board));
                let _ = tx.send(result);
            }
            Command::AgentTask(secret, task, tx) => {
                let result = self
                    .agent_identity(&secret, "projects:write")
                    .and_then(|actor| self.save_task_as(&actor, task));
                let _ = tx.send(result);
            }
            Command::Post(t, v, tx) => {
                let result = self.save_post(t, v);
                let _ = tx.send(result);
            }
            Command::Settings(t, v, tx) => {
                let result = self.save_settings(t, v);
                let _ = tx.send(result);
            }
        }
    }
}

pub struct OfficePreviewService {
    actor: ActorRef<Command>,
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
        }
    }
    async fn ask<R>(
        &self,
        make: impl FnOnce(oneshot::Sender<Result<R, ConnectError>>) -> Command,
    ) -> Result<R, ConnectError> {
        self.actor
            .ask(make)
            .await
            .map_err(|_| ConnectError::internal("workspace unavailable"))?
    }
    pub async fn agent_validate_key(&self, secret: &str) -> Result<(), ConnectError> {
        self.ask(|tx| Command::AgentValidate(secret.into(), tx))
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
    pub async fn agent_save_task(&self, secret: &str, task: Task) -> Result<Task, ConnectError> {
        self.ask(|tx| Command::AgentTask(secret.into(), task, tx))
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
        Response::ok(
            self.ask(|tx| Command::Bootstrap(req.to_owned_message(), tx))
                .await?,
        )
    }
    async fn login<'a>(
        &'a self,
        _ctx: RequestContext,
        req: ServiceRequest<'_, LoginRequest>,
    ) -> ServiceResult<impl connectrpc::Encodable<LoginResponse> + Send + use<'a>> {
        Response::ok(
            self.ask(|tx| Command::Login(req.to_owned_message(), tx))
                .await?,
        )
    }
    async fn get_workspace<'a>(
        &'a self,
        ctx: RequestContext,
        _req: ServiceRequest<'_, GetWorkspaceRequest>,
    ) -> ServiceResult<impl connectrpc::Encodable<GetWorkspaceResponse> + Send + use<'a>> {
        let token = bearer(&ctx)?;
        Response::ok(self.ask(|tx| Command::Workspace(token, tx)).await?)
    }
    async fn save_member<'a>(
        &'a self,
        ctx: RequestContext,
        req: ServiceRequest<'_, SaveMemberRequest>,
    ) -> ServiceResult<impl connectrpc::Encodable<SaveMemberResponse> + Send + use<'a>> {
        let token = bearer(&ctx)?;
        Response::ok(
            self.ask(|tx| Command::Member(token, req.to_owned_message(), tx))
                .await?,
        )
    }
    async fn save_customer<'a>(
        &'a self,
        ctx: RequestContext,
        req: ServiceRequest<'_, SaveCustomerRequest>,
    ) -> ServiceResult<impl connectrpc::Encodable<SaveCustomerResponse> + Send + use<'a>> {
        let token = bearer(&ctx)?;
        Response::ok(
            self.ask(|tx| Command::Customer(token, req.to_owned_message(), tx))
                .await?,
        )
    }
    async fn save_project<'a>(
        &'a self,
        ctx: RequestContext,
        req: ServiceRequest<'_, SaveProjectRequest>,
    ) -> ServiceResult<impl connectrpc::Encodable<SaveProjectResponse> + Send + use<'a>> {
        let token = bearer(&ctx)?;
        Response::ok(
            self.ask(|tx| Command::Project(token, req.to_owned_message(), tx))
                .await?,
        )
    }
    async fn save_board<'a>(
        &'a self,
        ctx: RequestContext,
        req: ServiceRequest<'_, SaveBoardRequest>,
    ) -> ServiceResult<impl connectrpc::Encodable<SaveBoardResponse> + Send + use<'a>> {
        let token = bearer(&ctx)?;
        Response::ok(
            self.ask(|tx| Command::Board(token, req.to_owned_message(), tx))
                .await?,
        )
    }
    async fn save_task<'a>(
        &'a self,
        ctx: RequestContext,
        req: ServiceRequest<'_, SaveTaskRequest>,
    ) -> ServiceResult<impl connectrpc::Encodable<SaveTaskResponse> + Send + use<'a>> {
        let token = bearer(&ctx)?;
        Response::ok(
            self.ask(|tx| Command::Task(token, req.to_owned_message(), tx))
                .await?,
        )
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
        Response::ok(
            self.ask(|tx| Command::Post(token, req.to_owned_message(), tx))
                .await?,
        )
    }
    async fn save_settings<'a>(
        &'a self,
        ctx: RequestContext,
        req: ServiceRequest<'_, SaveSettingsRequest>,
    ) -> ServiceResult<impl connectrpc::Encodable<SaveSettingsResponse> + Send + use<'a>> {
        let token = bearer(&ctx)?;
        Response::ok(
            self.ask(|tx| Command::Settings(token, req.to_owned_message(), tx))
                .await?,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let issued = actor
            .create_agent_key(
                &admin.token,
                CreateAgentKeyRequest {
                    name: "Planner".into(),
                    scopes: vec!["projects:write".into()],
                    expires_in_days: 1,
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(
            actor
                .agent_identity(&issued.secret, "projects:write")
                .is_ok()
        );
        let mut owner = admin.user.unwrap();
        owner.role = "member".into();
        owner.access.clear();
        actor.commit(Edit::Member(owner), "System", "Permission changed");
        assert!(
            actor
                .agent_identity(&issued.secret, "projects:write")
                .is_err()
        );
        let mut key = issued.key.unwrap();
        key.expires_at = now() - 1;
        actor.commit(Edit::AgentKey(key), "System", "Key expired");
        assert!(actor.agent_validate_key(&issued.secret).is_err());
    }
}

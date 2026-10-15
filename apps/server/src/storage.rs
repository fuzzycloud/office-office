//! The single-writer durable journal. The actor stages commands before calling `append`.
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail, ensure};
use argon2::password_hash::PasswordHash;
use fs2::FileExt;
use katha::EventWrite;
use rand::RngCore;
use rusqlite::{Connection, params};
use serde::{Serialize, de::DeserializeOwned};

use crate::Event;

pub(super) struct Storage {
    conn: Connection,
    _lock: File,
    next_sequence: i64,
}

pub(super) struct Loaded {
    pub events: Vec<Event>,
    pub passwords: HashMap<String, String>,
    pub agent_secrets: HashMap<String, (String, String)>,
    pub signing_key: Vec<u8>,
    pub setup: bool,
}

fn encode<T: Serialize>(value: &T) -> Result<String> {
    Ok(serde_json::to_string(value)?)
}
fn decode<T: DeserializeOwned>(json: &str) -> Result<T> {
    Ok(serde_json::from_str(json)?)
}
fn event_parts(event: &Event) -> Result<(&'static str, String)> {
    Ok(match event {
        Event::DemoInitialized(v) => ("demo_initialized", encode(v)?),
        Event::Member(v) => ("member", encode(v)?),
        Event::Customer(v) => ("customer", encode(v)?),
        Event::Project(v) => ("project", encode(v)?),
        Event::Board(v) => ("board", encode(v)?),
        Event::Task(v) => ("task", encode(v)?),
        Event::TaskComment(v) => ("task_comment", encode(v)?),
        Event::TaskActivity(v) => ("task_activity", encode(v)?),
        Event::Report(v) => ("report", encode(v)?),
        Event::AgentKey(v) => ("agent_key", encode(v)?),
        Event::Connection(v) => ("connection", encode(v)?),
        Event::Post(v) => ("post", encode(v)?),
        Event::Settings(v) => ("settings", encode(v)?),
        Event::Activity(v) => ("activity", encode(v)?),
    })
}
fn parse_event(kind: &str, json: &str) -> Result<Event> {
    let event = match kind {
        "demo_initialized" => Event::DemoInitialized(decode(json)?),
        "member" => Event::Member(decode(json)?),
        "customer" => Event::Customer(decode(json)?),
        "project" => Event::Project(decode(json)?),
        "board" => Event::Board(decode(json)?),
        "task" => Event::Task(decode(json)?),
        "task_comment" => Event::TaskComment(decode(json)?),
        "task_activity" => Event::TaskActivity(decode(json)?),
        "report" => Event::Report(decode(json)?),
        "agent_key" => Event::AgentKey(decode(json)?),
        "connection" => Event::Connection(decode(json)?),
        "post" => Event::Post(decode(json)?),
        "settings" => Event::Settings(decode(json)?),
        "activity" => Event::Activity(decode(json)?),
        _ => bail!("unsupported event type: {kind}"),
    };
    let valid = match &event {
        Event::DemoInitialized(v) => v.scenario == "office-preview" && v.version == 1,
        Event::Member(v) => !v.id.is_empty() && !v.name.is_empty() && !v.email.is_empty(),
        Event::Customer(v) => !v.id.is_empty() && !v.name.is_empty() && !v.company.is_empty(),
        Event::Project(v) => !v.id.is_empty() && !v.name.is_empty(),
        Event::Board(v) => !v.id.is_empty() && !v.project_id.is_empty() && !v.columns.is_empty(),
        Event::Task(v) => {
            !v.id.is_empty()
                && !v.project_id.is_empty()
                && !v.board_id.is_empty()
                && !v.title.is_empty()
        }
        Event::TaskComment(v) => {
            !v.id.is_empty()
                && !v.task_id.is_empty()
                && !v.author_id.is_empty()
                && v.revision > 0
                && v.created_at > 0
                && v.updated_at >= v.created_at
                && (!v.deleted || v.body.is_empty())
                && ["human", "agent"].contains(&v.actor_kind.as_str())
        }
        Event::TaskActivity(v) => {
            !v.id.is_empty() && !v.task_id.is_empty() && !v.actor_id.is_empty() && v.occurred_at > 0
        }
        Event::Report(v) => !v.id.is_empty() && !v.title.is_empty() && v.revision > 0,
        Event::AgentKey(v) => !v.id.is_empty() && !v.name.is_empty() && !v.scopes.is_empty(),
        Event::Connection(v) => {
            !v.id.is_empty() && !v.name.is_empty() && v.demo && v.status == "disconnected"
        }
        Event::Post(v) => !v.id.is_empty() && !v.content.is_empty(),
        Event::Settings(v) => {
            !v.workspace_name.is_empty() && !v.default_theme.is_empty() && !v.timezone.is_empty()
        }
        Event::Activity(v) => !v.id.is_empty() && !v.kind.is_empty() && !v.occurred_at.is_empty(),
    };
    ensure!(valid, "incomplete {kind} event payload");
    Ok(event)
}

#[cfg(unix)]
fn private_file(path: &Path, new: bool) -> Result<File> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let mut options = OpenOptions::new();
    options.read(true).write(true).mode(0o600);
    if new {
        options.create_new(true);
    }
    let file = options
        .open(path)
        .with_context(|| format!("open {}", path.display()))?;
    ensure!(
        file.metadata()?.permissions().mode() & 0o077 == 0,
        "{} must be accessible only by its owner",
        path.display()
    );
    Ok(file)
}
#[cfg(not(unix))]
fn private_file(path: &Path, new: bool) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    if new {
        options.create_new(true);
    }
    Ok(options.open(path)?)
}

impl Storage {
    pub fn open(path: &Path) -> Result<(Self, Loaded)> {
        ensure!(path.file_name().is_some(), "database path must name a file");
        let parent = path
            .parent()
            .filter(|v| !v.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        if !parent.exists() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                fs::DirBuilder::new()
                    .recursive(true)
                    .mode(0o700)
                    .create(parent)?;
            }
            #[cfg(not(unix))]
            fs::create_dir_all(parent)?;
        }
        let parent = parent.canonicalize()?;
        let path = parent.join(path.file_name().unwrap());
        if let Ok(meta) = fs::symlink_metadata(&path) {
            ensure!(
                meta.file_type().is_file() && !meta.file_type().is_symlink(),
                "database path must be a regular file"
            );
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                ensure!(meta.nlink() == 1, "hard-linked database is unsupported");
            }
        }
        let mut lock_name = path.as_os_str().to_os_string();
        lock_name.push(".lock");
        let lock_path = PathBuf::from(lock_name);
        if let Ok(meta) = fs::symlink_metadata(&lock_path) {
            ensure!(
                meta.file_type().is_file() && !meta.file_type().is_symlink(),
                "lock path must be a regular file"
            );
        }
        let lock = if lock_path.exists() {
            private_file(&lock_path, false)?
        } else {
            private_file(&lock_path, true)?
        };
        lock.try_lock_exclusive()
            .context("database already open by another process")?;
        let fresh = !path.exists();
        let _db_file = private_file(&path, fresh)?;
        let mut conn = Connection::open(&path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "FULL")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if fresh {
            ensure!(version == 0, "new database has unexpected schema version");
            let tx = conn.transaction()?;
            tx.execute_batch("CREATE TABLE events (
                sequence INTEGER PRIMARY KEY,
                event_id TEXT NOT NULL UNIQUE,
                event_type TEXT NOT NULL,
                event_version INTEGER NOT NULL,
                occurred_at INTEGER NOT NULL,
                payload TEXT NOT NULL
            );
            CREATE TABLE passwords (member_id TEXT PRIMARY KEY, hash TEXT NOT NULL);
            CREATE TABLE agent_secrets (key_id TEXT PRIMARY KEY, digest TEXT NOT NULL, owner_id TEXT NOT NULL);
            CREATE TABLE private_config (id INTEGER PRIMARY KEY CHECK (id = 1), signing_key BLOB NOT NULL, setup INTEGER NOT NULL CHECK (setup IN (0,1)));
            PRAGMA user_version = 1;")?;
            let mut key = vec![0u8; 32];
            rand::rngs::OsRng.fill_bytes(&mut key);
            tx.execute(
                "INSERT INTO private_config(id, signing_key, setup) VALUES(1, ?1, 0)",
                params![key],
            )?;
            tx.commit()?;
        } else {
            ensure!(
                version == 1,
                "unsupported database schema version {version}"
            );
        }
        let (signing_key, setup): (Vec<u8>, i64) = conn
            .query_row(
                "SELECT signing_key, setup FROM private_config WHERE id=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .context("missing signing key or setup state")?;
        ensure!(
            signing_key.len() == 32 && (setup == 0 || setup == 1),
            "invalid private configuration"
        );
        let mut events = Vec::new();
        let mut next_sequence = 1;
        {
            let mut stmt = conn.prepare("SELECT sequence, event_id, event_type, event_version, occurred_at, payload FROM events ORDER BY sequence")?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })?;
            for row in rows {
                let (sequence, id, kind, event_version, occurred_at, payload) = row?;
                ensure!(
                    sequence == next_sequence,
                    "event sequence gap at {next_sequence}"
                );
                ensure!(
                    uuid::Uuid::parse_str(&id).is_ok(),
                    "invalid event id at {sequence}"
                );
                ensure!(
                    event_version == 1,
                    "unsupported event version {event_version} at {sequence}"
                );
                ensure!(occurred_at > 0, "invalid event time at {sequence}");
                events.push(
                    parse_event(&kind, &payload)
                        .with_context(|| format!("invalid event at {sequence}"))?,
                );
                next_sequence += 1;
            }
        }
        let mut passwords = HashMap::new();
        {
            let mut stmt = conn.prepare("SELECT member_id, hash FROM passwords")?;
            for row in stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))? {
                let (id, hash): (String, String) = row?;
                let parsed = PasswordHash::new(&hash)
                    .map_err(|_| anyhow::anyhow!("invalid password hash for {id}"))?;
                ensure!(
                    parsed.algorithm.as_str() == "argon2id"
                        && parsed.salt.is_some()
                        && parsed.hash.is_some(),
                    "invalid password hash for {id}"
                );
                passwords.insert(id, hash);
            }
        }
        let mut agent_secrets = HashMap::new();
        {
            let mut stmt = conn.prepare("SELECT key_id, digest, owner_id FROM agent_secrets")?;
            for row in stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))? {
                let (id, digest, owner): (String, String, String) = row?;
                ensure!(
                    digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_hexdigit()),
                    "invalid agent key digest for {id}"
                );
                agent_secrets.insert(id, (digest, owner));
            }
        }
        Ok((
            Self {
                conn,
                _lock: lock,
                next_sequence,
            },
            Loaded {
                events,
                passwords,
                agent_secrets,
                signing_key,
                setup: setup == 1,
            },
        ))
    }

    pub fn append(
        &mut self,
        events: &[EventWrite<Event, ()>],
        passwords: &HashMap<String, String>,
        agent_secrets: &HashMap<String, (String, String)>,
        setup: bool,
    ) -> Result<()> {
        let tx = self.conn.transaction()?;
        let mut sequence = self.next_sequence;
        for event in events {
            let (kind, payload) = event_parts(&event.data)?;
            tx.execute("INSERT INTO events(sequence, event_id, event_type, event_version, occurred_at, payload) VALUES(?1, ?2, ?3, 1, ?4, ?5)",
                params![sequence, event.id.to_string(), kind, crate::now(), payload])?;
            sequence += 1;
        }
        tx.execute("DELETE FROM passwords", [])?;
        for (id, hash) in passwords {
            tx.execute(
                "INSERT INTO passwords(member_id, hash) VALUES(?1, ?2)",
                params![id, hash],
            )?;
        }
        tx.execute("DELETE FROM agent_secrets", [])?;
        for (id, (digest, owner)) in agent_secrets {
            tx.execute(
                "INSERT INTO agent_secrets(key_id, digest, owner_id) VALUES(?1, ?2, ?3)",
                params![id, digest, owner],
            )?;
        }
        tx.execute(
            "UPDATE private_config SET setup=?1 WHERE id=1",
            params![i64::from(setup)],
        )?;
        tx.commit()?;
        self.next_sequence = sequence;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_schema_and_bad_journal_without_reinitializing() {
        for fault in ["schema", "version", "payload", "empty_member", "gap"] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("office.sqlite3");
            let (storage, _) = Storage::open(&path).unwrap();
            drop(storage);
            let conn = Connection::open(&path).unwrap();
            match fault {
                "schema" => conn.pragma_update(None, "user_version", 2).unwrap(),
                other => {
                    let sequence = if other == "gap" { 2 } else { 1 };
                    let version = if other == "version" { 2 } else { 1 };
                    let valid_member = encode(&crate::proto::office::v1::Member {
                        id: "member-1".into(),
                        name: "Admin".into(),
                        email: "admin@example.test".into(),
                        ..Default::default()
                    })
                    .unwrap();
                    let payload = match other {
                        "payload" => "{",
                        "empty_member" => "{}",
                        _ => &valid_member,
                    };
                    conn.execute("INSERT INTO events(sequence, event_id, event_type, event_version, occurred_at, payload) VALUES(?1, ?2, 'member', ?3, 1, ?4)",
                        params![sequence, uuid::Uuid::new_v4().to_string(), version, payload]).unwrap();
                }
            }
            drop(conn);
            assert!(Storage::open(&path).is_err(), "accepted {fault}");
            let conn = Connection::open(&path).unwrap();
            if fault == "schema" {
                let version: i64 = conn
                    .pragma_query_value(None, "user_version", |r| r.get(0))
                    .unwrap();
                assert_eq!(version, 2);
            } else {
                let count: i64 = conn
                    .query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))
                    .unwrap();
                assert_eq!(count, 1);
            }
        }
    }
}

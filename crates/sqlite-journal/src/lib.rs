use anyhow::{Context, ensure};
use katha::EventWrite;
use rusqlite::{Connection, Transaction, params};
use serde_json::Value;
use uuid::Uuid;

/// An event in the Office Office six-column journal format.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RawJournalEvent {
    pub sequence: i64,
    pub event_id: Uuid,
    pub event_type: String,
    pub event_version: i64,
    pub occurred_at: i64,
    pub payload: String,
}

/// Creates the existing Office Office event table without owning the connection.
pub fn create_events_table(tx: &Transaction<'_>) -> anyhow::Result<()> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS events (
            sequence INTEGER PRIMARY KEY,
            event_id TEXT NOT NULL UNIQUE,
            event_type TEXT NOT NULL,
            event_version INTEGER NOT NULL,
            occurred_at INTEGER NOT NULL,
            payload TEXT NOT NULL
        );",
    )?;
    Ok(())
}

/// Reads and validates the journal while preserving the stored payload bytes.
pub fn load_events(conn: &Connection) -> anyhow::Result<Vec<RawJournalEvent>> {
    let mut statement = conn.prepare(
        "SELECT sequence, event_id, event_type, event_version, occurred_at, payload
         FROM events ORDER BY sequence",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, String>(5)?,
        ))
    })?;

    let mut events = Vec::new();
    for row in rows {
        let (sequence, event_id, event_type, event_version, occurred_at, payload) = row?;
        let expected = i64::try_from(events.len())
            .context("journal contains more events than can be sequenced")?
            .checked_add(1)
            .context("journal sequence overflow")?;
        ensure!(
            sequence == expected,
            "journal sequence gap: expected {expected}, found {sequence}"
        );
        let event_id = Uuid::parse_str(&event_id).context("invalid event UUID")?;
        ensure!(
            event_version == 1,
            "unsupported event version {event_version}"
        );
        ensure!(occurred_at > 0, "event timestamp must be positive");
        ensure!(
            serde_json::from_str::<Value>(&payload).is_ok(),
            "event payload is not valid JSON"
        );
        events.push(RawJournalEvent {
            sequence,
            event_id,
            event_type,
            event_version,
            occurred_at,
            payload,
        });
    }
    Ok(events)
}

/// Inserts Katha writes into a caller-owned transaction using the existing schema.
/// The caller remains responsible for commit/rollback and any coupled private writes.
pub fn append_events_in_tx<E, M, F>(
    tx: &Transaction<'_>,
    first_sequence: i64,
    events: &[EventWrite<E, M>],
    occurred_at: i64,
    encode: F,
) -> anyhow::Result<i64>
where
    F: Fn(&E) -> anyhow::Result<(String, String)>,
{
    ensure!(first_sequence > 0, "first sequence must be positive");
    ensure!(occurred_at > 0, "event timestamp must be positive");
    let actual_next: i64 = tx.query_row(
        "SELECT COALESCE(MAX(sequence), 0) + 1 FROM events",
        [],
        |row| row.get(0),
    )?;
    ensure!(
        actual_next == first_sequence,
        "stale sequence: expected {actual_next}, got {first_sequence}"
    );

    let mut next_sequence = first_sequence;
    for event in events {
        ensure!(
            event.correlation_id.is_none(),
            "journal schema cannot store correlation IDs"
        );
        ensure!(
            event.causation_id.is_none(),
            "journal schema cannot store causation IDs"
        );
        ensure!(
            event.metadata.is_none(),
            "journal schema cannot store event metadata"
        );
        ensure!(
            !event.name.trim().is_empty(),
            "event type must not be empty"
        );
        let (event_type, payload) = encode(&event.data)?;
        ensure!(
            !event_type.trim().is_empty(),
            "encoded event type must not be empty"
        );
        ensure!(
            serde_json::from_str::<Value>(&payload).is_ok(),
            "encoded payload is not valid JSON"
        );
        tx.execute(
            "INSERT INTO events (sequence, event_id, event_type, event_version, occurred_at, payload)
             VALUES (?1, ?2, ?3, 1, ?4, ?5)",
            params![next_sequence, event.id.to_string(), event_type, occurred_at, payload],
        )?;
        next_sequence = next_sequence
            .checked_add(1)
            .context("event sequence overflow")?;
    }
    Ok(next_sequence)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        create_events_table(&tx).unwrap();
        tx.commit().unwrap();
        conn
    }

    fn event(id: Uuid, data: Value) -> EventWrite<Value, Value> {
        EventWrite {
            id,
            correlation_id: None,
            causation_id: None,
            name: "sample".into(),
            data,
            metadata: None,
        }
    }

    fn encode(value: &Value) -> anyhow::Result<(String, String)> {
        Ok(("sample".into(), value.to_string()))
    }

    #[test]
    fn reads_old_format_and_preserves_payload_bytes_and_order() {
        let conn = db();
        let id = Uuid::new_v4();
        let payload = "{ \"keep\" : [1, 2] }";
        conn.execute(
            "INSERT INTO events VALUES (1, ?1, 'sample', 1, 17, ?2)",
            params![id.to_string(), payload],
        )
        .unwrap();
        let loaded = load_events(&conn).unwrap();
        assert_eq!(
            loaded,
            vec![RawJournalEvent {
                sequence: 1,
                event_id: id,
                event_type: "sample".into(),
                event_version: 1,
                occurred_at: 17,
                payload: payload.into()
            }]
        );
    }

    #[test]
    fn appends_and_commits_a_batch() {
        let mut conn = db();
        let writes = [
            event(Uuid::new_v4(), json!({"n": 1})),
            event(Uuid::new_v4(), json!({"n": 2})),
        ];
        let tx = conn.transaction().unwrap();
        assert_eq!(append_events_in_tx(&tx, 1, &writes, 23, encode).unwrap(), 3);
        tx.commit().unwrap();
        let loaded = load_events(&conn).unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].occurred_at, 23);
        assert_eq!(loaded[0].event_id, writes[0].id);
        assert_eq!(loaded[0].payload, writes[0].data.to_string());
    }

    #[test]
    fn encoding_or_private_constraint_failure_rolls_back_the_batch() {
        let mut conn = db();
        conn.execute("CREATE TABLE private (value INTEGER UNIQUE)", [])
            .unwrap();
        {
            let tx = conn.transaction().unwrap();
            let writes = [
                event(Uuid::new_v4(), json!(1)),
                event(Uuid::new_v4(), json!(2)),
            ];
            let result = append_events_in_tx(&tx, 1, &writes, 1, |v| {
                if v == &json!(2) {
                    anyhow::bail!("codec failed")
                }
                encode(v)
            });
            assert!(result.is_err());
        }
        {
            let tx = conn.transaction().unwrap();
            let writes = [event(Uuid::new_v4(), json!(1))];
            append_events_in_tx(&tx, 1, &writes, 1, encode).unwrap();
            tx.execute("INSERT INTO private VALUES (1)", []).unwrap();
            assert!(tx.execute("INSERT INTO private VALUES (1)", []).is_err());
        }
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM events", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn rejects_stale_sequence_and_metadata() {
        let mut conn = db();
        let tx = conn.transaction().unwrap();
        let writes = [event(Uuid::new_v4(), json!(1))];
        assert!(append_events_in_tx(&tx, 2, &writes, 1, encode).is_err());
        let mut with_metadata = event(Uuid::new_v4(), json!(1));
        with_metadata.metadata = Some(json!({"source":"test"}));
        assert!(append_events_in_tx(&tx, 1, &[with_metadata], 1, encode).is_err());
    }

    #[test]
    fn rejects_invalid_journal_rows() {
        for (seq, version, time, payload) in [
            (2, 1, 1, "{}"),
            (1, 2, 1, "{}"),
            (1, 1, 0, "{}"),
            (1, 1, 1, "not json"),
        ] {
            let conn = db();
            conn.execute(
                "INSERT INTO events VALUES (?1, ?2, 'sample', ?3, ?4, ?5)",
                params![seq, Uuid::new_v4().to_string(), version, time, payload],
            )
            .unwrap();
            assert!(load_events(&conn).is_err());
        }
    }
}

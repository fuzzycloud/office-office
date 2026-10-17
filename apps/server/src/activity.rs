//! Durable business changes and private attention feedback, separate from inbox cursors.
use super::*;

pub(super) fn valid_entry(v: &ActivityEntry) -> bool {
    !v.id.is_empty()
        && v.sequence > 0
        && !v.kind.is_empty()
        && !v.actor_id.is_empty()
        && !v.actor_name.is_empty()
        && ["human", "agent"].contains(&v.actor_kind.as_str())
        && v.occurred_at > 0
        && v.summary.len() <= 2000
        && (v.module.is_empty() || MODULES.contains(&v.module.as_str()))
        && (v.source_kind.is_empty() == v.source_id.is_empty())
        && [
            "",
            "member",
            "customer",
            "project",
            "board",
            "task",
            "task_comment",
            "project_message",
            "report",
            "report_review",
            "file",
            "agent_key",
            "connection",
            "post",
            "settings",
            "notification",
        ]
        .contains(&v.source_kind.as_str())
}
fn page_size(size: u32) -> Result<usize, ConnectError> {
    if size > 100 {
        Err(bad("page size must be at most 100"))
    } else {
        Ok(if size == 0 { 50 } else { size } as usize)
    }
}
impl WorkspaceActor {
    pub(super) fn validate_activity_replay(&self) -> anyhow::Result<()> {
        let mut ids = std::collections::HashSet::new();
        for (i, v) in self.state.feed_entries.iter().enumerate() {
            anyhow::ensure!(
                valid_entry(v) && ids.insert(&v.id) && v.sequence == i as u64 + 1,
                "invalid feed entry"
            );
            anyhow::ensure!(
                self.state.members.iter().any(|m| m.id == v.actor_id),
                "feed actor missing"
            );
            if v.source_kind == "notification" {
                let notification = self
                    .state
                    .notification_changes
                    .iter()
                    .find(|n| n.id == v.source_id && n.revision == v.source_revision);
                anyhow::ensure!(
                    notification.is_some_and(|n| n.updated_by == v.actor_id
                        && v.audience_ids.contains(&n.sender_id)
                        && v.audience_ids.contains(&n.recipient_id)
                        && v.audience_ids
                            .iter()
                            .all(|id| *id == n.sender_id || *id == n.recipient_id)),
                    "invalid private feed audience"
                );
            }
            anyhow::ensure!(
                v.audience_ids
                    .iter()
                    .all(|id| self.state.members.iter().any(|m| m.id == *id)),
                "feed audience missing"
            );
        }
        Ok(())
    }
    pub(super) fn record_feed_entry(&mut self, actor: &Principal, mut entry: ActivityEntry) {
        entry.id = id();
        entry.sequence = self.state.feed_entries.len() as u64 + 1;
        entry.actor_id = actor.id.clone();
        entry.actor_name = actor.name.clone();
        entry.actor_kind = Self::actor_kind(actor).into();
        entry.occurred_at = now();
        let event = Event::FeedEntry(entry);
        self.log.push(EventWrite {
            id: Uuid::new_v4(),
            correlation_id: None,
            causation_id: None,
            name: "feed_entry_recorded".into(),
            data: event.clone(),
            metadata: None,
        });
        self.state = Projection.apply(std::mem::take(&mut self.state), &event);
    }
    pub(super) fn commit_actor(&mut self, edit: Edit, actor: &Principal, summary: &str) {
        self.commit_actor_visibility(edit, actor, summary, false);
    }
    pub(super) fn commit_profile_actor(
        &mut self,
        member: Member,
        actor: &Principal,
        summary: &str,
    ) {
        self.commit_actor_visibility(Edit::Member(member), actor, summary, true);
    }
    fn commit_actor_visibility(
        &mut self,
        edit: Edit,
        actor: &Principal,
        summary: &str,
        public_profile: bool,
    ) {
        let (module, kind, source_id, revision, project_id, admin_only, unchanged) = match &edit {
            Edit::DemoInitialized(_) => (
                "settings",
                "sample_initialized",
                String::new(),
                0,
                String::new(),
                true,
                false,
            ),
            Edit::Member(v) => (
                "team",
                "member_saved",
                v.id.clone(),
                0,
                String::new(),
                !public_profile,
                self.state.members.iter().any(|x| x == v),
            ),
            Edit::Customer(v) => (
                "customers",
                "customer_saved",
                v.id.clone(),
                0,
                String::new(),
                false,
                self.state.customers.iter().any(|x| x == v),
            ),
            Edit::Project(v) => (
                "projects",
                "project_saved",
                v.id.clone(),
                0,
                v.id.clone(),
                false,
                self.state.projects.iter().any(|x| x == v),
            ),
            Edit::Board(v) => (
                "projects",
                "board_saved",
                v.id.clone(),
                0,
                v.project_id.clone(),
                false,
                self.state.boards.iter().any(|x| x == v),
            ),
            Edit::Task(v) => (
                "projects",
                "task_saved",
                v.id.clone(),
                0,
                v.project_id.clone(),
                false,
                self.state.tasks.iter().any(|x| x == v),
            ),
            Edit::TaskComment(v) => (
                "projects",
                "task_comment_saved",
                v.id.clone(),
                v.revision,
                self.state
                    .tasks
                    .iter()
                    .find(|t| t.id == v.task_id)
                    .map(|t| t.project_id.clone())
                    .unwrap_or_default(),
                false,
                self.state.comments.iter().any(|x| x == v),
            ),
            Edit::ProjectMessage(v) => (
                "projects",
                "project_message_saved",
                v.id.clone(),
                v.revision,
                v.project_id.clone(),
                false,
                self.state.project_messages.iter().any(|x| x == v),
            ),
            Edit::Report(v) => (
                "reports",
                "report_saved",
                v.id.clone(),
                v.revision,
                v.project_id.clone(),
                false,
                self.state.reports.iter().any(|x| x == v),
            ),
            Edit::ReportReview(v) => (
                "reports",
                "report_review_saved",
                v.id.clone(),
                v.revision,
                self.state
                    .report_history
                    .iter()
                    .find(|r| r.id == v.report_id && r.revision == v.report_revision)
                    .map(|r| r.project_id.clone())
                    .unwrap_or_default(),
                false,
                self.state.report_reviews.iter().any(|x| x == v),
            ),
            Edit::File(v) => (
                if v.module == "profile" {
                    "team"
                } else {
                    &v.module
                },
                "file_saved",
                v.id.clone(),
                v.revision,
                if v.module == "projects" {
                    v.record_id.clone()
                } else if v.module == "reports" {
                    self.state
                        .reports
                        .iter()
                        .find(|r| r.id == v.record_id)
                        .map(|r| r.project_id.clone())
                        .unwrap_or_default()
                } else {
                    String::new()
                },
                false,
                self.state.files.iter().any(|x| x == v),
            ),
            Edit::AgentKey(v) => (
                "team",
                "agent_key_saved",
                v.id.clone(),
                0,
                String::new(),
                true,
                self.state.agent_keys.iter().any(|x| x == v),
            ),
            Edit::Connection(v) => (
                "social",
                "connection_saved",
                v.id.clone(),
                0,
                String::new(),
                false,
                self.state.connections.iter().any(|x| x == v),
            ),
            Edit::Post(v) => (
                "social",
                "post_saved",
                v.id.clone(),
                0,
                String::new(),
                false,
                self.state.posts.iter().any(|x| x == v),
            ),
            Edit::Settings(v) => (
                "settings",
                "settings_saved",
                "workspace".into(),
                0,
                String::new(),
                true,
                &self.state.settings == v,
            ),
        };
        if unchanged {
            return;
        }
        let source_kind = kind.strip_suffix("_saved").unwrap_or("");
        let entry = ActivityEntry {
            module: module.into(),
            kind: kind.into(),
            summary: summary.into(),
            source_kind: source_kind.into(),
            source_id: if source_kind.is_empty() {
                String::new()
            } else {
                source_id
            },
            source_revision: revision,
            project_id,
            admin_only,
            ..Default::default()
        };
        self.commit(edit, &actor.name, summary);
        self.record_feed_entry(actor, entry);
    }
    fn activity_visible(&self, actor: &Principal, entry: &ActivityEntry) -> bool {
        if entry.admin_only && actor.role != "admin" {
            return false;
        }
        if !entry.audience_ids.is_empty() && !entry.audience_ids.contains(&actor.id) {
            return false;
        }
        if !entry.module.is_empty() && Self::permit(actor, &entry.module, false).is_err() {
            return false;
        }
        // Private feedback inherits live source access in addition to the participant audience.
        if entry.source_kind == "notification" {
            let Some(n) = self
                .state
                .notifications
                .iter()
                .find(|n| n.id == entry.source_id)
            else {
                return false;
            };
            if n.sender_id != actor.id && n.recipient_id != actor.id {
                return false;
            }
            if !n.source_kind.is_empty()
                && self
                    .notification_reference(actor, &n.source_kind, &n.source_id, n.source_revision)
                    .is_err()
            {
                return false;
            }
        }
        true
    }
    pub(super) fn list_activity_as(
        &self,
        actor: &Principal,
        request: ListActivityRequest,
    ) -> Result<ListActivityResponse, ConnectError> {
        let size = page_size(request.page_size)?;
        if !request.module.is_empty() {
            Self::permit(actor, &request.module, false)?;
        }
        let visible: Vec<_> = self
            .state
            .feed_entries
            .iter()
            .rev()
            .filter(|v| {
                self.activity_visible(actor, v)
                    && (request.module.is_empty() || v.module == request.module)
                    && (request.project_id.is_empty() || v.project_id == request.project_id)
                    && (request.source_kind.is_empty() || v.source_kind == request.source_kind)
                    && (request.source_id.is_empty() || v.source_id == request.source_id)
            })
            .collect();
        let total_count = visible.len() as u32;
        let entries: Vec<_> = visible
            .into_iter()
            .skip(request.offset as usize)
            .take(size)
            .cloned()
            .collect();
        let end = request.offset.saturating_add(entries.len() as u32);
        Ok(ListActivityResponse {
            entries,
            total_count,
            next_offset: if end < total_count { end } else { 0 },
            ..Default::default()
        })
    }
    pub(super) fn poll_activity_as(
        &self,
        actor: &Principal,
        request: PollActivityRequest,
    ) -> Result<PollActivityResponse, ConnectError> {
        let size = page_size(request.page_size)?;
        let cursor = if request.after_cursor.is_empty() {
            0
        } else {
            let value = request
                .after_cursor
                .strip_prefix("activity:v1:")
                .ok_or_else(|| bad("invalid activity cursor"))?;
            if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
                return Err(bad("invalid activity cursor"));
            }
            value
                .parse::<u64>()
                .map_err(|_| bad("invalid activity cursor"))?
        };
        let highwater = self.state.feed_entries.len() as u64;
        if cursor > highwater {
            return Err(bad("activity cursor is ahead of current history"));
        }
        let mut visible = self
            .state
            .feed_entries
            .iter()
            .filter(|v| v.sequence > cursor && self.activity_visible(actor, v));
        let entries: Vec<_> = visible.by_ref().take(size).cloned().collect();
        let has_more = visible.next().is_some();
        let next = if has_more {
            entries.last().map_or(cursor, |v| v.sequence)
        } else {
            highwater
        };
        Ok(PollActivityResponse {
            entries,
            next_cursor: format!("activity:v1:{next}"),
            has_more,
            ..Default::default()
        })
    }
}
impl OfficePreviewService {
    pub async fn list_activity(
        &self,
        token: &str,
        request: ListActivityRequest,
    ) -> Result<ListActivityResponse, ConnectError> {
        self.ask(|tx| Command::ListActivity(token.into(), request, tx))
            .await
    }
    pub async fn poll_activity(
        &self,
        token: &str,
        request: PollActivityRequest,
    ) -> Result<PollActivityResponse, ConnectError> {
        self.ask(|tx| Command::PollActivity(token.into(), request, tx))
            .await
    }
}

//! Durable personal attention, serialized by the workspace actor.
use super::*;

const STATUSES: &[&str] = &[
    "pending",
    "claimed",
    "acknowledged",
    "dismissed",
    "cancelled",
];
const KINDS: &[&str] = &[
    "notice",
    "response_request",
    "work_request",
    "review_request",
    "blocker",
];

pub(super) fn valid_notification(v: &Notification) -> bool {
    !v.id.is_empty()
        && !v.sender_id.is_empty()
        && !v.recipient_id.is_empty()
        && required(&v.title, "title", 200).is_ok()
        && v.body.len() <= 10000
        && KINDS.contains(&v.kind.as_str())
        && STATUSES.contains(&v.status.as_str())
        && ["", "task", "project", "report", "file"].contains(&v.source_kind.as_str())
        && (v.source_kind.is_empty() == v.source_id.is_empty())
        && v.revision > 0
        && v.sequence > 0
        && v.created_sequence > 0
        && v.created_sequence <= v.sequence
        && v.created_at > 0
        && v.updated_at >= v.created_at
        && v.read_at >= 0
        && !v.updated_by.is_empty()
        && v.note.len() <= 2000
        && required(&v.request_id, "request id", 128).is_ok()
        && v.claim_id.len() <= 128
        && (v.status != "claimed" || !v.claim_id.is_empty())
}
fn page_size(value: u32) -> Result<usize, ConnectError> {
    if value > 100 {
        return Err(bad("page size must be at most 100"));
    }
    Ok(if value == 0 { 50 } else { value } as usize)
}

impl WorkspaceActor {
    pub(super) fn validate_notification_replay(&self) -> anyhow::Result<()> {
        let mut previous = HashMap::<&str, &Notification>::new();
        for (index, change) in self.state.notification_changes.iter().enumerate() {
            anyhow::ensure!(
                valid_notification(change) && change.sequence == index as u64 + 1,
                "invalid notification sequence or payload"
            );
            anyhow::ensure!(
                self.state.members.iter().any(|m| m.id == change.sender_id)
                    && self
                        .state
                        .members
                        .iter()
                        .any(|m| m.id == change.recipient_id)
                    && self.state.members.iter().any(|m| m.id == change.updated_by),
                "notification member missing"
            );
            if let Some(old) = previous.insert(&change.id, change) {
                anyhow::ensure!(
                    old.revision.checked_add(1) == Some(change.revision)
                        && old.created_sequence == change.created_sequence
                        && old.recipient_id == change.recipient_id
                        && old.sender_id == change.sender_id
                        && old.request_id == change.request_id
                        && old.title == change.title
                        && old.body == change.body
                        && old.kind == change.kind
                        && old.source_kind == change.source_kind
                        && old.source_id == change.source_id
                        && old.created_at == change.created_at,
                    "invalid notification revision"
                );
            } else {
                anyhow::ensure!(
                    change.revision == 1 && change.created_sequence == change.sequence,
                    "invalid notification creation"
                );
            }
        }
        Ok(())
    }
    fn notification_source(
        &self,
        actor: &Principal,
        kind: &str,
        source: &str,
    ) -> Result<(), ConnectError> {
        if kind.is_empty() {
            return if source.is_empty() {
                Ok(())
            } else {
                Err(bad("source kind required"))
            };
        }
        required(source, "source id", 128)?;
        let (module, exists) = match kind {
            "task" => ("projects", self.state.tasks.iter().any(|t| t.id == source)),
            "project" => (
                "projects",
                self.state.projects.iter().any(|p| p.id == source),
            ),
            "report" => ("reports", self.state.reports.iter().any(|r| r.id == source)),
            "file" => {
                let file = self
                    .state
                    .files
                    .iter()
                    .find(|f| f.id == source && !f.deleted)
                    .ok_or_else(|| ConnectError::not_found("source file not found"))?;
                (
                    if file.module == "profile" {
                        "team"
                    } else {
                        &file.module
                    },
                    true,
                )
            }
            _ => return Err(bad("invalid source kind")),
        };
        Self::permit(actor, module, false)?;
        if !exists {
            return Err(ConnectError::not_found("notification source not found"));
        }
        Ok(())
    }
    // Notification details do not enter the workspace-wide activity feed.
    fn record_notification(&mut self, notification: Notification) {
        let event = Event::Notification(notification);
        self.log.push(EventWrite {
            id: Uuid::new_v4(),
            correlation_id: None,
            causation_id: None,
            name: "notification_changed".into(),
            data: event.clone(),
            metadata: None,
        });
        self.state = Projection.apply(std::mem::take(&mut self.state), &event);
    }
    pub(super) fn create_notification_as(
        &mut self,
        actor: &Principal,
        mut request: CreateNotificationRequest,
    ) -> Result<CreateNotificationResponse, ConnectError> {
        if !["admin", "manager", "member"].contains(&actor.role.as_str()) {
            return Err(denied());
        }
        required(&request.request_id, "request id", 128)?;
        required(&request.title, "title", 200)?;
        if request.body.len() > 10000 {
            return Err(bad("body must be at most 10000 bytes"));
        }
        if request.kind.is_empty() {
            request.kind = "notice".into();
        }
        allowed(&request.kind, KINDS, "notification kind")?;
        if request.recipient_ids.is_empty() || request.recipient_ids.len() > 20 {
            return Err(bad("1 to 20 recipients required"));
        }
        let mut seen = std::collections::HashSet::new();
        request.recipient_ids.retain(|id| seen.insert(id.clone()));
        request.title = request.title.trim().into();
        // Compare the original immutable creation snapshots, even after acknowledgement.
        let existing: Vec<_> = self
            .state
            .notification_changes
            .iter()
            .filter(|n| {
                n.sender_id == actor.id && n.request_id == request.request_id && n.revision == 1
            })
            .cloned()
            .collect();
        if !existing.is_empty() {
            let same = existing.len() == request.recipient_ids.len()
                && existing
                    .iter()
                    .zip(&request.recipient_ids)
                    .all(|(n, recipient)| {
                        n.recipient_id == *recipient
                            && n.title == request.title
                            && n.body == request.body
                            && n.kind == request.kind
                            && n.source_kind == request.source_kind
                            && n.source_id == request.source_id
                    });
            return if same {
                Ok(CreateNotificationResponse {
                    notifications: existing,
                    ..Default::default()
                })
            } else {
                Err(ConnectError::already_exists(
                    "request id already used with a different payload",
                ))
            };
        }
        self.notification_source(actor, &request.source_kind, &request.source_id)?;
        // Validate the whole fanout before staging any event.
        for recipient in &request.recipient_ids {
            let member = self
                .state
                .members
                .iter()
                .find(|m| m.id == *recipient && m.status == "active")
                .ok_or_else(|| bad("active recipient required"))?;
            self.notification_source(
                &Principal {
                    member: member.clone(),
                },
                &request.source_kind,
                &request.source_id,
            )?;
        }
        let mut notifications = Vec::with_capacity(request.recipient_ids.len());
        for recipient in request.recipient_ids {
            let sequence = (self.state.notification_changes.len() as u64)
                .checked_add(1)
                .ok_or_else(|| bad("notification sequence limit"))?;
            let timestamp = now();
            let notification = Notification {
                id: id(),
                recipient_id: recipient,
                sender_id: actor.id.clone(),
                title: request.title.clone(),
                body: request.body.clone(),
                kind: request.kind.clone(),
                source_kind: request.source_kind.clone(),
                source_id: request.source_id.clone(),
                status: "pending".into(),
                created_at: timestamp,
                updated_at: timestamp,
                revision: 1,
                sequence,
                created_sequence: sequence,
                request_id: request.request_id.clone(),
                updated_by: actor.id.clone(),
                ..Default::default()
            };
            self.record_notification(notification.clone());
            notifications.push(notification);
        }
        Ok(CreateNotificationResponse {
            notifications,
            ..Default::default()
        })
    }
    pub(super) fn list_notifications_as(
        &self,
        actor: &Principal,
        request: ListNotificationsRequest,
    ) -> Result<ListNotificationsResponse, ConnectError> {
        let scope = if request.scope.is_empty() {
            "inbox"
        } else {
            &request.scope
        };
        allowed(scope, &["inbox", "sent", "all"], "notification scope")?;
        if scope == "all" && actor.role != "admin" {
            return Err(denied());
        }
        if !request.status.is_empty() {
            allowed(&request.status, STATUSES, "notification status")?;
        }
        let size = page_size(request.page_size)?;
        let mut notifications: Vec<_> = self
            .state
            .notifications
            .iter()
            .filter(|n| {
                (match scope {
                    "inbox" => n.recipient_id == actor.id,
                    "sent" => n.sender_id == actor.id,
                    _ => true,
                }) && (request.status.is_empty() || n.status == request.status)
            })
            .cloned()
            .collect();
        notifications.sort_by_key(|n| std::cmp::Reverse(n.created_sequence));
        let total_count = notifications.len() as u32;
        let notifications: Vec<_> = notifications
            .into_iter()
            .skip(request.offset as usize)
            .take(size)
            .collect();
        let end = request.offset.saturating_add(notifications.len() as u32);
        Ok(ListNotificationsResponse {
            notifications,
            total_count,
            next_offset: if end < total_count { end } else { 0 },
            ..Default::default()
        })
    }
    pub(super) fn poll_notifications_as(
        &self,
        actor: &Principal,
        request: PollNotificationsRequest,
    ) -> Result<PollNotificationsResponse, ConnectError> {
        let size = page_size(request.page_size)?;
        let cursor = if request.after_cursor.is_empty() {
            0
        } else {
            if !request.after_cursor.bytes().all(|b| b.is_ascii_digit()) {
                return Err(bad("invalid notification cursor"));
            }
            request
                .after_cursor
                .parse::<u64>()
                .map_err(|_| bad("invalid notification cursor"))?
        };
        let highwater = self.state.notification_changes.len() as u64;
        if cursor > highwater {
            return Err(bad("notification cursor is ahead of current history"));
        }
        let mut visible = self
            .state
            .notification_changes
            .iter()
            .filter(|n| n.sequence > cursor && n.recipient_id == actor.id);
        let notifications: Vec<_> = visible.by_ref().take(size).cloned().collect();
        let has_more = visible.next().is_some();
        let next_cursor = if has_more {
            notifications.last().map_or(cursor, |n| n.sequence)
        } else {
            highwater
        };
        Ok(PollNotificationsResponse {
            notifications,
            next_cursor: next_cursor.to_string(),
            has_more,
            ..Default::default()
        })
    }
    pub(super) fn update_notification_as(
        &mut self,
        actor: &Principal,
        request: UpdateNotificationRequest,
    ) -> Result<UpdateNotificationResponse, ConnectError> {
        allowed(
            &request.action,
            &["read", "claim", "acknowledge", "dismiss", "cancel"],
            "notification action",
        )?;
        if request.note.len() > 2000 {
            return Err(bad("note must be at most 2000 bytes"));
        }
        if request.claim_id.len() > 128 {
            return Err(bad("claim id must be at most 128 bytes"));
        }
        if request.action == "read" && (!request.note.is_empty() || !request.claim_id.is_empty()) {
            return Err(bad("read does not accept note or claim id"));
        }
        if request.action == "read" && (!request.note.is_empty() || !request.claim_id.is_empty()) {
            return Err(bad("read does not accept note or claim id"));
        }
        let mut notification = self
            .state
            .notifications
            .iter()
            .find(|n| n.id == request.id)
            .cloned()
            .ok_or_else(|| ConnectError::not_found("notification not found"))?;
        if request.action == "cancel" {
            if notification.sender_id != actor.id && actor.role != "admin" {
                return Err(denied());
            }
        } else if notification.recipient_id != actor.id {
            return Err(denied());
        }
        if request.action == "claim" {
            required(&request.claim_id, "claim id", 128)?;
        }
        // A lost response may be retried using the original revision. Only operations
        // whose completed identity is provable bypass the revision check.
        let safe_retry = match request.action.as_str() {
            "read" => notification.read_at > 0 && request.note.is_empty(),
            "claim" => {
                notification.status == "claimed"
                    && notification.claim_id == request.claim_id
                    && notification.note == request.note
            }
            "acknowledge" => {
                notification.status == "acknowledged"
                    && notification.claim_id == request.claim_id
                    && notification.note == request.note
            }
            "dismiss" => notification.status == "dismissed" && notification.note == request.note,
            "cancel" => notification.status == "cancelled" && notification.note == request.note,
            _ => false,
        };
        if safe_retry {
            return Ok(UpdateNotificationResponse {
                notification: Some(notification).into(),
                ..Default::default()
            });
        }
        if request.expected_revision != notification.revision {
            return Err(ConnectError::aborted("notification revision conflict"));
        }
        match request.action.as_str() {
            "read" => {
                notification.read_at = now();
            }
            "claim" => {
                if notification.status != "pending" {
                    return Err(ConnectError::aborted("notification is not pending"));
                }
                notification.status = "claimed".into();
                notification.claim_id = request.claim_id;
            }
            "acknowledge" => {
                if !["pending", "claimed"].contains(&notification.status.as_str()) {
                    return Err(ConnectError::aborted("notification cannot be acknowledged"));
                }
                if notification.claim_id != request.claim_id {
                    return Err(ConnectError::aborted("notification claim conflict"));
                }
                notification.status = "acknowledged".into();
            }
            "dismiss" | "cancel" => {
                if !["pending", "claimed"].contains(&notification.status.as_str()) {
                    return Err(ConnectError::aborted("notification already completed"));
                }
                notification.status = if request.action == "dismiss" {
                    "dismissed"
                } else {
                    "cancelled"
                }
                .into();
            }
            _ => unreachable!(),
        }
        if request.action != "read" {
            notification.note = request.note;
        }
        notification.revision = notification
            .revision
            .checked_add(1)
            .ok_or_else(|| bad("notification revision limit"))?;
        notification.sequence = (self.state.notification_changes.len() as u64)
            .checked_add(1)
            .ok_or_else(|| bad("notification sequence limit"))?;
        notification.updated_at = now();
        notification.updated_by = actor.id.clone();
        self.record_notification(notification.clone());
        Ok(UpdateNotificationResponse {
            notification: Some(notification).into(),
            ..Default::default()
        })
    }
}
impl OfficePreviewService {
    pub async fn create_notification(
        &self,
        token: &str,
        request: CreateNotificationRequest,
    ) -> Result<CreateNotificationResponse, ConnectError> {
        let EngineOutcome::Notifications(response) = self
            .execute(token, EngineCommand::CreateNotification(request))
            .await?
        else {
            unreachable!()
        };
        Ok(response)
    }
    pub async fn update_notification(
        &self,
        token: &str,
        request: UpdateNotificationRequest,
    ) -> Result<UpdateNotificationResponse, ConnectError> {
        let EngineOutcome::Notification(response) = self
            .execute(token, EngineCommand::UpdateNotification(request))
            .await?
        else {
            unreachable!()
        };
        Ok(response)
    }
    pub async fn list_notifications(
        &self,
        token: &str,
        request: ListNotificationsRequest,
    ) -> Result<ListNotificationsResponse, ConnectError> {
        self.ask(|tx| Command::ListNotifications(token.into(), request, tx))
            .await
    }
    pub async fn poll_notifications(
        &self,
        token: &str,
        request: PollNotificationsRequest,
    ) -> Result<PollNotificationsResponse, ConnectError> {
        self.ask(|tx| Command::PollNotifications(token.into(), request, tx))
            .await
    }
}

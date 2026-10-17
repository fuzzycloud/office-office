//! Structured work conversations and exact-revision editorial reviews.
use super::*;
use std::collections::HashSet;

impl WorkspaceActor {
    /// Resolve navigation context without exposing a source body or recipient list.
    pub(super) fn resolve_source_as(
        &self,
        actor: &Principal,
        request: ResolveSourceRequest,
    ) -> Result<ResolveSourceResponse, ConnectError> {
        required(&request.id, "source id", 128)?;
        let mut resolved = ResolveSourceResponse {
            kind: request.kind.clone(),
            id: request.id.clone(),
            revision: request.revision,
            ..Default::default()
        };
        if [
            "task",
            "project",
            "board",
            "customer",
            "member",
            "agent_key",
            "settings",
            "connection",
            "post",
        ]
        .contains(&request.kind.as_str())
            && request.revision != 0
        {
            return Err(bad("source does not have revision history"));
        }
        match request.kind.as_str() {
            "project" => {
                Self::permit(actor, "projects", false)?;
                let project = self
                    .state
                    .projects
                    .iter()
                    .find(|p| p.id == request.id)
                    .ok_or_else(|| ConnectError::not_found("source project not found"))?;
                resolved.project_id = project.id.clone();
                resolved.module = "projects".into();
            }
            "board" => {
                Self::permit(actor, "projects", false)?;
                let board = self
                    .state
                    .boards
                    .iter()
                    .find(|b| b.id == request.id)
                    .ok_or_else(|| ConnectError::not_found("source board not found"))?;
                resolved.project_id = board.project_id.clone();
                resolved.module = "projects".into();
            }
            "task" => {
                Self::permit(actor, "projects", false)?;
                let task = self
                    .state
                    .tasks
                    .iter()
                    .find(|t| t.id == request.id)
                    .ok_or_else(|| ConnectError::not_found("source task not found"))?;
                resolved.project_id = task.project_id.clone();
                resolved.task_id = task.id.clone();
                resolved.module = "projects".into();
            }
            "task_comment" => {
                Self::permit(actor, "projects", false)?;
                let comment = if request.revision == 0 {
                    self.state.comments.iter().find(|c| c.id == request.id)
                } else {
                    self.state
                        .comment_history
                        .iter()
                        .find(|c| c.id == request.id && c.revision == request.revision)
                }
                .ok_or_else(|| ConnectError::not_found("source comment revision not found"))?;
                let task = self
                    .state
                    .tasks
                    .iter()
                    .find(|t| t.id == comment.task_id)
                    .ok_or_else(|| ConnectError::not_found("source task not found"))?;
                resolved.project_id = task.project_id.clone();
                resolved.task_id = task.id.clone();
                resolved.revision = comment.revision;
                resolved.module = "projects".into();
            }
            "project_message" => {
                Self::permit(actor, "projects", false)?;
                let message = if request.revision == 0 {
                    self.state
                        .project_messages
                        .iter()
                        .find(|m| m.id == request.id)
                } else {
                    self.state
                        .project_message_history
                        .iter()
                        .find(|m| m.id == request.id && m.revision == request.revision)
                }
                .ok_or_else(|| ConnectError::not_found("source message revision not found"))?;
                resolved.project_id = message.project_id.clone();
                resolved.task_id = message.linked_task_id.clone();
                resolved.revision = message.revision;
                resolved.module = "projects".into();
            }
            "report" => {
                Self::permit(actor, "reports", false)?;
                let report = if request.revision == 0 {
                    self.state.reports.iter().find(|r| r.id == request.id)
                } else {
                    self.state
                        .report_history
                        .iter()
                        .find(|r| r.id == request.id && r.revision == request.revision)
                }
                .ok_or_else(|| ConnectError::not_found("source report revision not found"))?;
                resolved.project_id = report.project_id.clone();
                resolved.task_id = report.task_id.clone();
                resolved.report_id = report.id.clone();
                resolved.report_revision = report.revision;
                resolved.revision = report.revision;
                resolved.module = "reports".into();
            }
            "report_review" => {
                Self::permit(actor, "reports", false)?;
                let review = if request.revision == 0 {
                    self.state
                        .report_reviews
                        .iter()
                        .find(|r| r.id == request.id)
                } else {
                    self.state
                        .report_review_history
                        .iter()
                        .find(|r| r.id == request.id && r.revision == request.revision)
                }
                .ok_or_else(|| ConnectError::not_found("source review revision not found"))?;
                let report = self
                    .state
                    .report_history
                    .iter()
                    .find(|r| r.id == review.report_id && r.revision == review.report_revision)
                    .ok_or_else(|| ConnectError::not_found("review report revision not found"))?;
                resolved.project_id = report.project_id.clone();
                resolved.task_id = report.task_id.clone();
                resolved.report_id = report.id.clone();
                resolved.report_revision = report.revision;
                resolved.revision = review.revision;
                resolved.module = "reports".into();
            }
            "file" => {
                let current = self
                    .state
                    .files
                    .iter()
                    .find(|f| f.id == request.id && !f.deleted)
                    .ok_or_else(|| ConnectError::not_found("source file not found"))?;
                let file = if request.revision == 0 {
                    Some(current)
                } else {
                    self.state.file_history.iter().find(|f| {
                        f.id == request.id && f.revision == request.revision && !f.deleted
                    })
                }
                .ok_or_else(|| ConnectError::not_found("source file revision not found"))?;
                let module = if file.module == "profile" {
                    "team"
                } else {
                    file.module.as_str()
                };
                Self::permit(actor, module, false)?;
                resolved.module = if file.module == "profile" {
                    "team"
                } else {
                    "files"
                }
                .into();
                resolved.revision = file.revision;
                if file.module == "projects" {
                    resolved.project_id = file.record_id.clone();
                }
                if file.module == "reports" {
                    resolved.report_id = file.record_id.clone();
                    if let Some(report) = self.state.reports.iter().find(|r| r.id == file.record_id)
                    {
                        resolved.project_id = report.project_id.clone();
                        resolved.task_id = report.task_id.clone();
                    }
                }
            }
            "customer" => {
                Self::permit(actor, "customers", false)?;
                if !self.state.customers.iter().any(|c| c.id == request.id) {
                    return Err(ConnectError::not_found("source customer not found"));
                }
                resolved.module = "customers".into();
            }
            "member" => {
                Self::permit(actor, "team", false)?;
                if !self.state.members.iter().any(|m| m.id == request.id) {
                    return Err(ConnectError::not_found("source member not found"));
                }
                resolved.module = "team".into();
            }
            "agent_key" => {
                if actor.role != "admin" {
                    return Err(denied());
                }
                if !self.state.agent_keys.iter().any(|k| k.id == request.id) {
                    return Err(ConnectError::not_found("source key not found"));
                }
                resolved.module = "team".into();
            }
            "settings" => {
                if actor.role != "admin" {
                    return Err(denied());
                }
                if request.id != "workspace" {
                    return Err(ConnectError::not_found("source settings not found"));
                }
                resolved.module = "settings".into();
            }
            "connection" => {
                Self::permit(actor, "social", false)?;
                if !self.state.connections.iter().any(|c| c.id == request.id) {
                    return Err(ConnectError::not_found("source connection not found"));
                }
                resolved.module = "social".into();
            }
            "post" => {
                Self::permit(actor, "social", false)?;
                if !self.state.posts.iter().any(|p| p.id == request.id) {
                    return Err(ConnectError::not_found("source post not found"));
                }
                resolved.module = "social".into();
            }
            "notification" => {
                let notification = self
                    .state
                    .notifications
                    .iter()
                    .find(|n| n.id == request.id)
                    .ok_or_else(|| ConnectError::not_found("notification not found"))?;
                if notification.recipient_id != actor.id && notification.sender_id != actor.id {
                    return Err(denied());
                }
                let notification = if request.revision == 0 {
                    Some(notification)
                } else {
                    self.state
                        .notification_changes
                        .iter()
                        .find(|n| n.id == request.id && n.revision == request.revision)
                }
                .ok_or_else(|| ConnectError::not_found("notification revision not found"))?;
                let (kind, id, revision) = if !notification.source_kind.is_empty() {
                    (
                        &notification.source_kind,
                        &notification.source_id,
                        notification.source_revision,
                    )
                } else {
                    (
                        &notification.result_kind,
                        &notification.result_id,
                        notification.result_revision,
                    )
                };
                if !kind.is_empty() {
                    if kind == "notification" {
                        return Err(bad("nested notification source is invalid"));
                    }
                    return self.resolve_source_as(
                        actor,
                        ResolveSourceRequest {
                            kind: kind.clone(),
                            id: id.clone(),
                            revision,
                            ..Default::default()
                        },
                    );
                }
                resolved.revision = notification.revision;
                resolved.module = "notifications".into();
            }
            _ => return Err(bad("unsupported source kind")),
        }
        Ok(resolved)
    }
    pub(super) fn validate_record_reference(
        &self,
        actor: &Principal,
        reference: &RecordReference,
    ) -> Result<(), ConnectError> {
        required(&reference.id, "reference id", 128)?;
        if reference.revision == 0 {
            return Err(bad("exact reference revision required"));
        }
        let (module, exists) = match reference.kind.as_str() {
            "report" => (
                "reports",
                self.state
                    .report_history
                    .iter()
                    .any(|r| r.id == reference.id && r.revision == reference.revision),
            ),
            "file" => {
                let file = self
                    .state
                    .files
                    .iter()
                    .find(|f| f.id == reference.id && !f.deleted)
                    .ok_or_else(|| ConnectError::not_found("reference file not found"))?;
                (
                    if file.module == "profile" {
                        "team"
                    } else {
                        file.module.as_str()
                    },
                    self.state.file_history.iter().any(|f| {
                        f.id == reference.id && f.revision == reference.revision && !f.deleted
                    }),
                )
            }
            "task_comment" => (
                "projects",
                self.state
                    .comment_history
                    .iter()
                    .any(|r| r.id == reference.id && r.revision == reference.revision),
            ),
            "project_message" => (
                "projects",
                self.state
                    .project_message_history
                    .iter()
                    .any(|r| r.id == reference.id && r.revision == reference.revision),
            ),
            "report_review" => (
                "reports",
                self.state
                    .report_review_history
                    .iter()
                    .any(|r| r.id == reference.id && r.revision == reference.revision),
            ),
            _ => return Err(bad("invalid reference kind")),
        };
        Self::permit(actor, module, false)?;
        if !exists {
            return Err(ConnectError::not_found("reference revision not found"));
        }
        Ok(())
    }
    pub(super) fn validate_notification_response_as(
        &self,
        actor: &Principal,
        notification: &Notification,
        request: &UpdateNotificationRequest,
    ) -> Result<(), ConnectError> {
        if notification.source_kind == "report_review"
            && ["acknowledge", "dismiss", "cancel"].contains(&request.action.as_str())
        {
            return Err(bad(
                "use the report review decision action to resolve a review request",
            ));
        }
        if request.result_kind.is_empty() {
            return Ok(());
        }
        let owns_result = match request.result_kind.as_str() {
            "task_comment" => self.state.comment_history.iter().any(|c| {
                c.id == request.result_id
                    && c.revision == request.result_revision
                    && c.author_id == actor.id
                    && !c.deleted
            }),
            "project_message" => self.state.project_message_history.iter().any(|m| {
                m.id == request.result_id
                    && m.revision == request.result_revision
                    && m.author_id == actor.id
                    && !m.deleted
            }),
            "report" => {
                // New report revisions have stable editor attribution in the feed.
                // A legacy report author only proves authorship of its first revision.
                let editor = self.state.feed_entries.iter().find(|e| {
                    e.source_kind == "report"
                        && e.source_id == request.result_id
                        && e.source_revision == request.result_revision
                });
                editor.map_or_else(
                    || {
                        self.state.report_history.iter().any(|r| {
                            r.id == request.result_id
                                && r.revision == request.result_revision
                                && r.revision == 1
                                && r.author_id == actor.id
                        })
                    },
                    |e| e.actor_id == actor.id,
                )
            }
            "file" => self.state.file_history.iter().any(|f| {
                f.id == request.result_id
                    && f.revision == request.result_revision
                    && f.uploaded_by == actor.id
                    && !f.deleted
            }),
            "report_review" => self.state.report_review_history.iter().any(|r| {
                r.id == request.result_id
                    && r.revision == request.result_revision
                    && r.reviewer_id == actor.id
                    && ["approved", "changes_requested"].contains(&r.status.as_str())
            }),
            _ => false,
        };
        if !owns_result {
            return Err(denied());
        }
        let result = self.resolve_source_as(
            actor,
            ResolveSourceRequest {
                kind: request.result_kind.clone(),
                id: request.result_id.clone(),
                revision: request.result_revision,
                ..Default::default()
            },
        )?;
        if notification.source_kind.is_empty() {
            return Ok(());
        }
        let source = self.resolve_source_as(
            actor,
            ResolveSourceRequest {
                kind: notification.source_kind.clone(),
                id: notification.source_id.clone(),
                revision: notification.source_revision,
                ..Default::default()
            },
        )?;
        if !source.project_id.is_empty() && source.project_id != result.project_id {
            return Err(bad("response result must belong to the source project"));
        }
        if !source.task_id.is_empty()
            && !result.task_id.is_empty()
            && source.task_id != result.task_id
        {
            return Err(bad("response result must belong to the source task"));
        }
        if request.result_kind == "report_review"
            && !source.report_id.is_empty()
            && source.report_id != result.report_id
        {
            return Err(bad("response review must belong to the source report"));
        }
        Ok(())
    }
    pub(super) fn validate_review_notification_source_as(
        &self,
        actor: &Principal,
        request: &CreateNotificationRequest,
    ) -> Result<(), ConnectError> {
        if request.source_kind != "report_review" {
            return Ok(());
        }
        let review = self
            .state
            .report_review_history
            .iter()
            .find(|r| r.id == request.source_id && r.revision == request.source_revision)
            .ok_or_else(|| ConnectError::not_found("review source revision not found"))?;
        if review.requester_id != actor.id
            || request
                .recipient_ids
                .iter()
                .any(|id| *id != review.reviewer_id)
        {
            return Err(denied());
        }
        if request.kind != "review_request"
            || review.status != "pending"
            || !self
                .state
                .report_reviews
                .iter()
                .any(|r| r.id == review.id && r.status == "pending")
        {
            return Err(bad("review source must be the pending reviewer request"));
        }
        Ok(())
    }
    pub(super) fn validate_notification_result(
        &self,
        actor: &Principal,
        kind: &str,
        id: &str,
        revision: u32,
    ) -> Result<(), ConnectError> {
        if kind.is_empty() && id.is_empty() && revision == 0 {
            return Ok(());
        }
        self.validate_record_reference(
            actor,
            &RecordReference {
                kind: kind.into(),
                id: id.into(),
                revision,
                ..Default::default()
            },
        )
    }
    pub(super) fn validate_conversation_fields(
        &self,
        actor: &Principal,
        project_id: &str,
        mentions: &[String],
        references: &[RecordReference],
        responses: &[String],
    ) -> Result<(), ConnectError> {
        if mentions.len() > 20 || responses.len() > 20 || references.len() > 30 {
            return Err(bad("too many conversation recipients or references"));
        }
        for member_id in mentions.iter().chain(responses) {
            let member = self
                .state
                .members
                .iter()
                .find(|m| m.id == *member_id && m.status == "active")
                .ok_or_else(|| bad("active recipient required"))?;
            Self::permit(
                &Principal {
                    member: member.clone(),
                },
                "projects",
                false,
            )?;
        }
        for reference in references {
            allowed(
                &reference.kind,
                &["report", "file"],
                "conversation reference kind",
            )?;
            self.validate_record_reference(actor, reference)?;
            let reference_project = if reference.kind == "report" {
                self.state
                    .report_history
                    .iter()
                    .find(|r| r.id == reference.id && r.revision == reference.revision)
                    .map(|r| r.project_id.as_str())
                    .unwrap_or("")
            } else {
                let file = self
                    .state
                    .files
                    .iter()
                    .find(|f| f.id == reference.id)
                    .expect("validated file");
                match file.module.as_str() {
                    "projects" => file.record_id.as_str(),
                    "reports" => self
                        .state
                        .reports
                        .iter()
                        .find(|r| r.id == file.record_id)
                        .map(|r| r.project_id.as_str())
                        .unwrap_or(""),
                    _ => return Err(bad("profile files cannot be conversation references")),
                }
            };
            if !reference_project.is_empty() && reference_project != project_id {
                return Err(bad("reference belongs to another project"));
            }
        }
        Ok(())
    }
    pub(super) fn reconcile_conversation_attention(
        &mut self,
        actor: &Principal,
        source_kind: &str,
        source_id: &str,
        active_response_ids: Option<&[String]>,
    ) -> Result<(), ConnectError> {
        let obsolete: Vec<_> = self
            .state
            .notifications
            .iter()
            .filter(|n| {
                n.source_kind == source_kind
                    && n.source_id == source_id
                    && ["pending", "claimed"].contains(&n.status.as_str())
                    && match active_response_ids {
                        None => true,
                        Some(active) => {
                            n.kind == "response_request"
                                && !active.contains(&n.recipient_id)
                                && n.request_id
                                    == format!(
                                        "{source_kind}:{source_id}:{}:response_request",
                                        n.source_revision
                                    )
                        }
                    }
            })
            .cloned()
            .collect();
        for mut notification in obsolete {
            notification.status = "cancelled".into();
            notification.note = if active_response_ids.is_none() {
                "Source discussion was deleted"
            } else {
                "Response request recipient removed"
            }
            .into();
            notification.updated_by = actor.id.clone();
            notification.updated_at = now().max(notification.created_at);
            notification.revision = notification
                .revision
                .checked_add(1)
                .ok_or_else(|| bad("notification revision limit"))?;
            notification.sequence = (self.state.notification_changes.len() as u64)
                .checked_add(1)
                .ok_or_else(|| bad("notification sequence limit"))?;
            self.record_notification(notification.clone());
            self.record_notification_feedback(actor, &notification, "cancel");
        }
        Ok(())
    }
    // Keep source identity explicit at both comment and project-message call sites.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn notify_conversation_as(
        &mut self,
        actor: &Principal,
        source_kind: &str,
        source_id: &str,
        revision: u32,
        body: &str,
        mentions: &[String],
        responses: &[String],
    ) -> Result<(), ConnectError> {
        self.reconcile_conversation_attention(actor, source_kind, source_id, Some(responses))?;
        // Editing a body with unchanged recipients must not request work again.
        let (old_mentions, old_responses) = match source_kind {
            "task_comment" => self
                .state
                .comment_history
                .iter()
                .find(|c| c.id == source_id && c.revision.checked_add(1) == Some(revision))
                .map(|c| (c.mention_ids.clone(), c.response_recipient_ids.clone())),
            "project_message" => self
                .state
                .project_message_history
                .iter()
                .find(|m| m.id == source_id && m.revision.checked_add(1) == Some(revision))
                .map(|m| (m.mention_ids.clone(), m.response_recipient_ids.clone())),
            _ => None,
        }
        .unwrap_or_default();
        for (kind, recipients, previous) in [
            ("notice", mentions, &old_mentions),
            ("response_request", responses, &old_responses),
        ] {
            let recipients: Vec<_> = recipients
                .iter()
                .filter(|id| !previous.contains(id))
                .cloned()
                .collect();
            if recipients.is_empty() {
                continue;
            }
            self.create_notification_as(
                actor,
                CreateNotificationRequest {
                    request_id: format!("{source_kind}:{source_id}:{revision}:{kind}"),
                    title: if kind == "notice" {
                        "You were mentioned"
                    } else {
                        "Response requested"
                    }
                    .into(),
                    body: body.into(),
                    kind: kind.into(),
                    recipient_ids: recipients,
                    source_kind: source_kind.into(),
                    source_id: source_id.into(),
                    source_revision: revision,
                    ..Default::default()
                },
            )?;
        }
        Ok(())
    }
    pub(super) fn list_project_discussion_as(
        &self,
        actor: &Principal,
        request: ListProjectDiscussionRequest,
    ) -> Result<ListProjectDiscussionResponse, ConnectError> {
        Self::permit(actor, "projects", false)?;
        if !self
            .state
            .projects
            .iter()
            .any(|p| p.id == request.project_id)
        {
            return Err(ConnectError::not_found("project not found"));
        }
        Ok(ListProjectDiscussionResponse {
            messages: self
                .state
                .project_messages
                .iter()
                .filter(|m| m.project_id == request.project_id)
                .cloned()
                .collect(),
            ..Default::default()
        })
    }
    pub(super) fn save_project_message_as(
        &mut self,
        actor: &Principal,
        request: SaveProjectMessageRequest,
    ) -> Result<SaveProjectMessageResponse, ConnectError> {
        Self::permit(actor, "projects", true)?;
        let mut message = request.message.ok_or_else(|| bad("message required"))?;
        required(&message.body, "message body", 10000)?;
        if !self
            .state
            .projects
            .iter()
            .any(|p| p.id == message.project_id)
        {
            return Err(ConnectError::not_found("project not found"));
        }
        if !message.parent_id.is_empty()
            && !self
                .state
                .project_messages
                .iter()
                .any(|m| m.id == message.parent_id && m.project_id == message.project_id)
        {
            return Err(bad("parent must belong to the same project discussion"));
        }
        self.validate_conversation_fields(
            actor,
            &message.project_id,
            &message.mention_ids,
            &message.references,
            &message.response_recipient_ids,
        )?;
        if message.id.is_empty() {
            if request.expected_revision != 0 {
                return Err(ConnectError::aborted("message revision conflict"));
            }
            message.id = id();
            message.revision = 1;
            message.author_id = actor.id.clone();
            message.author_name = actor.name.clone();
            message.actor_kind = Self::actor_kind(actor).into();
            message.created_at = now();
            message.linked_task_id.clear();
        } else {
            let old = self
                .state
                .project_messages
                .iter()
                .find(|m| m.id == message.id)
                .ok_or_else(|| ConnectError::not_found("message not found"))?;
            if old.author_id != actor.id && actor.role != "admin" {
                return Err(denied());
            }
            if old.deleted || old.revision != request.expected_revision {
                return Err(ConnectError::aborted("message revision conflict"));
            }
            if old.project_id != message.project_id || old.parent_id != message.parent_id {
                return Err(bad("message project and parent are immutable"));
            }
            if message.body.trim() == old.body
                && message.mention_ids == old.mention_ids
                && message.references == old.references
                && message.response_recipient_ids == old.response_recipient_ids
            {
                return Ok(SaveProjectMessageResponse {
                    message: Some(old.clone()).into(),
                    ..Default::default()
                });
            }
            message.author_id = old.author_id.clone();
            message.author_name = old.author_name.clone();
            message.actor_kind = old.actor_kind.clone();
            message.created_at = old.created_at;
            message.linked_task_id = old.linked_task_id.clone();
            message.revision = old
                .revision
                .checked_add(1)
                .ok_or_else(|| bad("message revision limit"))?;
        }
        message.body = message.body.trim().into();
        message.deleted = false;
        message.updated_at = now().max(message.created_at);
        self.commit_actor(
            Edit::ProjectMessage(message.clone()),
            actor,
            "Project message saved",
        );
        self.notify_conversation_as(
            actor,
            "project_message",
            &message.id,
            message.revision,
            &message.body,
            &message.mention_ids,
            &message.response_recipient_ids,
        )?;
        Ok(SaveProjectMessageResponse {
            message: Some(message).into(),
            ..Default::default()
        })
    }
    pub(super) fn delete_project_message_as(
        &mut self,
        actor: &Principal,
        request: DeleteProjectMessageRequest,
    ) -> Result<DeleteProjectMessageResponse, ConnectError> {
        Self::permit(actor, "projects", true)?;
        let mut message = self
            .state
            .project_messages
            .iter()
            .find(|m| m.id == request.message_id)
            .cloned()
            .ok_or_else(|| ConnectError::not_found("message not found"))?;
        if message.author_id != actor.id && actor.role != "admin" {
            return Err(denied());
        }
        if message.revision != request.expected_revision || message.deleted {
            return Err(ConnectError::aborted("message revision conflict"));
        }
        message.revision = message
            .revision
            .checked_add(1)
            .ok_or_else(|| bad("message revision limit"))?;
        message.body.clear();
        message.deleted = true;
        message.updated_at = now().max(message.created_at);
        self.commit_actor(
            Edit::ProjectMessage(message.clone()),
            actor,
            "Project message deleted",
        );
        self.reconcile_conversation_attention(actor, "project_message", &message.id, None)?;
        Ok(DeleteProjectMessageResponse {
            message: Some(message).into(),
            ..Default::default()
        })
    }
    pub(super) fn create_task_from_message_as(
        &mut self,
        actor: &Principal,
        request: CreateTaskFromMessageRequest,
    ) -> Result<CreateTaskFromMessageResponse, ConnectError> {
        Self::permit(actor, "projects", true)?;
        if !["admin", "manager"].contains(&actor.role.as_str()) {
            return Err(denied());
        }
        let mut message = self
            .state
            .project_messages
            .iter()
            .find(|m| m.id == request.message_id)
            .cloned()
            .ok_or_else(|| ConnectError::not_found("message not found"))?;
        let mut task = request.task.ok_or_else(|| bad("task required"))?;
        if !task.id.is_empty() || task.project_id != message.project_id {
            return Err(bad("new task must belong to the source project"));
        }
        if !message.linked_task_id.is_empty() {
            let existing = self
                .state
                .tasks
                .iter()
                .find(|t| t.id == message.linked_task_id)
                .ok_or_else(|| bad("linked task missing"))?;
            if existing.source_message_revision != request.expected_revision
                || existing.title != task.title.trim()
                || existing.description != task.description
                || existing.board_id != task.board_id
                || existing.column != task.column
                || existing.assignee_id != task.assignee_id
                || existing.priority != task.priority
                || existing.due_date != task.due_date
            {
                return Err(ConnectError::already_exists(
                    "message already converted with different task details",
                ));
            }
            return Ok(CreateTaskFromMessageResponse {
                message: Some(message).into(),
                task: Some(existing.clone()).into(),
                ..Default::default()
            });
        }
        if message.deleted || message.revision != request.expected_revision {
            return Err(ConnectError::aborted("message revision conflict"));
        }
        task.source_message_id.clear();
        task.source_message_revision = 0;
        let mut task = self.save_task_as(actor, task)?;
        task.source_message_id = message.id.clone();
        task.source_message_revision = message.revision;
        self.commit_actor(
            Edit::Task(task.clone()),
            actor,
            "Task linked to project discussion",
        );
        message.linked_task_id = task.id.clone();
        message.revision = message
            .revision
            .checked_add(1)
            .ok_or_else(|| bad("message revision limit"))?;
        message.updated_at = now().max(message.created_at);
        self.commit_actor(
            Edit::ProjectMessage(message.clone()),
            actor,
            "Project message converted to task",
        );
        Ok(CreateTaskFromMessageResponse {
            message: Some(message).into(),
            task: Some(task).into(),
            ..Default::default()
        })
    }
    pub(super) fn list_report_reviews_as(
        &self,
        actor: &Principal,
        request: ListReportReviewsRequest,
    ) -> Result<ListReportReviewsResponse, ConnectError> {
        Self::permit(actor, "reports", false)?;
        if !request.status.is_empty() {
            allowed(
                &request.status,
                &["pending", "approved", "changes_requested", "cancelled"],
                "review status",
            )?;
        }
        Ok(ListReportReviewsResponse {
            reviews: self
                .state
                .report_reviews
                .iter()
                .filter(|r| {
                    (request.report_id.is_empty() || r.report_id == request.report_id)
                        && (request.report_revision == 0
                            || r.report_revision == request.report_revision)
                        && (request.status.is_empty() || r.status == request.status)
                })
                .cloned()
                .collect(),
            ..Default::default()
        })
    }
    pub(super) fn request_report_review_as(
        &mut self,
        actor: &Principal,
        request: RequestReportReviewRequest,
    ) -> Result<RequestReportReviewResponse, ConnectError> {
        Self::permit(actor, "reports", true)?;
        required(&request.request_id, "request id", 128)?;
        if request.note.len() > 2000
            || request.reviewer_ids.is_empty()
            || request.reviewer_ids.len() > 20
        {
            return Err(bad("1 to 20 reviewers and bounded note required"));
        }
        let mut seen = HashSet::new();
        let reviewers: Vec<_> = request
            .reviewer_ids
            .iter()
            .filter(|id| seen.insert(id.as_str()))
            .cloned()
            .collect();
        let existing: Vec<_> = self
            .state
            .report_review_history
            .iter()
            .filter(|r| {
                r.requester_id == actor.id && r.request_id == request.request_id && r.revision == 1
            })
            .cloned()
            .collect();
        if !existing.is_empty() {
            if existing.len() != reviewers.len()
                || !existing.iter().zip(&reviewers).all(|(r, id)| {
                    r.reviewer_id == *id
                        && r.report_id == request.report_id
                        && r.report_revision == request.report_revision
                        && r.note == request.note
                })
            {
                return Err(ConnectError::already_exists(
                    "review request id already used",
                ));
            }
            return Ok(RequestReportReviewResponse {
                reviews: existing,
                ..Default::default()
            });
        }
        let report = self
            .state
            .reports
            .iter()
            .find(|r| r.id == request.report_id)
            .ok_or_else(|| ConnectError::not_found("report not found"))?;
        if report.revision != request.report_revision {
            return Err(ConnectError::aborted(
                "review must target the current exact report revision",
            ));
        }
        if report.revision > 1
            && !self.state.feed_entries.iter().any(|e| {
                e.source_kind == "report"
                    && e.source_id == report.id
                    && e.source_revision == report.revision
            })
        {
            return Err(bad("save the report once before requesting a review"));
        }
        for reviewer_id in &reviewers {
            let edited_revision = self.state.feed_entries.iter().any(|e| {
                e.source_kind == "report"
                    && e.source_id == report.id
                    && e.source_revision == report.revision
                    && e.actor_id == *reviewer_id
            });
            if *reviewer_id == actor.id || *reviewer_id == report.author_id || edited_revision {
                return Err(bad("self review is not allowed"));
            }
            let member = self
                .state
                .members
                .iter()
                .find(|m| m.id == *reviewer_id && m.status == "active")
                .ok_or_else(|| bad("active reviewer required"))?;
            Self::permit(
                &Principal {
                    member: member.clone(),
                },
                "reports",
                true,
            )?;
            if self.state.report_reviews.iter().any(|r| {
                r.report_id == request.report_id
                    && r.report_revision == request.report_revision
                    && r.reviewer_id == *reviewer_id
                    && r.status == "pending"
            }) {
                return Err(ConnectError::already_exists(
                    "reviewer already has a pending review",
                ));
            }
        }
        let mut reviews = Vec::new();
        for reviewer_id in reviewers {
            let timestamp = now();
            let review = ReportReview {
                id: id(),
                report_id: request.report_id.clone(),
                report_revision: request.report_revision,
                requester_id: actor.id.clone(),
                reviewer_id: reviewer_id.clone(),
                status: "pending".into(),
                note: request.note.clone(),
                revision: 1,
                created_at: timestamp,
                updated_at: timestamp,
                request_id: request.request_id.clone(),
                ..Default::default()
            };
            self.commit_actor(
                Edit::ReportReview(review.clone()),
                actor,
                "Report review requested",
            );
            self.create_notification_as(
                actor,
                CreateNotificationRequest {
                    request_id: format!("review:{}", review.id),
                    title: "Report review requested".into(),
                    body: request.note.clone(),
                    kind: "review_request".into(),
                    recipient_ids: vec![reviewer_id],
                    source_kind: "report_review".into(),
                    source_id: review.id.clone(),
                    source_revision: 1,
                    ..Default::default()
                },
            )?;
            reviews.push(review);
        }
        Ok(RequestReportReviewResponse {
            reviews,
            ..Default::default()
        })
    }
    pub(super) fn decide_report_review_as(
        &mut self,
        actor: &Principal,
        request: DecideReportReviewRequest,
    ) -> Result<DecideReportReviewResponse, ConnectError> {
        Self::permit(actor, "reports", true)?;
        allowed(
            &request.status,
            &["approved", "changes_requested", "cancelled"],
            "review decision",
        )?;
        if request.note.len() > 2000 {
            return Err(bad("review note too long"));
        }
        let mut review = self
            .state
            .report_reviews
            .iter()
            .find(|r| r.id == request.review_id)
            .cloned()
            .ok_or_else(|| ConnectError::not_found("review not found"))?;
        if request.status == "cancelled" {
            if actor.id != review.requester_id
                && !["admin", "manager"].contains(&actor.role.as_str())
            {
                return Err(denied());
            }
        } else if actor.id != review.reviewer_id || actor.id == review.requester_id {
            return Err(denied());
        }
        if review.status == request.status
            && review.note == request.note
            && request.expected_revision.checked_add(1) == Some(review.revision)
        {
            return Ok(DecideReportReviewResponse {
                review: Some(review).into(),
                ..Default::default()
            });
        }
        if review.status != "pending" || review.revision != request.expected_revision {
            return Err(ConnectError::aborted("review revision conflict"));
        }
        if !self
            .state
            .reports
            .iter()
            .any(|r| r.id == review.report_id && r.revision == review.report_revision)
        {
            return Err(ConnectError::aborted("review report revision is stale"));
        }
        review.status = request.status;
        review.note = request.note;
        review.revision = review
            .revision
            .checked_add(1)
            .ok_or_else(|| bad("review revision limit"))?;
        review.updated_at = now().max(review.created_at);
        self.commit_actor(
            Edit::ReportReview(review.clone()),
            actor,
            "Report review decided",
        );
        self.reconcile_review_notification(actor, &review)?;
        Ok(DecideReportReviewResponse {
            review: Some(review).into(),
            ..Default::default()
        })
    }
    fn reconcile_review_notification(
        &mut self,
        actor: &Principal,
        review: &ReportReview,
    ) -> Result<(), ConnectError> {
        let notifications: Vec<_> = self
            .state
            .notifications
            .iter()
            .filter(|n| {
                n.source_kind == "report_review"
                    && n.source_id == review.id
                    && ["pending", "claimed"].contains(&n.status.as_str())
            })
            .cloned()
            .collect();
        for mut notification in notifications {
            notification.status = if review.status == "cancelled" {
                "cancelled"
            } else {
                "acknowledged"
            }
            .into();
            notification.note = review.note.clone();
            notification.updated_by = actor.id.clone();
            notification.updated_at = now().max(notification.created_at);
            notification.revision = notification
                .revision
                .checked_add(1)
                .ok_or_else(|| bad("notification revision limit"))?;
            notification.sequence = (self.state.notification_changes.len() as u64)
                .checked_add(1)
                .ok_or_else(|| bad("notification sequence limit"))?;
            notification.result_kind = "report_review".into();
            notification.result_id = review.id.clone();
            notification.result_revision = review.revision;
            self.record_notification(notification.clone());
            self.record_notification_feedback(
                actor,
                &notification,
                if review.status == "cancelled" {
                    "cancel"
                } else {
                    "acknowledge"
                },
            );
        }
        Ok(())
    }
    pub(super) fn cancel_stale_report_reviews(
        &mut self,
        actor: &Principal,
        report_id: &str,
        current_revision: u32,
    ) -> Result<(), ConnectError> {
        let stale: Vec<_> = self
            .state
            .report_reviews
            .iter()
            .filter(|r| {
                r.report_id == report_id
                    && r.report_revision != current_revision
                    && r.status == "pending"
            })
            .cloned()
            .collect();
        for mut review in stale {
            review.status = "cancelled".into();
            review.note = "Superseded by a newer report revision".into();
            review.revision = review
                .revision
                .checked_add(1)
                .ok_or_else(|| bad("review revision limit"))?;
            review.updated_at = now().max(review.created_at);
            self.commit_actor(
                Edit::ReportReview(review.clone()),
                actor,
                "Stale report review cancelled",
            );
            self.reconcile_review_notification(actor, &review)?;
        }
        Ok(())
    }
    pub(super) fn validate_conversations_replay(&self) -> anyhow::Result<()> {
        use anyhow::ensure;
        // Replay checks retained identity, never current status/role: departed recipients
        // and deleted file sources must not invalidate legitimate historical requests.
        let retained = |kind: &str, id: &str, revision: u32| -> bool {
            match kind {
                "" => id.is_empty() && revision == 0,
                "task" => revision == 0 && self.state.tasks.iter().any(|t| t.id == id),
                "project" => revision == 0 && self.state.projects.iter().any(|p| p.id == id),
                "report" => {
                    if revision == 0 {
                        self.state.reports.iter().any(|r| r.id == id)
                    } else {
                        self.state
                            .report_history
                            .iter()
                            .any(|r| r.id == id && r.revision == revision)
                    }
                }
                "file" => self
                    .state
                    .file_history
                    .iter()
                    .any(|f| f.id == id && (revision == 0 || f.revision == revision)),
                "task_comment" => {
                    revision > 0
                        && self
                            .state
                            .comment_history
                            .iter()
                            .any(|c| c.id == id && c.revision == revision)
                }
                "project_message" => {
                    revision > 0
                        && self
                            .state
                            .project_message_history
                            .iter()
                            .any(|m| m.id == id && m.revision == revision)
                }
                "report_review" => {
                    revision > 0
                        && self
                            .state
                            .report_review_history
                            .iter()
                            .any(|r| r.id == id && r.revision == revision)
                }
                _ => false,
            }
        };
        for notification in &self.state.notification_changes {
            ensure!(
                retained(
                    &notification.source_kind,
                    &notification.source_id,
                    notification.source_revision
                ) && retained(
                    &notification.result_kind,
                    &notification.result_id,
                    notification.result_revision
                ),
                "notification source/result revision missing"
            );
        }
        for (mentions, references, responses) in self
            .state
            .comment_history
            .iter()
            .map(|c| (&c.mention_ids, &c.references, &c.response_recipient_ids))
            .chain(
                self.state
                    .project_message_history
                    .iter()
                    .map(|m| (&m.mention_ids, &m.references, &m.response_recipient_ids)),
            )
        {
            ensure!(
                mentions.len() <= 20
                    && responses.len() <= 20
                    && references.len() <= 30
                    && mentions.iter().chain(responses).all(|id| self
                        .state
                        .members
                        .iter()
                        .any(|m| m.id == *id))
                    && references
                        .iter()
                        .all(|r| ["report", "file"].contains(&r.kind.as_str())
                            && r.revision > 0
                            && retained(&r.kind, &r.id, r.revision)),
                "invalid retained conversation references or recipients"
            );
        }
        let mut messages = HashMap::<&str, &ProjectMessage>::new();
        for message in &self.state.project_message_history {
            ensure!(
                !message.id.is_empty()
                    && !message.author_name.is_empty()
                    && ["human", "agent"].contains(&message.actor_kind.as_str())
                    && message.created_at > 0
                    && message.updated_at >= message.created_at
                    && message.body.len() <= 10000
                    && (message.deleted == message.body.trim().is_empty()),
                "invalid project message snapshot"
            );
            if let Some(old) = messages.insert(&message.id, message) {
                ensure!(
                    old.revision.checked_add(1) == Some(message.revision)
                        && old.project_id == message.project_id
                        && old.author_id == message.author_id
                        && old.parent_id == message.parent_id
                        && old.created_at == message.created_at
                        && (!old.deleted || message.deleted),
                    "invalid project message history"
                );
            } else {
                ensure!(message.revision == 1, "invalid project message creation");
            }
        }
        let mut reviews = HashMap::<&str, &ReportReview>::new();
        for review in &self.state.report_review_history {
            ensure!(
                !review.id.is_empty()
                    && review.created_at > 0
                    && review.updated_at >= review.created_at
                    && review.note.len() <= 2000
                    && ["pending", "approved", "changes_requested", "cancelled"]
                        .contains(&review.status.as_str()),
                "invalid report review snapshot"
            );
            if let Some(old) = reviews.insert(&review.id, review) {
                ensure!(
                    old.revision.checked_add(1) == Some(review.revision)
                        && old.report_id == review.report_id
                        && old.report_revision == review.report_revision
                        && old.requester_id == review.requester_id
                        && old.reviewer_id == review.reviewer_id
                        && old.created_at == review.created_at
                        && old.request_id == review.request_id
                        && old.status == "pending"
                        && review.status != "pending",
                    "invalid report review history"
                );
            } else {
                ensure!(
                    review.revision == 1 && review.status == "pending",
                    "invalid review creation"
                );
            }
        }
        for task in &self.state.tasks {
            ensure!(
                task.source_message_id.is_empty() && task.source_message_revision == 0
                    || self
                        .state
                        .project_message_history
                        .iter()
                        .any(|m| m.id == task.source_message_id
                            && m.revision == task.source_message_revision
                            && m.project_id == task.project_id)
                        && self
                            .state
                            .project_messages
                            .iter()
                            .any(|m| m.id == task.source_message_id && m.linked_task_id == task.id),
                "invalid task discussion source"
            );
        }
        for message in &self.state.project_messages {
            ensure!(
                message.revision > 0
                    && message.created_at > 0
                    && message.updated_at >= message.created_at
                    && message.body.len() <= 10000
                    && (message.deleted == message.body.trim().is_empty()),
                "invalid project message"
            );
            ensure!(
                self.state
                    .projects
                    .iter()
                    .any(|p| p.id == message.project_id)
                    && self.state.members.iter().any(|m| m.id == message.author_id),
                "message project or author missing"
            );
            ensure!(
                message.parent_id.is_empty()
                    || self
                        .state
                        .project_messages
                        .iter()
                        .any(|p| p.id == message.parent_id
                            && p.project_id == message.project_id
                            && p.id != message.id),
                "invalid message parent"
            );
            ensure!(
                message.linked_task_id.is_empty()
                    || self
                        .state
                        .tasks
                        .iter()
                        .any(|t| t.id == message.linked_task_id
                            && t.source_message_id == message.id
                            && t.project_id == message.project_id),
                "invalid message task link"
            );
        }
        for comment in &self.state.comments {
            ensure!(
                comment.parent_id.is_empty()
                    || self.state.comments.iter().any(|p| p.id == comment.parent_id
                        && p.task_id == comment.task_id
                        && p.id != comment.id),
                "invalid comment parent"
            );
        }
        for review in &self.state.report_reviews {
            ensure!(
                review.revision > 0
                    && review.created_at > 0
                    && review.updated_at >= review.created_at
                    && ["pending", "approved", "changes_requested", "cancelled"]
                        .contains(&review.status.as_str())
                    && review.note.len() <= 2000,
                "invalid report review"
            );
            ensure!(
                review.status != "pending"
                    || self
                        .state
                        .reports
                        .iter()
                        .any(|r| r.id == review.report_id && r.revision == review.report_revision),
                "pending review targets superseded report"
            );
            ensure!(
                !self
                    .state
                    .report_history
                    .iter()
                    .any(|r| r.id == review.report_id
                        && r.revision == review.report_revision
                        && r.author_id == review.reviewer_id),
                "report author cannot review own report"
            );
            ensure!(
                !self
                    .state
                    .feed_entries
                    .iter()
                    .any(|e| e.source_kind == "report"
                        && e.source_id == review.report_id
                        && e.source_revision == review.report_revision
                        && e.actor_id == review.reviewer_id),
                "report editor cannot review own revision"
            );
            ensure!(
                review.requester_id != review.reviewer_id
                    && self
                        .state
                        .members
                        .iter()
                        .any(|m| m.id == review.requester_id)
                    && self
                        .state
                        .members
                        .iter()
                        .any(|m| m.id == review.reviewer_id)
                    && self
                        .state
                        .report_history
                        .iter()
                        .any(|r| r.id == review.report_id && r.revision == review.report_revision),
                "invalid review source or recipients"
            );
        }
        Ok(())
    }
}

//! Explicit sample workspace scenario. Bootstrap calls this inside its actor snapshot.
use chrono::{Duration, Utc};
use connectrpc::ConnectError;

use crate::{EngineCommand, EngineOutcome, WorkspaceActor, id, proto::office::v1::*};

fn date_after(days: i64) -> String {
    (Utc::now().date_naive() + Duration::days(days))
        .format("%Y-%m-%d")
        .to_string()
}

fn datetime_after(days: i64, hour: u32) -> String {
    format!("{}T{hour:02}:00:00Z", date_after(days))
}

pub(super) async fn register(actor: &mut WorkspaceActor, token: &str) -> Result<(), ConnectError> {
    let EngineOutcome::Member(member) = actor
        .execute_core(
            token,
            EngineCommand::SaveMember(SaveMemberRequest {
                member: Some(Member {
                    name: "Maya Rao (sample)".into(),
                    email: format!("maya+{}@example.test", id()),
                    job_title: "Operations Lead (sample)".into(),
                    department: "Sample operations".into(),
                    role: "manager".into(),
                    status: "pending".into(),
                    access: vec![
                        "customers".into(),
                        "projects".into(),
                        "reports".into(),
                        "social".into(),
                    ],
                    ..Default::default()
                })
                .into(),
                ..Default::default()
            }),
        )
        .await?
    else {
        unreachable!()
    };
    let member_id = member.member.expect("saved member").id;

    let EngineOutcome::Member(second_member) = actor
        .execute_core(
            token,
            EngineCommand::SaveMember(SaveMemberRequest {
                member: Some(Member {
                    name: "Devika Sen (sample)".into(),
                    email: format!("devika+{}@example.test", id()),
                    job_title: "Research Associate (sample)".into(),
                    department: "Sample research".into(),
                    role: "member".into(),
                    status: "pending".into(),
                    access: vec!["customers".into(), "projects".into(), "reports".into()],
                    ..Default::default()
                })
                .into(),
                ..Default::default()
            }),
        )
        .await?
    else {
        unreachable!()
    };
    let second_member_id = second_member.member.expect("saved member").id;

    let mut customer_ids = Vec::new();
    for (name, company, status, notes) in [
        (
            "Asha Mehta (sample)",
            "Example Studio (sample)",
            "active",
            "Sample customer for exploring an active relationship.",
        ),
        (
            "Rohan Iyer (sample)",
            "Northstar Goods (sample)",
            "lead",
            "Sample lead; all contact details and company references are fictional.",
        ),
        (
            "Leena Kapoor (sample)",
            "Paper Kite Works (sample)",
            "inactive",
            "Sample inactive customer retained for workspace exploration.",
        ),
    ] {
        let EngineOutcome::Customer(customer) = actor
            .execute_core(
                token,
                EngineCommand::SaveCustomer(SaveCustomerRequest {
                    customer: Some(Customer {
                        name: name.into(),
                        company: company.into(),
                        email: format!(
                            "{}@example.test",
                            name.split_whitespace().next().unwrap().to_lowercase()
                        ),
                        status: status.into(),
                        owner_id: member_id.clone(),
                        notes: notes.into(),
                        ..Default::default()
                    })
                    .into(),
                    ..Default::default()
                }),
            )
            .await?
        else {
            unreachable!()
        };
        customer_ids.push(customer.customer.expect("saved customer").id);
    }

    let mut project_ids = Vec::new();
    for (name, customer_index, status, summary, target_days) in [
        (
            "Sample launch",
            0usize,
            "active",
            "Sample project for the Office Office preview; fictional launch planning.",
            45i64,
        ),
        (
            "Sample customer discovery",
            1,
            "on_hold",
            "Sample project on hold while fictional discovery work waits for input.",
            70,
        ),
        (
            "Sample content refresh",
            2,
            "completed",
            "Sample completed project for exploring finished work.",
            -10,
        ),
    ] {
        let EngineOutcome::Project(project) = actor
            .execute_core(
                token,
                EngineCommand::SaveProject(SaveProjectRequest {
                    project: Some(Project {
                        name: name.into(),
                        customer_id: customer_ids[customer_index].clone(),
                        owner_id: member_id.clone(),
                        status: status.into(),
                        summary: summary.into(),
                        target_date: date_after(target_days),
                        ..Default::default()
                    })
                    .into(),
                    ..Default::default()
                }),
            )
            .await?
        else {
            unreachable!()
        };
        project_ids.push(project.project.expect("saved project").id);
    }

    let board_id = |actor: &WorkspaceActor, project_id: &str| {
        actor
            .state
            .boards
            .iter()
            .find(|board| board.project_id == project_id)
            .expect("project creates default board")
            .id
            .clone()
    };
    let main_board_id = board_id(actor, &project_ids[0]);
    let EngineOutcome::Board(board) = actor
        .execute_core(
            token,
            EngineCommand::SaveBoard(SaveBoardRequest {
                board: Some(Board {
                    project_id: project_ids[0].clone(),
                    name: "Sample editorial board".into(),
                    columns: vec!["Ideas".into(), "Writing".into(), "Ready".into()],
                    ..Default::default()
                })
                .into(),
                ..Default::default()
            }),
        )
        .await?
    else {
        unreachable!()
    };
    let editorial_board_id = board.board.expect("saved board").id;

    let task_specs = [
        (
            0usize,
            main_board_id.clone(),
            "Todo",
            "Sample task — plan launch",
            "Sample task for the preview. Fictional launch planning.",
            member_id.clone(),
            "medium",
            14i64,
        ),
        (
            0,
            main_board_id.clone(),
            "In progress",
            "Sample task — outline launch story",
            "Sample work in progress for the fictional launch.",
            member_id.clone(),
            "high",
            0,
        ),
        (
            0,
            main_board_id.clone(),
            "Review",
            "Sample task — review launch checklist",
            "Sample review task; no real approval is requested.",
            second_member_id.clone(),
            "medium",
            0i64,
        ),
        (
            0,
            main_board_id.clone(),
            "Done",
            "Sample task — confirm fictional brief",
            "Sample completed task for exploring board activity.",
            second_member_id.clone(),
            "low",
            -5,
        ),
        (
            0,
            editorial_board_id.clone(),
            "Ideas",
            "Sample task — collect story ideas",
            "Sample editorial work for the preview.",
            member_id.clone(),
            "low",
            12,
        ),
        (
            0,
            editorial_board_id.clone(),
            "Writing",
            "Sample task — draft announcement",
            "Sample editorial work for the preview.",
            String::new(),
            "medium",
            20,
        ),
        (
            0,
            editorial_board_id.clone(),
            "Ready",
            "Sample task — prepare post copy",
            "Sample copy awaiting a human review; this is not an approval.",
            second_member_id.clone(),
            "medium",
            0,
        ),
        (
            1,
            board_id(actor, &project_ids[1]),
            "Todo",
            "Sample task — list discovery questions",
            "Sample task in the on-hold project.",
            second_member_id.clone(),
            "medium",
            10,
        ),
        (
            1,
            board_id(actor, &project_ids[1]),
            "In progress",
            "Sample task — map fictional customer journey",
            "Sample task for exploring an on-hold project board.",
            String::new(),
            "low",
            -2,
        ),
        (
            2,
            board_id(actor, &project_ids[2]),
            "Done",
            "Sample task — archive refresh checklist",
            "Sample completed task in a completed fictional project.",
            second_member_id.clone(),
            "low",
            -12,
        ),
    ];
    let mut task_ids = Vec::new();
    for (project_index, board_id, column, title, description, assignee_id, priority, due_days) in
        task_specs
    {
        let EngineOutcome::Task(task) = actor
            .execute_core(
                token,
                EngineCommand::SaveTask(SaveTaskRequest {
                    task: Some(Task {
                        project_id: project_ids[project_index].clone(),
                        board_id,
                        column: column.into(),
                        title: title.into(),
                        description: description.into(),
                        assignee_id,
                        priority: priority.into(),
                        due_date: if due_days == 0 {
                            String::new()
                        } else {
                            date_after(due_days)
                        },
                        ..Default::default()
                    })
                    .into(),
                    ..Default::default()
                }),
            )
            .await?
        else {
            unreachable!()
        };
        task_ids.push(task.task.expect("saved task").id);
    }

    // A move/update produces visible task activity through the same command path.
    let moved_task = actor
        .state
        .tasks
        .iter()
        .find(|task| task.id == task_ids[1])
        .expect("sample task exists")
        .clone();
    actor.execute_core(token, EngineCommand::SaveTask(SaveTaskRequest {
        task: Some(Task { column: "Review".into(), description:
            "Sample task moved for review after fictional work was completed; no approval is implied.".into(), ..moved_task }).into(),
        ..Default::default()
    })).await?;
    for body in [
        "Sample comment: kickoff notes are ready for this fictional launch task.",
        "Sample comment: the fictional outline is being drafted for exploration.",
        "Sample comment: this sample discussion does not represent a real person or approval.",
    ] {
        actor
            .execute_core(
                token,
                EngineCommand::SaveTaskComment(SaveTaskCommentRequest {
                    task_id: task_ids[0].clone(),
                    body: body.into(),
                    ..Default::default()
                }),
            )
            .await?;
    }

    for (title, kind, topic, period, summary, body, task_index) in [
        (
            "Sample research brief",
            "research",
            "Sample launch research",
            "Sample current cycle",
            "Sample research notes for the preview.",
            "# Sample research brief\n\nThis is fictional sample content for exploring the reports library.",
            0usize,
        ),
        (
            "Sample competitor review",
            "competitor_review",
            "Fictional market examples",
            "Sample current cycle",
            "Sample competitor review using invented examples only.",
            "# Sample competitor review\n\nAll organizations and observations below are fictional placeholders. No market research was performed.\n\n- Example A: fictional emphasis on onboarding.\n- Example B: fictional emphasis on collaboration.",
            2,
        ),
        (
            "Sample discovery notes",
            "research",
            "Sample customer discovery",
            "Sample current cycle",
            "Fictional discovery notes for the sample workspace.",
            "# Sample discovery notes\n\nThese sample notes contain no real customer research or claims.",
            7,
        ),
    ] {
        actor
            .execute_core(
                token,
                EngineCommand::SaveReport(SaveReportRequest {
                    report: Some(Report {
                        title: title.into(),
                        summary: summary.into(),
                        body: body.into(),
                        kind: kind.into(),
                        status: "draft".into(),
                        topic: topic.into(),
                        period: period.into(),
                        project_id: project_ids[if task_index == 7 { 1 } else { 0 }].clone(),
                        task_id: task_ids[task_index].clone(),
                        sources: vec![ReportSource {
                            title: "Fictional sample source".into(),
                            url: "https://example.test/sample-reference".into(),
                            ..Default::default()
                        }],
                        ..Default::default()
                    })
                    .into(),
                    ..Default::default()
                }),
            )
            .await?;
    }

    let EngineOutcome::SampleSocialChannel(channel) = actor
        .execute_core(
            token,
            EngineCommand::CreateSampleSocialChannel {
                platform: "LinkedIn".into(),
                name: "Sample channel (disconnected)".into(),
            },
        )
        .await?
    else {
        unreachable!()
    };
    for (content, days, hour) in [
        (
            "Sample draft — a fictional launch announcement for the disconnected demo channel.",
            14i64,
            9u32,
        ),
        (
            "Sample draft — a fictional behind-the-scenes update. No post will be published.",
            16,
            11,
        ),
        (
            "Sample draft — a fictional customer story with no real customer claims.",
            18,
            15,
        ),
    ] {
        actor
            .execute_core(
                token,
                EngineCommand::SavePost(SavePostRequest {
                    post: Some(ScheduledPost {
                        connection_id: channel.id.clone(),
                        content: content.into(),
                        scheduled_at: datetime_after(days, hour),
                        status: "draft".into(),
                        ..Default::default()
                    })
                    .into(),
                    ..Default::default()
                }),
            )
            .await?;
    }

    Ok(())
}

import { expect, test } from "./fixtures";

test("Browser assignments, structured mentions and replies reach notification polling", async ({
	office,
	page,
}) => {
	const { token } = await office.bootstrap();
	const created = await office.rpc(
		"SaveMember",
		{
			member: {
				name: "Browser recipient",
				kind: "agent",
				role: "member",
				status: "active",
			},
		},
		token,
	);
	expect(created.ok()).toBeTruthy();
	const { member, secret } = await created.json();
	const exchange = await office.rpc("ExchangeAgentKey", { key: secret });
	expect(exchange.ok()).toBeTruthy();
	const { token: recipientToken } = await exchange.json();
	const workspace = await (await office.rpc("GetWorkspace", {}, token)).json();
	const task = workspace.tasks[0];
	const manualNotifications: string[] = [];
	page.on("request", (request) => {
		if (request.url().endsWith("/CreateNotification"))
			manualNotifications.push(request.url());
	});
	await page.goto("/");
	await page.evaluate(
		(value) => sessionStorage.setItem("office-office-session", value),
		token,
	);
	await page.goto(`/projects?sourceKind=task&sourceId=${task.id}`);
	const dialog = page.getByRole("dialog").filter({
		has: page.getByRole("heading", { name: task.title, exact: true }),
	});
	await dialog.getByRole("button", { name: "Edit task", exact: true }).click();
	await dialog.getByLabel("Owner", { exact: true }).selectOption(member.id);
	await dialog.getByRole("button", { name: "Save task", exact: true }).click();
	await expect(
		dialog.getByRole("button", { name: "Edit task", exact: true }),
	).toBeVisible();
	const assigned = await (
		await office.rpc("PollNotifications", {}, recipientToken)
	).json();
	expect(assigned.notifications).toEqual([
		expect.objectContaining({
			kind: "work_request",
			sourceKind: "task",
			sourceId: task.id,
			recipientId: member.id,
		}),
	]);
	await dialog
		.getByRole("textbox", { name: "Add a comment", exact: true })
		.fill("@Browser recipient is plain text");
	await dialog
		.getByRole("button", { name: "Post comment", exact: true })
		.click();
	await expect(
		dialog.getByText("@Browser recipient is plain text", { exact: true }),
	).toBeVisible();
	const plain = await (
		await office.rpc(
			"PollNotifications",
			{ afterCursor: assigned.nextCursor },
			recipientToken,
		)
	).json();
	expect(plain.notifications ?? []).toEqual([]);
	await dialog
		.getByRole("textbox", { name: "Add a comment", exact: true })
		.fill("Please investigate this browser question");
	await dialog
		.getByRole("button", { name: /Mentions, response requests and references/ })
		.click();
	await dialog
		.getByLabel("Find teammate to mention", { exact: true })
		.fill(member.name);
	await dialog.getByLabel(`@${member.name} (AI)`, { exact: true }).check();
	await dialog
		.getByLabel(`Request response from ${member.name}`, { exact: true })
		.check();
	await dialog
		.getByRole("button", { name: "Post comment", exact: true })
		.click();
	const parent = dialog
		.getByRole("article")
		.filter({ hasText: "Please investigate this browser question" });
	await expect(parent).toBeVisible();
	const selected = await (
		await office.rpc(
			"PollNotifications",
			{ afterCursor: plain.nextCursor },
			recipientToken,
		)
	).json();
	expect(selected.notifications).toHaveLength(2);
	expect(
		selected.notifications.map((n: { kind: string }) => n.kind).sort(),
	).toEqual(["notice", "response_request"]);
	const sourceId = selected.notifications[0].sourceId;
	for (const notification of selected.notifications) {
		expect(notification).toMatchObject({
			sourceKind: "task_comment",
			sourceId,
			sourceRevision: 1,
			recipientId: member.id,
		});
	}
	const beforeReply = await (
		await office.rpc("PollNotifications", {}, token)
	).json();
	await page.evaluate(
		(value) => sessionStorage.setItem("office-office-session", value),
		recipientToken,
	);
	await page.goto(`/projects?sourceKind=task&sourceId=${task.id}`);
	await parent.getByRole("button", { name: "Reply", exact: true }).click();
	await dialog
		.getByRole("textbox", { name: "Reply to comment", exact: true })
		.fill("The browser answer is ready");
	await dialog
		.getByRole("button", { name: "Post comment", exact: true })
		.click();
	await expect(
		dialog.getByText("The browser answer is ready", { exact: true }),
	).toBeVisible();
	const discussion = await (
		await office.rpc("ListTaskDiscussion", { taskId: task.id }, token)
	).json();
	const reply = discussion.comments.find(
		(c: { body: string }) => c.body === "The browser answer is ready",
	);
	expect(reply.parentId).toBe(sourceId);
	const delivered = await (
		await office.rpc(
			"PollNotifications",
			{ afterCursor: beforeReply.nextCursor },
			token,
		)
	).json();
	expect(delivered.notifications).toEqual([
		expect.objectContaining({
			kind: "notice",
			sourceKind: "task_comment",
			sourceId: reply.id,
			sourceRevision: 1,
			body: reply.body,
		}),
	]);
	expect(
		manualNotifications,
		"Source writes generate attention through the shared engine",
	).toEqual([]);
});

test("Task replies preserve member IDs, explicit response requests and exact report revisions", async ({
	office,
	page,
}) => {
	const { token, user } = await office.bootstrap();
	const workspace = await (await office.rpc("GetWorkspace", {}, token)).json();
	const task = workspace.tasks[0];
	const reportResponse = await office.rpc(
		"SaveReport",
		{
			report: {
				title: "Browser discussion reference",
				summary: "Exact revision reference",
				body: "A report in the task project.",
				kind: "research",
				status: "draft",
				projectId: task.projectId,
				taskId: task.id,
			},
		},
		token,
	);
	expect(reportResponse.ok()).toBeTruthy();
	const { report } = await reportResponse.json();
	await page.addInitScript(
		(value) => sessionStorage.setItem("office-office-session", value),
		token,
	);
	await page.goto(`/projects?sourceKind=task&sourceId=${task.id}`);
	const dialog = page.getByRole("dialog").filter({
		has: page.getByRole("heading", { name: task.title, exact: true }),
	});
	await dialog
		.getByRole("textbox", { name: "Add a comment", exact: true })
		.fill("Structured browser comment");
	await dialog
		.getByRole("button", { name: /Mentions, response requests and references/ })
		.click();
	await dialog
		.getByLabel("Find teammate to mention", { exact: true })
		.fill(user.name);
	await dialog.getByLabel(`@${user.name}`, { exact: true }).check();
	await dialog
		.getByLabel(`Request response from ${user.name}`, { exact: true })
		.check();
	await dialog
		.getByLabel("Attach exact report or file revision", { exact: true })
		.selectOption(`report:${report.id}`);
	await dialog
		.getByRole("button", { name: "Post comment", exact: true })
		.click();
	const comment = dialog
		.getByRole("article")
		.filter({ hasText: "Structured browser comment" });
	await expect(
		comment.getByText(`@${user.name}`, { exact: true }),
	).toBeVisible();
	await expect(
		comment.getByRole("link", {
			name: `report ${report.id} · revision ${report.revision}`,
			exact: true,
		}),
	).toHaveAttribute(
		"href",
		new RegExp(`sourceId=${report.id}.*revision=${report.revision}`),
	);
	await comment.getByRole("button", { name: "Reply", exact: true }).click();
	await dialog
		.getByRole("textbox", { name: "Reply to comment", exact: true })
		.fill("Threaded browser reply");
	await dialog
		.getByRole("button", { name: "Post comment", exact: true })
		.click();
	await expect(
		dialog.getByText("Threaded browser reply", { exact: true }),
	).toBeVisible();
	const discussion = await (
		await office.rpc("ListTaskDiscussion", { taskId: task.id }, token)
	).json();
	const saved = discussion.comments.find(
		(c: { body: string }) => c.body === "Structured browser comment",
	);
	expect(saved.mentionIds).toEqual([user.id]);
	expect(saved.responseRecipientIds).toEqual([user.id]);
	expect(saved.references).toEqual([
		{ kind: "report", id: report.id, revision: report.revision },
	]);
	expect(
		discussion.comments.find(
			(c: { body: string }) => c.body === "Threaded browser reply",
		).parentId,
	).toBe(saved.id);
});

test("Project discussion creates a linked task and keeps the originating message", async ({
	office,
	page,
}) => {
	const { token } = await office.bootstrap();
	const workspace = await (await office.rpc("GetWorkspace", {}, token)).json();
	const project = workspace.projects[0];
	await page.addInitScript(
		(value) => sessionStorage.setItem("office-office-session", value),
		token,
	);
	await page.goto(`/projects?sourceKind=project&sourceId=${project.id}`);
	const discussion = page.getByRole("region", {
		name: "Project discussion",
		exact: true,
	});
	await discussion
		.getByRole("textbox", { name: "Add project message", exact: true })
		.fill("Investigate customer feedback");
	await discussion
		.getByRole("button", { name: "Post message", exact: true })
		.click();
	const message = discussion
		.getByRole("article")
		.filter({ hasText: "Investigate customer feedback" });
	await message.getByRole("button", { name: "Reply", exact: true }).click();
	await discussion
		.getByRole("textbox", { name: "Reply to project message", exact: true })
		.fill("Project reply before editing");
	await discussion
		.getByRole("button", { name: "Post message", exact: true })
		.click();
	const reply = discussion
		.getByRole("article")
		.filter({ hasText: "Project reply before editing" });
	await reply
		.getByRole("button", { name: "Edit message", exact: true })
		.click();
	await discussion
		.getByRole("textbox", { name: "Edit project message", exact: true })
		.fill("Edited project reply");
	await discussion
		.getByRole("button", { name: "Save message", exact: true })
		.click();
	const edited = discussion
		.getByRole("article")
		.filter({ hasText: "Edited project reply" });
	await expect(edited.getByRole("link", { name: /Reply to/ })).toBeVisible();
	await edited
		.getByRole("button", { name: "Delete message", exact: true })
		.click();
	await edited
		.getByRole("button", { name: "Confirm delete message", exact: true })
		.click();
	await expect(
		discussion.getByText("Message deleted", { exact: true }),
	).toBeVisible();
	await message
		.getByRole("button", { name: "Create task from message", exact: true })
		.click();
	const form = discussion.getByRole("form", {
		name: "Create task from message",
		exact: true,
	});
	await form
		.getByLabel("Task title", { exact: true })
		.fill("Follow up from project discussion");
	await form.getByRole("button", { name: "Create task", exact: true }).click();
	await expect(
		message.getByRole("link", { name: "Open created task", exact: true }),
	).toBeVisible();
	const after = await (
		await office.rpc("ListProjectDiscussion", { projectId: project.id }, token)
	).json();
	expect(after.messages[0].linkedTaskId).toBeTruthy();
	const refreshed = await (await office.rpc("GetWorkspace", {}, token)).json();
	expect(
		refreshed.tasks.find(
			(t: { id: string }) => t.id === after.messages[0].linkedTaskId,
		).sourceMessageId,
	).toBe(after.messages[0].id);
});

test("Report reviewer decides a specific revision and editing does not approve the next", async ({
	office,
	page,
}) => {
	const { token } = await office.bootstrap();
	const created = await office.rpc(
		"SaveMember",
		{
			member: {
				name: "Designated reviewer",
				email: "designated-reviewer@example.test",
				role: "member",
				kind: "human",
				status: "active",
			},
			password: "reviewer-password-123",
		},
		token,
	);
	expect(created.ok()).toBeTruthy();
	const { member: reviewer } = await created.json();
	const login = await office.rpc("Login", {
		email: "designated-reviewer@example.test",
		password: "reviewer-password-123",
	});
	const { token: reviewerToken } = await login.json();
	const report = (
		await (await office.rpc("ListReports", { pageSize: 100 }, token)).json()
	).reports[0];
	await page.goto("/");
	await page.evaluate(
		(value) => sessionStorage.setItem("office-office-session", value),
		token,
	);
	await page.goto(
		`/reports?sourceKind=report&sourceId=${report.id}&revision=${report.revision}`,
	);
	const review = page.getByRole("region", {
		name: "Report review",
		exact: true,
	});
	await review
		.getByLabel("Designated reviewer", { exact: true })
		.selectOption(reviewer.id);
	await review
		.getByRole("button", {
			name: `Request review of revision ${report.revision}`,
			exact: true,
		})
		.click();
	await expect(review.getByText("pending", { exact: true })).toBeVisible();
	await page.evaluate(
		(value) => sessionStorage.setItem("office-office-session", value),
		reviewerToken,
	);
	await page.goto(
		`/reports?sourceKind=report&sourceId=${report.id}&revision=${report.revision}`,
	);
	await review
		.getByRole("button", {
			name: `Approve revision ${report.revision}`,
			exact: true,
		})
		.click();
	await expect(review.getByText("approved", { exact: true })).toBeVisible();
	await page.evaluate(
		(value) => sessionStorage.setItem("office-office-session", value),
		token,
	);
	await page.goto(
		`/reports?sourceKind=report&sourceId=${report.id}&revision=${report.revision}`,
	);
	await page
		.getByRole("button", { name: "View latest revision", exact: true })
		.click();
	await page.getByRole("button", { name: "Edit report", exact: true }).click();
	const editor = page.getByRole("form", { name: "Report editor", exact: true });
	await editor
		.getByLabel("Short summary", { exact: true })
		.fill("Updated after review");
	await editor
		.getByRole("button", { name: "Save report", exact: true })
		.click();
	await expect(
		review.getByText(`Revision ${report.revision} (earlier revision)`, {
			exact: true,
		}),
	).toBeVisible();
	const reviews = await (
		await office.rpc("ListReportReviews", { reportId: report.id }, token)
	).json();
	expect(reviews.reviews).toHaveLength(1);
	expect(reviews.reviews[0]).toMatchObject({
		status: "approved",
		reportRevision: report.revision,
	});
});

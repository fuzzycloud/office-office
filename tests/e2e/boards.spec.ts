import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const taskTitle = "Sample task — plan launch";
async function openBoard(page: Page, url: string, token: string) {
	await page.addInitScript((value) => {
		if (!sessionStorage.getItem("office-office-session"))
			sessionStorage.setItem("office-office-session", value);
	}, token);
	await page.goto(url);
	await page.getByRole("button", { name: /^Projects/ }).click();
	await page.getByRole("button", { name: /Sample launch/ }).click();
	await expect(
		page.getByRole("button", { name: `Open task: ${taskTitle}`, exact: true }),
	).toBeVisible();
}

test("sample board counts, search, owner and priority filters; drag and accessible moves persist", async ({
	page,
	office,
}) => {
	const { token } = await office.bootstrap();
	const workspace = await (await office.rpc("GetWorkspace", {}, token)).json();
	const task = workspace.tasks.find(
		(item: { title: string }) => item.title === taskTitle,
	);
	await openBoard(page, office.url, token);
	await expect(page.getByText("4 of 4 tasks", { exact: true })).toBeVisible();
	await expect(
		page.getByRole("region", { name: "Review, 2 tasks", exact: true }),
	).toBeVisible();
	await page.getByLabel("Search tasks", { exact: true }).fill("outline");
	await expect(page.getByText("1 of 4 tasks", { exact: true })).toBeVisible();
	await page
		.getByRole("button", { name: "Clear filters", exact: true })
		.click();
	await page.getByLabel("Owner", { exact: true }).selectOption(task.assigneeId);
	await expect(page.getByText("2 of 4 tasks", { exact: true })).toBeVisible();
	await page.getByLabel("Priority", { exact: true }).selectOption("high");
	await expect(page.getByText("1 of 4 tasks", { exact: true })).toBeVisible();
	await expect(
		page.getByRole("button", {
			name: "Open task: Sample task — outline launch story",
			exact: true,
		}),
	).toBeVisible();
	await page
		.getByRole("button", { name: "Clear filters", exact: true })
		.click();
	const card = page.getByRole("article").filter({
		has: page.getByRole("button", {
			name: `Open task: ${taskTitle}`,
			exact: true,
		}),
	});
	// Initiate native dragging before scrolling to the destination below the
	// viewport; dragTo scrolls first and can move the card away from the pointer.
	await card.scrollIntoViewIfNeeded();
	const source = await card.boundingBox();
	expect(source).not.toBeNull();
	if (!source) throw new Error("Task card has no bounds");
	await page.mouse.move(source.x + 20, source.y + 20);
	await page.mouse.down();
	await page.mouse.move(source.x + 35, source.y + 25, { steps: 5 });
	const destination = page.getByRole("region", {
		name: "Done, 1 tasks",
		exact: true,
	});
	await destination.scrollIntoViewIfNeeded();
	const target = await destination.boundingBox();
	expect(target).not.toBeNull();
	if (!target) throw new Error("Destination column has no bounds");
	await page.mouse.move(target.x + 20, target.y + 20, { steps: 5 });
	await page.mouse.up();
	await expect(
		page.getByLabel(`Move ${taskTitle} to column`, { exact: true }),
	).toHaveValue("Done");
	await expect
		.poll(async () => {
			const current = await (
				await office.rpc("GetWorkspace", {}, token)
			).json();
			return current.tasks.find((item: { id: string }) => item.id === task.id)
				.column;
		})
		.toBe("Done");
	await page
		.getByLabel(`Move ${taskTitle} to column`, { exact: true })
		.selectOption("In progress");
	await expect(
		page.getByLabel(`Move ${taskTitle} to column`, { exact: true }),
	).toHaveValue("In progress");
	await expect
		.poll(async () => {
			const current = await (
				await office.rpc("GetWorkspace", {}, token)
			).json();
			return current.tasks.find((item: { id: string }) => item.id === task.id)
				.column;
		})
		.toBe("In progress");
	await page.reload();
	await page.getByRole("button", { name: /^Projects/ }).click();
	await page.getByRole("button", { name: /Sample launch/ }).click();
	await expect(
		page
			.getByRole("region", { name: "In progress, 1 tasks", exact: true })
			.getByRole("button", { name: `Open task: ${taskTitle}`, exact: true }),
	).toBeVisible();
});

test("comments create, edit and soft-delete with durable counts and linked research", async ({
	page,
	office,
}) => {
	const { token } = await office.bootstrap();
	const workspace = await (await office.rpc("GetWorkspace", {}, token)).json();
	const task = workspace.tasks.find(
		(item: { title: string }) => item.title === taskTitle,
	);
	await openBoard(page, office.url, token);
	await page
		.getByRole("button", { name: `Open task: ${taskTitle}`, exact: true })
		.click();
	const dialog = page.getByRole("dialog");
	await expect(
		dialog.getByRole("tab", { name: "Comments (3)", exact: true }),
	).toBeVisible();
	await dialog
		.getByRole("button", { name: "Sample research brief", exact: true })
		.click();
	await expect(
		dialog.getByText("# Sample research brief", { exact: false }),
	).toContainText("fictional sample content");
	await dialog
		.getByLabel("Add a comment", { exact: true })
		.fill("Ready for a careful review.");
	await dialog
		.getByRole("button", { name: "Post comment", exact: true })
		.click();
	const comment = dialog
		.getByRole("article")
		.filter({ hasText: "Ready for a careful review." });
	await expect(
		dialog.getByRole("tab", { name: "Comments (4)", exact: true }),
	).toBeVisible();
	await comment
		.getByRole("button", { name: "Edit comment", exact: true })
		.click();
	await dialog
		.getByRole("textbox", { name: "Edit comment", exact: true })
		.fill("Reviewed with the team.");
	await dialog
		.getByRole("button", { name: "Save comment", exact: true })
		.click();
	const edited = dialog
		.getByRole("article")
		.filter({ hasText: "Reviewed with the team." });
	await expect(edited.getByText("Edited", { exact: true })).toBeVisible();
	await edited
		.getByRole("button", { name: "Delete comment", exact: true })
		.click();
	await dialog
		.getByRole("article")
		.filter({ hasText: "Delete this comment?" })
		.getByRole("button", { name: "Delete comment", exact: true })
		.click();
	await expect(
		dialog.getByText("Comment deleted", { exact: true }),
	).toBeVisible();
	await expect(
		dialog.getByRole("tab", { name: "Comments (3)", exact: true }),
	).toBeVisible();
	await dialog
		.getByRole("button", { name: "Close task details", exact: true })
		.first()
		.click();
	await page.reload();
	await page.getByRole("button", { name: /^Projects/ }).click();
	await page.getByRole("button", { name: /Sample launch/ }).click();
	await expect(
		page.getByRole("button", { name: `Open task: ${taskTitle}`, exact: true }),
	).toContainText("3 comments");
	const discussion = await (
		await office.rpc("ListTaskDiscussion", { taskId: task.id }, token)
	).json();
	expect(
		discussion.comments.filter((item: { deleted?: boolean }) => item.deleted),
	).toHaveLength(1);
	expect(
		discussion.comments.filter((item: { deleted?: boolean }) => !item.deleted),
	).toHaveLength(3);
});

test("concurrent comment writer preserves the browser draft and reloads the winner", async ({
	page,
	office,
}) => {
	const { token } = await office.bootstrap();
	const workspace = await (await office.rpc("GetWorkspace", {}, token)).json();
	const task = workspace.tasks.find(
		(item: { title: string }) => item.title === taskTitle,
	);
	const discussion = await (
		await office.rpc("ListTaskDiscussion", { taskId: task.id }, token)
	).json();
	const comment = discussion.comments[0];
	await openBoard(page, office.url, token);
	await page
		.getByRole("button", { name: `Open task: ${taskTitle}`, exact: true })
		.click();
	const dialog = page.getByRole("dialog");
	await dialog
		.getByRole("article")
		.filter({ hasText: comment.body })
		.getByRole("button", { name: "Edit comment", exact: true })
		.click();
	await dialog
		.getByRole("textbox", { name: "Edit comment", exact: true })
		.fill("My unsaved browser draft");
	expect(
		(
			await office.rpc(
				"SaveTaskComment",
				{
					taskId: task.id,
					commentId: comment.id,
					body: "Another writer won",
					expectedRevision: comment.revision,
				},
				token,
			)
		).ok(),
	).toBeTruthy();
	await dialog
		.getByRole("button", { name: "Save comment", exact: true })
		.click();
	await expect(dialog.getByRole("alert")).toContainText(
		"Your draft is kept below",
	);
	await expect(
		dialog.getByRole("textbox", { name: "Edit comment", exact: true }),
	).toHaveValue("My unsaved browser draft");
	await dialog
		.getByRole("button", { name: "Reload discussion", exact: true })
		.click();
	await expect(
		dialog.getByText("Another writer won", { exact: true }),
	).toBeVisible();
	await expect(
		dialog.getByRole("textbox", { name: "Add a comment", exact: true }),
	).toHaveValue("My unsaved browser draft");
	const saved = await (
		await office.rpc("ListTaskDiscussion", { taskId: task.id }, token)
	).json();
	expect(
		saved.comments.find((item: { id: string }) => item.id === comment.id).body,
	).toBe("Another writer won");
});

test("viewer reads task details and linked research while UI and RPC reject writes", async ({
	page,
	office,
}) => {
	const { token } = await office.bootstrap();
	const workspace = await (await office.rpc("GetWorkspace", {}, token)).json();
	const task = workspace.tasks.find(
		(item: { title: string }) => item.title === taskTitle,
	);
	expect(
		(
			await office.rpc(
				"SaveMember",
				{
					member: {
						name: "Task Viewer",
						email: "task-viewer@example.test",
						role: "viewer",
						status: "active",
					},
					password: "viewer-password-123",
				},
				token,
			)
		).ok(),
	).toBeTruthy();
	const viewer = await (
		await office.rpc("Login", {
			email: "task-viewer@example.test",
			password: "viewer-password-123",
		})
	).json();
	await openBoard(page, office.url, viewer.token);
	await expect(
		page.getByLabel(`Move ${taskTitle} to column`, { exact: true }),
	).toHaveCount(0);
	await expect(page.getByRole("button", { name: /Add task/ })).toHaveCount(0);
	await page
		.getByRole("button", { name: `Open task: ${taskTitle}`, exact: true })
		.click();
	const dialog = page.getByRole("dialog");
	await expect(
		dialog.getByText("You have read-only access to this discussion.", {
			exact: true,
		}),
	).toBeVisible();
	await expect(
		dialog.getByRole("button", { name: "Edit task", exact: true }),
	).toHaveCount(0);
	await expect(
		dialog.getByRole("button", { name: "Edit comment", exact: true }),
	).toHaveCount(0);
	await dialog
		.getByRole("button", { name: "Sample research brief", exact: true })
		.click();
	await expect(
		dialog.getByRole("heading", { name: "Sample research brief", exact: true }),
	).toBeVisible();
	for (const [method, body] of [
		["SaveTask", { task: { ...task, column: "Done" } }],
		["SaveTaskComment", { taskId: task.id, body: "Forbidden" }],
	] as const) {
		const denied = await office.rpc(method, body, viewer.token);
		expect(denied.status()).toBe(403);
		expect((await denied.json()).code).toBe("permission_denied");
	}
});

test("task edits retain their board and custom properties across project switches", async ({
	page,
	office,
}) => {
	const { token, user } = await office.bootstrap();
	const workspace = await (await office.rpc("GetWorkspace", {}, token)).json();
	const task = workspace.tasks.find(
		(item: { title: string }) => item.title === taskTitle,
	);
	const mainBoard = workspace.boards.find(
		(item: { id: string }) => item.id === task.boardId,
	);
	const editorial = workspace.boards.find(
		(item: { name: string }) => item.name === "Sample editorial board",
	);
	const editorialTask = workspace.tasks.find(
		(item: { boardId: string }) => item.boardId === editorial.id,
	);
	await openBoard(page, office.url, token);
	await page
		.getByRole("button", { name: `Open task: ${taskTitle}`, exact: true })
		.click();
	const dialog = page.getByRole("dialog");
	await dialog.getByRole("button", { name: "Edit task", exact: true }).click();
	for (const field of ["Owner", "Priority", "Column", "Due date"]) {
		await expect(
			dialog.getByLabel(field, { exact: true }),
		).toHaveAccessibleName(field);
	}
	await dialog
		.getByLabel("Description", { exact: true })
		.fill("A persisted task edit with custom properties.");
	await dialog.getByLabel("Owner", { exact: true }).selectOption(user.id);
	await dialog.getByLabel("Priority", { exact: true }).selectOption("urgent");
	await dialog.getByLabel("Column", { exact: true }).selectOption("Review");
	await dialog.getByLabel("Due date", { exact: true }).fill("2027-02-14");
	await dialog.getByRole("button", { name: "Save task", exact: true }).click();
	await expect(
		dialog.getByRole("button", { name: "Edit task", exact: true }),
	).toBeVisible();
	await dialog
		.getByRole("button", { name: "Close task details", exact: true })
		.first()
		.click();
	const boards = page.getByRole("tablist", {
		name: "Project boards",
		exact: true,
	});
	await boards.getByRole("tab", { name: /Sample editorial board/ }).click();
	await expect(
		page.getByRole("button", { name: `Open task: ${taskTitle}`, exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByRole("button", {
			name: `Open task: ${editorialTask.title}`,
			exact: true,
		}),
	).toBeVisible();
	await page.getByRole("button", { name: /Sample customer discovery/ }).click();
	await expect(
		boards.getByRole("tab", { name: /Sample editorial board/ }),
	).toHaveCount(0);
	await expect(
		page.getByRole("button", {
			name: `Open task: ${editorialTask.title}`,
			exact: true,
		}),
	).toHaveCount(0);
	await page.getByRole("button", { name: /Sample launch/ }).click();
	await boards.getByRole("tab", { name: new RegExp(mainBoard.name) }).click();
	await expect(
		page
			.getByRole("region", { name: "Review, 3 tasks", exact: true })
			.getByRole("button", { name: `Open task: ${taskTitle}`, exact: true }),
	).toBeVisible();
	await page.reload();
	await page.getByRole("button", { name: /^Projects/ }).click();
	await page
		.getByRole("button", { name: `Open task: ${taskTitle}`, exact: true })
		.click();
	await dialog.getByRole("button", { name: "Edit task", exact: true }).click();
	await expect(dialog.getByLabel("Priority", { exact: true })).toHaveValue(
		"urgent",
	);
	await expect(dialog.getByLabel("Column", { exact: true })).toHaveValue(
		"Review",
	);
	await expect(dialog.getByLabel("Owner", { exact: true })).toHaveValue(
		user.id,
	);
	await expect(dialog.getByLabel("Due date", { exact: true })).toHaveValue(
		"2027-02-14",
	);
	const current = await (await office.rpc("GetWorkspace", {}, token)).json();
	expect(
		current.tasks.find((item: { id: string }) => item.id === task.id),
	).toMatchObject({
		projectId: task.projectId,
		boardId: task.boardId,
		description: "A persisted task edit with custom properties.",
		priority: "urgent",
		column: "Review",
		assigneeId: user.id,
		dueDate: "2027-02-14",
	});
	expect(
		current.tasks.filter((item: { id: string }) => item.id !== task.id),
	).toEqual(
		workspace.tasks.filter((item: { id: string }) => item.id !== task.id),
	);
});

test("member authors can edit their discussion while peers cannot edit or delete it", async ({
	page,
	office,
}) => {
	const { token } = await office.bootstrap();
	const workspace = await (await office.rpc("GetWorkspace", {}, token)).json();
	const task = workspace.tasks.find(
		(item: { title: string }) => item.title === taskTitle,
	);
	const members = [];
	for (const name of ["Author", "Peer"]) {
		const response = await office.rpc(
			"SaveMember",
			{
				member: {
					name,
					email: `${name.toLowerCase()}@example.test`,
					role: "member",
					status: "active",
				},
				password: "member-password-123",
			},
			token,
		);
		expect(response.ok()).toBeTruthy();
		const login = await office.rpc("Login", {
			email: `${name.toLowerCase()}@example.test`,
			password: "member-password-123",
		});
		expect(login.ok()).toBeTruthy();
		members.push(await login.json());
	}
	const [author, peer] = members;
	const created = await office.rpc(
		"SaveTaskComment",
		{ taskId: task.id, body: "Member owned discussion." },
		author.token,
	);
	expect(created.ok()).toBeTruthy();
	const { comment } = await created.json();
	await openBoard(page, office.url, peer.token);
	await page
		.getByRole("button", { name: `Open task: ${taskTitle}`, exact: true })
		.click();
	const dialog = page.getByRole("dialog");
	const entry = dialog.getByRole("article").filter({ hasText: comment.body });
	await expect(entry).toBeVisible();
	await expect(
		dialog.getByLabel("Add a comment", { exact: true }),
	).toBeVisible();
	await expect(
		entry.getByRole("button", { name: "Edit comment", exact: true }),
	).toHaveCount(0);
	await expect(
		entry.getByRole("button", { name: "Delete comment", exact: true }),
	).toHaveCount(0);
	const before = await (
		await office.rpc("ListTaskDiscussion", { taskId: task.id }, token)
	).json();
	for (const method of ["SaveTaskComment", "DeleteTaskComment"]) {
		const denied = await office.rpc(
			method,
			{
				taskId: task.id,
				commentId: comment.id,
				...(method === "SaveTaskComment" ? { body: "Peer overwrite" } : {}),
				expectedRevision: comment.revision,
			},
			peer.token,
		);
		expect(denied.status()).toBe(403);
		expect((await denied.json()).code).toBe("permission_denied");
	}
	expect(
		await (
			await office.rpc("ListTaskDiscussion", { taskId: task.id }, token)
		).json(),
	).toEqual(before);
	// Switch through the real sign-in flow; a page initializer would otherwise
	// restore the peer's token on navigation.
	await dialog
		.getByRole("button", { name: "Close task details", exact: true })
		.first()
		.click();
	await page.getByRole("button", { name: "Sign out", exact: true }).click();
	await page
		.getByLabel("Email address", { exact: true })
		.fill("author@example.test");
	await page
		.getByLabel("Password", { exact: true })
		.fill("member-password-123");
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await page.getByRole("button", { name: /^Projects/ }).click();
	await page
		.getByRole("button", { name: `Open task: ${taskTitle}`, exact: true })
		.click();
	await entry
		.getByRole("button", { name: "Edit comment", exact: true })
		.click();
	await dialog
		.getByRole("textbox", { name: "Edit comment", exact: true })
		.fill("Author revision.");
	await dialog
		.getByRole("button", { name: "Save comment", exact: true })
		.click();
	await expect(
		dialog.getByText("Author revision.", { exact: true }),
	).toBeVisible();
	const saved = await (
		await office.rpc("ListTaskDiscussion", { taskId: task.id }, token)
	).json();
	expect(
		saved.comments.find((item: { id: string }) => item.id === comment.id),
	).toMatchObject({
		body: "Author revision.",
		revision: comment.revision + 1,
		authorId: author.user.id,
	});
	const revised = dialog
		.getByRole("article")
		.filter({ hasText: "Author revision." });
	await revised
		.getByRole("button", { name: "Delete comment", exact: true })
		.click();
	await revised
		.getByRole("button", { name: "Delete comment", exact: true })
		.click();
	await expect(
		dialog.getByText("Comment deleted", { exact: true }),
	).toBeVisible();
	const deleted = await (
		await office.rpc("ListTaskDiscussion", { taskId: task.id }, token)
	).json();
	const tombstone = deleted.comments.find(
		(item: { id: string }) => item.id === comment.id,
	);
	expect(tombstone).toMatchObject({
		deleted: true,
		revision: comment.revision + 2,
		authorId: author.user.id,
	});
	// Protobuf JSON may omit an empty string default.
	expect(tombstone.body ?? "").toBe("");
	const stale = await office.rpc(
		"SaveTaskComment",
		{
			taskId: task.id,
			commentId: comment.id,
			body: "Resurrection",
			expectedRevision: comment.revision + 2,
		},
		author.token,
	);
	expect(stale.status()).toBe(409);
	expect((await stale.json()).code).toBe("aborted");
	expect(
		await (
			await office.rpc("ListTaskDiscussion", { taskId: task.id }, token)
		).json(),
	).toEqual(deleted);
	const after = await (await office.rpc("GetWorkspace", {}, token)).json();
	expect(
		after.tasks.find((item: { id: string }) => item.id === task.id)
			.commentCount,
	).toBe(task.commentCount);
});

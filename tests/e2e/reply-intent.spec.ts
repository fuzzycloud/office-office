import type { Locator, Page } from "@playwright/test";
import { expect, type Office, test } from "./fixtures";

type Kind = "task" | "project";
type Member = { id: string; name: string; email: string; status: string };
type DiscussionRecord = {
	id: string;
	body: string;
	revision: number;
	parentId?: string;
	authorId: string;
	mentionIds?: string[];
	responseRecipientIds?: string[];
};
type Notification = {
	sourceId: string;
	sourceKind: string;
	sourceRevision: number;
	recipientId: string;
	kind: string;
};

async function setup(office: Office, page: Page, kind: Kind, inactive = false) {
	const { token } = await office.bootstrap();
	async function agent(name: string, email: string) {
		const created = await office.rpc(
			"SaveMember",
			{
				member: {
					name,
					email,
					kind: "agent",
					role: "member",
					status: "active",
				},
			},
			token,
		);
		expect(created.ok()).toBeTruthy();
		const { member, secret } = await created.json();
		const exchanged = await office.rpc("ExchangeAgentKey", { key: secret });
		expect(exchanged.ok()).toBeTruthy();
		return {
			member: member as Member,
			token: (await exchanged.json()).token as string,
		};
	}
	const parentAuthor = await agent(
		"Reply Test AI",
		"reply-parent@example.test",
	);
	const duplicate = await agent(
		"Reply Test AI",
		"reply-duplicate@example.test",
	);
	const other = await agent("Other Reply AI", "reply-other@example.test");
	const workspace = await (await office.rpc("GetWorkspace", {}, token)).json();
	const source = kind === "task" ? workspace.tasks[0] : workspace.projects[0];
	const method = kind === "task" ? "SaveTaskComment" : "SaveProjectMessage";
	async function seedParent(author: typeof parentAuthor, body: string) {
		const fields = { body, mentionIds: [], responseRecipientIds: [] };
		const response = await office.rpc(
			method,
			kind === "task"
				? { ...fields, taskId: source.id }
				: { message: { ...fields, projectId: source.id } },
			author.token,
		);
		expect(response.ok()).toBeTruthy();
		const result = await response.json();
		return (
			kind === "task" ? result.comment : result.message
		) as DiscussionRecord;
	}
	const parent = await seedParent(
		parentAuthor,
		"Sample AI parent for reply intent",
	);
	const secondParent = await seedParent(
		duplicate,
		"Sample second AI parent for reply intent",
	);
	if (inactive) {
		const disabled = await office.rpc(
			"SaveMember",
			{
				member: {
					...parentAuthor.member,
					kind: "agent",
					role: "member",
					status: "inactive",
				},
			},
			token,
		);
		expect(disabled.ok()).toBeTruthy();
	}
	await page.addInitScript(
		(value) => sessionStorage.setItem("office-office-session", value),
		token,
	);
	await page.goto(`/projects?sourceKind=${kind}&sourceId=${source.id}`);
	const container =
		kind === "task"
			? page.getByRole("dialog").filter({
					has: page.getByRole("heading", { name: source.title, exact: true }),
				})
			: page.getByRole("region", { name: "Project discussion", exact: true });
	const group = container.getByRole("group", {
		name: "Reply notification mode",
		exact: true,
	});
	const receipt = container.getByRole("status", {
		name: "Notification receipt",
	});
	async function replyTo(record: DiscussionRecord) {
		await container
			.getByRole("article")
			.filter({ hasText: record.body })
			.getByRole("button", { name: "Reply", exact: true })
			.click();
	}
	async function records(): Promise<DiscussionRecord[]> {
		const response = await office.rpc(
			kind === "task" ? "ListTaskDiscussion" : "ListProjectDiscussion",
			kind === "task" ? { taskId: source.id } : { projectId: source.id },
			token,
		);
		expect(response.ok()).toBeTruthy();
		const result = await response.json();
		return kind === "task" ? result.comments : result.messages;
	}
	async function notifications(
		record: DiscussionRecord,
	): Promise<Notification[]> {
		const response = await office.rpc(
			"ListNotifications",
			{ scope: "sent", pageSize: 100 },
			token,
		);
		expect(response.ok()).toBeTruthy();
		return ((await response.json()).notifications ?? []).filter(
			(item: Notification) => item.sourceId === record.id,
		);
	}
	async function submit(body: string, replying = true) {
		await container
			.getByRole("textbox", {
				name:
					kind === "task"
						? replying
							? "Reply to comment"
							: "Add a comment"
						: replying
							? "Reply to project message"
							: "Add project message",
				exact: true,
			})
			.fill(body);
		const outgoing = page.waitForRequest((request) =>
			request.url().endsWith(`/${method}`),
		);
		await container
			.getByRole("button", {
				name: kind === "task" ? "Post comment" : "Post message",
				exact: true,
			})
			.click();
		const request = (await outgoing).postDataJSON();
		await expect(
			container.getByRole("article").filter({ hasText: body }),
		).toBeVisible();
		const saved = (await records()).find((record) => record.body === body);
		if (!saved) throw new Error(`Missing saved reply: ${body}`);
		return { saved, payload: kind === "task" ? request : request.message };
	}
	return {
		container,
		group,
		receipt,
		parent,
		secondParent,
		parentAuthor: parentAuthor.member,
		duplicate: duplicate.member,
		other: other.member,
		replyTo,
		submit,
		notifications,
	};
}

async function addRecipient(
	container: Locator,
	member: Member,
	response: boolean,
) {
	await container
		.getByRole("button", {
			name: response ? "Add response request" : "Add Mention / FYI",
			exact: true,
		})
		.click();
	await container
		.getByRole("combobox", {
			name: response
				? "Find teammate to request a response"
				: "Find teammate to mention",
			exact: true,
		})
		.fill(member.name);
	await container.getByRole("option").filter({ hasText: member.email }).click();
}

for (const kind of ["task", "project"] as const) {
	test(`${kind} plain replies default to FYI and explicitly request the actual AI parent by stable ID`, async ({
		office,
		page,
	}) => {
		const ui = await setup(office, page, kind);
		await ui.replyTo(ui.parent);
		await expect(ui.group).toContainText(`Reply to ${ui.parentAuthor.name}`);
		await expect(
			ui.group.getByRole("radio", { name: "FYI", exact: true }),
		).toBeChecked();
		const fyi = await ui.submit("Sample plain FYI reply without an at mention");
		expect(fyi.saved.parentId).toBe(ui.parent.id);
		expect(fyi.saved.responseRecipientIds ?? []).toEqual([]);
		expect(fyi.saved.mentionIds ?? []).toEqual([]);
		expect(await ui.notifications(fyi.saved)).toEqual([
			expect.objectContaining({
				kind: "notice",
				recipientId: ui.parentAuthor.id,
				sourceKind: kind === "task" ? "task_comment" : "project_message",
				sourceRevision: fyi.saved.revision,
			}),
		]);
		await expect(ui.receipt).toContainText(
			`Mention / FYI notified: ${ui.parentAuthor.name}`,
		);

		await ui.replyTo(ui.parent);
		await ui.group
			.getByRole("radio", { name: "Request response", exact: true })
			.check();
		const action = await ui.submit(
			"Sample plain actionable reply without an at mention",
		);
		expect(action.payload.parentId).toBe(ui.parent.id);
		expect(action.payload.responseRecipientIds).toEqual([ui.parentAuthor.id]);
		expect(action.saved.responseRecipientIds).toEqual([ui.parentAuthor.id]);
		expect(action.saved.mentionIds ?? []).toEqual([]);
		expect(action.saved.responseRecipientIds).not.toContain(ui.duplicate.id);
		expect(await ui.notifications(action.saved)).toEqual([
			expect.objectContaining({
				kind: "response_request",
				recipientId: ui.parentAuthor.id,
				sourceKind: kind === "task" ? "task_comment" : "project_message",
				sourceId: action.saved.id,
				sourceRevision: action.saved.revision,
			}),
		]);
		await expect(ui.receipt).toContainText(
			`Response requested from: ${ui.parentAuthor.name}`,
		);
		await expect(ui.receipt).not.toContainText(
			"Recipient verification mismatch",
		);
	});

	test(`${kind} changing reply intent preserves other recipients and cancel or a new parent clears reply addressing`, async ({
		office,
		page,
	}) => {
		const ui = await setup(office, page, kind);
		await ui.replyTo(ui.parent);
		await ui.group
			.getByRole("radio", { name: "Request response", exact: true })
			.check();
		await addRecipient(ui.container, ui.other, true);
		await addRecipient(ui.container, ui.duplicate, false);
		await ui.group.getByRole("radio", { name: "FYI", exact: true }).check();
		const switched = await ui.submit("Sample reply switched back to FYI");
		expect(switched.payload.responseRecipientIds).toEqual([ui.other.id]);
		expect(switched.saved.responseRecipientIds).toEqual([ui.other.id]);
		expect(switched.saved.mentionIds).toEqual([ui.duplicate.id]);
		expect(await ui.notifications(switched.saved)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "notice",
					recipientId: ui.parentAuthor.id,
				}),
				expect.objectContaining({
					kind: "notice",
					recipientId: ui.duplicate.id,
				}),
				expect.objectContaining({
					kind: "response_request",
					recipientId: ui.other.id,
				}),
			]),
		);
		expect(await ui.notifications(switched.saved)).toHaveLength(3);

		await ui.replyTo(ui.parent);
		await ui.group
			.getByRole("radio", { name: "Request response", exact: true })
			.check();
		await ui.container
			.getByRole("button", { name: "Cancel reply", exact: true })
			.click();
		await expect(ui.group).toHaveCount(0);
		const cancelled = await ui.submit(
			"Sample standalone message after cancelling reply",
			false,
		);
		expect(cancelled.saved.parentId ?? "").toBe("");
		expect(cancelled.payload.responseRecipientIds ?? []).toEqual([]);
		expect(cancelled.saved.responseRecipientIds ?? []).toEqual([]);
		expect(await ui.notifications(cancelled.saved)).toEqual([]);

		await ui.replyTo(ui.parent);
		await ui.group
			.getByRole("radio", { name: "Request response", exact: true })
			.check();
		await ui.replyTo(ui.secondParent);
		await expect(
			ui.group.getByRole("radio", { name: "FYI", exact: true }),
		).toBeChecked();
		const changed = await ui.submit("Sample FYI reply after switching parent");
		expect(changed.saved.parentId).toBe(ui.secondParent.id);
		expect(changed.saved.responseRecipientIds ?? []).toEqual([]);
		expect(await ui.notifications(changed.saved)).toEqual([
			expect.objectContaining({ kind: "notice", recipientId: ui.duplicate.id }),
		]);
	});

	test(`${kind} inactive AI parent explains why response requests are unavailable and still accepts a plain reply`, async ({
		office,
		page,
	}) => {
		const ui = await setup(office, page, kind, true);
		await ui.replyTo(ui.parent);
		await expect(ui.group).toContainText(/inactive or unavailable/i);
		await expect(
			ui.group.getByRole("radio", { name: "Request response", exact: true }),
		).toBeDisabled();
		const result = await ui.submit("Sample plain reply to inactive AI parent");
		expect(result.saved.parentId).toBe(ui.parent.id);
		expect(result.payload.responseRecipientIds ?? []).toEqual([]);
		expect(result.saved.responseRecipientIds ?? []).toEqual([]);
		expect(await ui.notifications(result.saved)).toEqual([]);
	});
}

for (const kind of ["task", "project"] as const) {
	test(`${kind} visible mention autocomplete preserves the caret suffix and reply response intent`, async ({
		office,
		page,
	}) => {
		if (kind === "task")
			await page.setViewportSize({ width: 390, height: 844 });
		const ui = await setup(office, page, kind);
		await ui.replyTo(ui.parent);
		await ui.group
			.getByRole("radio", { name: "Request response", exact: true })
			.check();
		const body = ui.container.getByRole("textbox", {
			name: kind === "task" ? "Reply to comment" : "Reply to project message",
			exact: true,
		});
		const mention = ui.container.getByRole("button", {
			name: "Mention someone",
			exact: true,
		});
		const suggestions = ui.container.getByRole("listbox", {
			name: "Active teammates",
			exact: true,
		});
		await body.fill("Sample escape check");
		await mention.click();
		await expect(suggestions).toBeVisible();
		await expect(body).toBeFocused();
		await body.press("Escape");
		await expect(suggestions).toHaveCount(0);
		await expect(ui.group).toBeVisible();
		if (kind === "task") await expect(ui.container).toBeVisible();

		await body.fill("Before  after.");
		await body.evaluate((element) => {
			if (!(element instanceof HTMLTextAreaElement))
				throw new Error("Expected reply textarea");
			element.focus();
			element.setSelectionRange(7, 7);
		});
		await mention.click();
		await expect(suggestions).toBeVisible();
		await expect(body).toBeFocused();
		await page.keyboard.insertText("reply-duplicate");
		await expect(suggestions.getByRole("option")).toHaveCount(1);
		await expect(suggestions.getByRole("option")).toContainText(
			ui.duplicate.email,
		);
		await body.press("ArrowDown");
		await body.press("Enter");
		await expect(suggestions).toHaveCount(0);
		const expectedBody = `Before @${ui.duplicate.name}  after.`;
		await expect(body).toHaveValue(expectedBody);
		await expect(
			ui.group.getByRole("radio", {
				name: "Request response",
				exact: true,
			}),
		).toBeChecked();
		const result = await ui.submit(expectedBody);
		expect(result.saved.parentId).toBe(ui.parent.id);
		expect(result.payload.responseRecipientIds).toEqual([ui.parentAuthor.id]);
		expect(result.saved.responseRecipientIds).toEqual([ui.parentAuthor.id]);
		expect(result.payload.mentionIds).toEqual([ui.duplicate.id]);
		expect(result.saved.mentionIds).toEqual([ui.duplicate.id]);
		expect(await ui.notifications(result.saved)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "response_request",
					recipientId: ui.parentAuthor.id,
				}),
				expect.objectContaining({
					kind: "notice",
					recipientId: ui.duplicate.id,
				}),
			]),
		);
		expect(await ui.notifications(result.saved)).toHaveLength(2);
		const savedArticle = ui.container
			.getByRole("article")
			.filter({ hasText: expectedBody });
		const linkedMention = savedArticle.locator(
			`mark[data-member-ids~="${ui.duplicate.id}"]`,
		);
		await expect(linkedMention).toHaveText(`@${ui.duplicate.name}`);
		expect(
			(await linkedMention.getAttribute("data-member-ids"))?.split(" "),
		).toContain(ui.parentAuthor.id);
		await expect(ui.receipt).not.toContainText(
			"Recipient verification mismatch",
		);
	});
}

for (const kind of ["task", "project"] as const) {
	test(`${kind} bare at autocomplete stays in the viewport and unlinked typed names remain plain text`, async ({
		office,
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 640 });
		const ui = await setup(office, page, kind);
		await ui.replyTo(ui.parent);
		const body = ui.container.getByRole("textbox", {
			name: kind === "task" ? "Reply to comment" : "Reply to project message",
			exact: true,
		});
		await body.fill("Sample bare ");
		await body.evaluate((element) => element.scrollIntoView({ block: "end" }));
		await body.focus();
		await page.keyboard.insertText("@");
		const suggestions = ui.container.getByRole("listbox", {
			name: "Active teammates",
			exact: true,
		});
		await expect(suggestions).toBeVisible();
		await expect(suggestions).toBeInViewport({ ratio: 1 });
		const box = await suggestions.boundingBox();
		if (!box) throw new Error("Missing visible teammate suggestions");
		expect(box.x).toBeGreaterThanOrEqual(0);
		expect(box.y).toBeGreaterThanOrEqual(0);
		expect(box.x + box.width).toBeLessThanOrEqual(390);
		expect(box.y + box.height).toBeLessThanOrEqual(640);
		await suggestions
			.getByRole("option")
			.filter({ hasText: ui.duplicate.email })
			.click();
		await expect(body).toHaveValue(`Sample bare @${ui.duplicate.name} `);
		await expect(suggestions).toHaveCount(0);

		// Clearing the reply also clears the selected stable IDs; typing an existing
		// name by itself must not receive the saved linked-mention treatment.
		await ui.container
			.getByRole("button", { name: "Cancel reply", exact: true })
			.click();
		const plainBody = `Sample unlinked @${ui.other.name} remains plain text.`;
		await ui.container
			.getByRole("textbox", {
				name: kind === "task" ? "Add a comment" : "Add project message",
				exact: true,
			})
			.fill(plainBody);
		await ui.container
			.getByRole("checkbox", {
				name: "Post without notifying these names",
				exact: true,
			})
			.check();
		await ui.container
			.getByRole("button", {
				name: kind === "task" ? "Post comment" : "Post message",
				exact: true,
			})
			.click();
		const article = ui.container
			.getByRole("article")
			.filter({ hasText: plainBody });
		await expect(article).toBeVisible();
		await expect(article.locator("mark[data-member-ids]")).toHaveCount(0);
		await expect(ui.receipt).toContainText(
			"No new notifications were created.",
		);
	});
}

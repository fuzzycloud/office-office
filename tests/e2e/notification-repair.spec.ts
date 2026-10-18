import type { Locator, Page } from "@playwright/test";
import { expect, type Office, test } from "./fixtures";

type Record = {
	id: string;
	body: string;
	revision: number;
	parentId?: string;
	mentionIds?: string[];
	responseRecipientIds?: string[];
	authorId?: string;
	actorKind?: string;
};

function required<T>(value: T | undefined, description: string): T {
	if (value === undefined) throw new Error(`Missing ${description}`);
	return value;
}

async function setup(office: Office, page: Page, kind: "task" | "project") {
	const { token } = await office.bootstrap();
	const created = await office.rpc(
		"SaveMember",
		{
			member: {
				name: "Repair Test AI",
				email: "repair-ai@example.test",
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
	const { token: agentToken } = await exchanged.json();
	const workspace = await (await office.rpc("GetWorkspace", {}, token)).json();
	const source = kind === "task" ? workspace.tasks[0] : workspace.projects[0];
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
	const records = async (): Promise<Record[]> => {
		const result = await (
			await office.rpc(
				kind === "task" ? "ListTaskDiscussion" : "ListProjectDiscussion",
				kind === "task" ? { taskId: source.id } : { projectId: source.id },
				token,
			)
		).json();
		return kind === "task" ? result.comments : result.messages;
	};
	const notifications = async () =>
		(
			await (
				await office.rpc(
					"ListNotifications",
					{ scope: "sent", pageSize: 100 },
					token,
				)
			).json()
		).notifications ?? [];
	return {
		token,
		agentToken,
		source,
		member,
		container,
		records,
		notifications,
	};
}

async function autocomplete(
	container: Locator,
	body: Locator,
	name: string,
	action: boolean,
	text: string,
) {
	await container
		.getByRole("group", { name: "Autocomplete notification mode", exact: true })
		.getByRole("radio", {
			name: action ? "Ask to act / respond" : /FYI/,
			exact: action,
		})
		.check();
	await body.fill(`${text} @${name}`);
	await container
		.getByRole("listbox", { name: "Active teammates", exact: true })
		.getByRole("option")
		.filter({ hasText: "repair-ai@example.test" })
		.click();
	await expect(
		container.getByRole("list", {
			name: action ? "Request response recipients" : "Mention / FYI recipients",
			exact: true,
		}),
	).toContainText(name);
}

// These exercise the real composer/transport/storage boundary. Previously @ selection
// always meant FYI, so a user could not choose actionable autocomplete intent.
for (const kind of ["task", "project"] as const) {
	test(`${kind} autocomplete action survives create and edit; FYI reply stays informational`, async ({
		office,
		page,
	}) => {
		const { member, container, records, notifications } = await setup(
			office,
			page,
			kind,
		);
		const task = kind === "task";
		const saveMethod = task ? "SaveTaskComment" : "SaveProjectMessage";
		const submit = () =>
			container
				.getByRole("button", {
					name: task ? "Post comment" : "Post message",
					exact: true,
				})
				.click();
		const body = container.getByRole("textbox", {
			name: task ? "Add a comment" : "Add project message",
			exact: true,
		});
		await autocomplete(
			container,
			body,
			member.name,
			true,
			"Internal repair test: acknowledge only",
		);
		const outgoing = page.waitForRequest((request) =>
			request.url().endsWith(`/${saveMethod}`),
		);
		await submit();
		const payload = (await outgoing).postDataJSON();
		expect((task ? payload : payload.message).responseRecipientIds).toEqual([
			member.id,
		]);
		const receipt = container.getByRole("status", {
			name: "Notification receipt",
		});
		await expect(receipt).toContainText(
			`Response requested from: ${member.name}`,
		);
		let saved = required(
			(await records()).find((record) =>
				record.body.startsWith("Internal repair test:"),
			),
			"created test discussion record",
		);
		expect(saved.responseRecipientIds).toEqual([member.id]);
		expect(saved.mentionIds ?? []).toEqual([]);
		const sourceKind = task ? "task_comment" : "project_message";
		const emitted = (await notifications()).filter(
			(notification: { sourceId: string }) =>
				notification.sourceId === saved.id,
		);
		expect(emitted).toEqual([
			expect.objectContaining({
				sourceKind,
				sourceId: saved.id,
				sourceRevision: saved.revision,
				kind: "response_request",
				recipientId: member.id,
			}),
		]);

		await container
			.getByRole("article")
			.filter({ hasText: "Internal repair test:" })
			.getByRole("button", {
				name: task ? "Edit comment" : "Edit message",
				exact: true,
			})
			.click();
		const editedBody = container.getByRole("textbox", {
			name: task ? "Edit comment" : "Edit project message",
			exact: true,
		});
		await editedBody.fill(`${saved.body} Updated harmless test wording.`);
		const editRequest = page.waitForRequest((request) =>
			request.url().endsWith(`/${saveMethod}`),
		);
		await container
			.getByRole("button", {
				name: task ? "Save comment" : "Save message",
				exact: true,
			})
			.click();
		const editPayload = (await editRequest).postDataJSON();
		expect(
			(task ? editPayload : editPayload.message).responseRecipientIds,
		).toEqual([member.id]);
		await expect(
			container
				.getByRole("article")
				.filter({ hasText: "Updated harmless test wording." }),
		).toBeVisible();
		await expect(receipt).toContainText("No new notifications were created.");
		const originalId = saved.id;
		saved = required(
			(await records()).find((record) => record.id === originalId),
			"edited test discussion record",
		);
		expect(saved.revision).toBe(2);
		expect(saved.responseRecipientIds).toEqual([member.id]);
		expect(
			(await notifications()).filter(
				(notification: { sourceId: string; sourceRevision: number }) =>
					notification.sourceId === saved.id &&
					notification.sourceRevision === saved.revision,
			),
		).toEqual([]);
		expect(
			(await notifications()).filter(
				(notification: { sourceId: string }) =>
					notification.sourceId === saved.id,
			),
		).toHaveLength(1);

		await container
			.getByRole("article")
			.filter({ hasText: "Updated harmless test wording." })
			.getByRole("button", { name: "Reply", exact: true })
			.click();
		await autocomplete(
			container,
			container.getByRole("textbox", {
				name: task ? "Reply to comment" : "Reply to project message",
				exact: true,
			}),
			member.name,
			false,
			"Internal repair FYI reply: no action requested",
		);
		await submit();
		await expect(receipt).toContainText(
			`Mention / FYI notified: ${member.name}`,
		);
		const reply = required(
			(await records()).find((record) =>
				record.body.startsWith("Internal repair FYI reply:"),
			),
			"informational reply",
		);
		expect(reply.parentId).toBe(saved.id);
		expect(reply.mentionIds).toEqual([member.id]);
		expect(reply.responseRecipientIds ?? []).toEqual([]);
		// The parent is actionable, but replying with FYI must never inherit that intent.
		expect(
			(await notifications()).filter(
				(notification: { sourceId: string }) =>
					notification.sourceId === reply.id,
			),
		).toEqual([
			expect.objectContaining({
				kind: "notice",
				recipientId: member.id,
				sourceRevision: reply.revision,
			}),
		]);
	});
}

// This local protocol round-trip deliberately does not invoke or claim to test Hermes.
test("Local worker protocol round-trip replies to the UI request and acknowledges once without an actionable loop", async ({
	office,
	page,
}) => {
	const { agentToken, source, member, container, records, notifications } =
		await setup(office, page, "task");
	await autocomplete(
		container,
		container.getByRole("textbox", {
			name: "Add a comment",
			exact: true,
		}),
		member.name,
		true,
		"Internal local worker protocol test: reply ACK only",
	);
	await container
		.getByRole("button", { name: "Post comment", exact: true })
		.click();
	await expect(
		container.getByRole("status", { name: "Notification receipt" }),
	).toContainText(`Response requested from: ${member.name}`);
	const parent = required(
		(await records()).find((record) =>
			record.body.startsWith("Internal local worker protocol test:"),
		),
		"UI request source",
	);
	const poll = await office.rpc(
		"PollNotifications",
		{ afterCursor: "0", pageSize: 100 },
		agentToken,
	);
	expect(poll.ok()).toBeTruthy();
	const initial = await poll.json();
	expect(initial.notifications).toEqual([
		expect.objectContaining({
			kind: "response_request",
			status: "pending",
			recipientId: member.id,
			sourceKind: "task_comment",
			sourceId: parent.id,
			sourceRevision: parent.revision,
		}),
	]);
	const request = required(initial.notifications[0], "actionable notification");
	const claimRequest = {
		id: request.id,
		expectedRevision: request.revision,
		action: "claim",
		claimId: "local-repair-worker-protocol-claim-001",
	};
	const claim = await office.rpc(
		"UpdateNotification",
		claimRequest,
		agentToken,
	);
	expect(claim.ok()).toBeTruthy();
	const { notification: claimed } = await claim.json();
	expect(claimed).toMatchObject({
		status: "claimed",
		claimId: claimRequest.claimId,
	});
	// A lost claim response can be retried with its original revision and identity.
	const claimRetry = await office.rpc(
		"UpdateNotification",
		claimRequest,
		agentToken,
	);
	expect(claimRetry.ok()).toBeTruthy();
	expect((await claimRetry.json()).notification).toEqual(claimed);
	const replyBody =
		"Internal local worker protocol ACK; no business action performed.";
	const replyResponse = await office.rpc(
		"SaveTaskComment",
		{
			taskId: source.id,
			parentId: parent.id,
			body: replyBody,
			mentionIds: [],
			responseRecipientIds: [],
		},
		agentToken,
	);
	expect(replyResponse.ok()).toBeTruthy();
	const { comment: reply } = await replyResponse.json();
	expect(reply).toMatchObject({
		body: replyBody,
		authorId: member.id,
		actorKind: "agent",
		parentId: parent.id,
	});
	const acknowledgement = {
		id: request.id,
		expectedRevision: claimed.revision,
		action: "acknowledge",
		claimId: claimRequest.claimId,
		note: "Completed harmless local protocol test.",
		resultKind: "task_comment",
		resultId: reply.id,
		resultRevision: reply.revision,
	};
	const ack = await office.rpc(
		"UpdateNotification",
		acknowledgement,
		agentToken,
	);
	expect(ack.ok()).toBeTruthy();
	const { notification: acknowledged } = await ack.json();
	expect(acknowledged).toMatchObject({
		status: "acknowledged",
		claimId: claimRequest.claimId,
		resultKind: "task_comment",
		resultId: reply.id,
		resultRevision: reply.revision,
	});
	const ackRetry = await office.rpc(
		"UpdateNotification",
		acknowledgement,
		agentToken,
	);
	expect(ackRetry.ok()).toBeTruthy();
	expect((await ackRetry.json()).notification).toEqual(acknowledged);
	const storedReplies = (await records()).filter(
		(record) => record.body === replyBody,
	);
	expect(storedReplies).toEqual([
		expect.objectContaining({
			id: reply.id,
			authorId: member.id,
			actorKind: "agent",
			parentId: parent.id,
		}),
	]);
	expect(
		(await notifications()).find(
			(notification: { id: string }) => notification.id === request.id,
		),
	).toEqual(acknowledged);
	// The reply may notify its human parent author, but cannot create agent work.
	const sentByAgent = await office.rpc(
		"ListNotifications",
		{ scope: "sent", pageSize: 100 },
		agentToken,
	);
	expect(sentByAgent.ok()).toBeTruthy();
	expect((await sentByAgent.json()).notifications).toEqual([
		expect.objectContaining({
			kind: "notice",
			sourceId: reply.id,
			recipientId: parent.authorId,
		}),
	]);
	const changes = await office.rpc(
		"PollNotifications",
		{ afterCursor: initial.nextCursor, pageSize: 100 },
		agentToken,
	);
	expect(changes.ok()).toBeTruthy();
	const next = await changes.json();
	expect(next.notifications).toEqual([
		expect.objectContaining({ id: request.id, status: "claimed" }),
		expect.objectContaining({ id: request.id, status: "acknowledged" }),
	]);
	const idle = await office.rpc(
		"PollNotifications",
		{ afterCursor: next.nextCursor, pageSize: 100 },
		agentToken,
	);
	expect(idle.ok()).toBeTruthy();
	expect((await idle.json()).notifications ?? []).toEqual([]);
});

test("Project receipt preserves pre-save recipient intent when discussion refreshes before save response", async ({
	office,
	page,
}) => {
	const { token, source, member, container } = await setup(
		office,
		page,
		"project",
	);
	const created = await office.rpc(
		"SaveProjectMessage",
		{
			message: {
				projectId: source.id,
				body: "Internal receipt snapshot before edit",
			},
		},
		token,
	);
	expect(created.ok()).toBeTruthy();
	await container
		.getByRole("button", { name: "Refresh discussion", exact: true })
		.click();
	await container
		.getByRole("article")
		.filter({ hasText: "Internal receipt snapshot before edit" })
		.getByRole("button", { name: "Edit message", exact: true })
		.click();
	await autocomplete(
		container,
		container.getByRole("textbox", {
			name: "Edit project message",
			exact: true,
		}),
		member.name,
		false,
		"Internal receipt snapshot after edit",
	);
	let releaseResponse = () => {};
	let markCommitted = () => {};
	const held = new Promise<void>((resolve) => {
		releaseResponse = resolve;
	});
	const committed = new Promise<void>((resolve) => {
		markCommitted = resolve;
	});
	await page.route(
		"**/rpc/office.v1.OfficeService/SaveProjectMessage",
		async (route) => {
			const response = await route.fetch();
			markCommitted();
			await held;
			await route.fulfill({ response });
		},
	);
	try {
		await container
			.getByRole("button", { name: "Save message", exact: true })
			.click();
		await committed;
		await container
			.getByRole("button", { name: "Refresh discussion", exact: true })
			.click();
		await expect(
			container
				.getByRole("article")
				.filter({ hasText: "Internal receipt snapshot after edit" }),
		).toContainText(`@${member.name}`);
	} finally {
		releaseResponse();
	}
	const receipt = container.getByRole("status", {
		name: "Notification receipt",
	});
	await expect(receipt).toContainText(`Mention / FYI notified: ${member.name}`);
	await expect(receipt).not.toContainText("Recipient verification mismatch");
});

test("Receipt pagination deduplicates the same notification ID across a moving page boundary", async ({
	office,
	page,
}) => {
	const { member, container } = await setup(office, page, "project");
	let firstNotification: { id: string; sourceId: string } | undefined;
	await page.route(
		"**/rpc/office.v1.OfficeService/ListNotifications",
		async (route) => {
			const request = route.request().postDataJSON();
			if (request.scope !== "sent") {
				await route.continue();
				return;
			}
			if (!request.offset) {
				const response = await route.fetch();
				const data = await response.json();
				firstNotification = required(
					data.notifications?.[0],
					"server-emitted FYI notification",
				);
				const actual = firstNotification;
				await route.fulfill({
					response,
					json: {
						notifications: [
							actual,
							...Array.from({ length: 99 }, (_, index) => ({
								...actual,
								id: `unrelated-page-notification-${index}`,
								sourceId: `unrelated-source-${index}`,
							})),
						],
						nextOffset: 100,
						totalCount: 101,
					},
				});
			} else {
				expect(request.offset).toBe(100);
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({
						notifications: [
							required(firstNotification, "overlapping page notification"),
						],
						totalCount: 101,
					}),
				});
			}
		},
	);
	await autocomplete(
		container,
		container.getByRole("textbox", {
			name: "Add project message",
			exact: true,
		}),
		member.name,
		false,
		"Internal receipt pagination test",
	);
	await container
		.getByRole("button", { name: "Post message", exact: true })
		.click();
	const receipt = container.getByRole("status", {
		name: "Notification receipt",
	});
	await expect(receipt).toContainText(`Mention / FYI notified: ${member.name}`);
	await expect(receipt).not.toContainText("Recipient verification mismatch");
});

// A successful write is insufficient: both saved recipients and emitted records
// must agree with the intent selected before submission.
for (const mismatch of [
	"persisted recipients",
	"emitted notifications",
] as const) {
	test(`Receipt exposes missing ${mismatch} and retries verification without reposting`, async ({
		office,
		page,
	}) => {
		const { member, container, records } = await setup(office, page, "project");
		let writes = 0;
		let hideNotifications = mismatch === "emitted notifications";
		await page.route(
			"**/rpc/office.v1.OfficeService/SaveProjectMessage",
			async (route) => {
				writes++;
				if (mismatch === "persisted recipients") {
					const payload = route.request().postDataJSON();
					payload.message.mentionIds = [];
					payload.message.responseRecipientIds = [];
					const response = await route.fetch({
						postData: JSON.stringify(payload),
					});
					await route.fulfill({ response });
				} else await route.continue();
			},
		);
		await page.route(
			"**/rpc/office.v1.OfficeService/ListNotifications",
			async (route) => {
				if (
					hideNotifications &&
					route.request().postDataJSON().scope === "sent"
				) {
					await route.fulfill({
						status: 200,
						contentType: "application/json",
						body: JSON.stringify({ notifications: [] }),
					});
				} else await route.continue();
			},
		);
		await container
			.getByRole("textbox", {
				name: "Add project message",
				exact: true,
			})
			.fill("Internal receipt mismatch test");
		await container
			.getByRole("button", { name: "Add Mention / FYI", exact: true })
			.click();
		await container
			.getByRole("combobox", { name: "Find teammate to mention", exact: true })
			.fill(member.name);
		await container
			.getByRole("option")
			.filter({ hasText: "repair-ai@example.test" })
			.click();
		await expect(
			container.getByRole("list", {
				name: "Mention / FYI recipients",
				exact: true,
			}),
		).toContainText(member.name);
		await container
			.getByRole("button", { name: "Post message", exact: true })
			.click();
		const receipt = container.getByRole("status", {
			name: "Notification receipt",
		});
		await expect(receipt).toContainText("Recipient verification mismatch");
		await expect(
			receipt.getByRole("link", { name: "View saved message", exact: true }),
		).toBeVisible();
		const saved = (await records()).filter((record) =>
			record.body.startsWith("Internal receipt mismatch test"),
		);
		expect(saved).toHaveLength(1);
		expect(writes).toBe(1);
		hideNotifications = false;
		await receipt
			.getByRole("button", { name: "Retry verification", exact: true })
			.click();
		if (mismatch === "persisted recipients") {
			await expect(receipt).toContainText("Recipient verification mismatch");
			expect(saved[0].mentionIds ?? []).toEqual([]);
		} else {
			await expect(receipt).toContainText(
				`Mention / FYI notified: ${member.name}`,
			);
			await expect(receipt).not.toContainText(
				"Recipient verification mismatch",
			);
			expect(saved[0].mentionIds).toEqual([member.id]);
		}
		expect(writes).toBe(1);
		expect(
			(await records()).filter((record) =>
				record.body.startsWith("Internal receipt mismatch test"),
			),
		).toHaveLength(1);
	});
}

import { expect, test } from "./fixtures";

test("AI inbox polls durable changes, preserves unread state, and claims then acknowledges atomically", async ({
	office,
}) => {
	const { token: adminToken } = await office.bootstrap(false);
	const created = await office.rpc(
		"SaveMember",
		{
			member: {
				name: "Prachi",
				kind: "agent",
				role: "member",
				status: "active",
			},
		},
		adminToken,
	);
	expect(created.ok()).toBeTruthy();
	const { member, secret } = await created.json();
	const exchanged = await office.rpc("ExchangeAgentKey", { key: secret });
	expect(exchanged.ok()).toBeTruthy();
	const { token: agentToken } = await exchanged.json();

	const request = {
		requestId: "e2e-prachi-response-001",
		title: "Review the launch notes",
		body: "Please review the launch notes and share your response.",
		kind: "response_request",
		recipientIds: [member.id],
	};
	const firstCreate = await office.rpc(
		"CreateNotification",
		request,
		adminToken,
	);
	expect(firstCreate.ok()).toBeTruthy();
	const first = (await firstCreate.json()).notifications[0];
	const retryCreate = await office.rpc(
		"CreateNotification",
		request,
		adminToken,
	);
	expect(retryCreate.ok()).toBeTruthy();
	expect((await retryCreate.json()).notifications).toEqual([first]);

	const initialPoll = await office.rpc(
		"PollNotifications",
		{ afterCursor: "0", pageSize: 1 },
		agentToken,
	);
	expect(initialPoll.ok()).toBeTruthy();
	const initial = await initialPoll.json();
	expect(initial.notifications).toHaveLength(1);
	expect(initial.notifications[0]).toMatchObject({
		id: first.id,
		recipientId: member.id,
		status: "pending",
	});
	expect(initial.hasMore ?? false).toBe(false);
	const cursor = initial.nextCursor;

	const listed = await office.rpc(
		"ListNotifications",
		{ scope: "inbox", pageSize: 20, offset: 0 },
		agentToken,
	);
	expect(listed.ok()).toBeTruthy();
	expect((await listed.json()).notifications[0]).toMatchObject({
		id: first.id,
		status: "pending",
	});

	const read = await office.rpc(
		"UpdateNotification",
		{ id: first.id, expectedRevision: 1, action: "read" },
		agentToken,
	);
	expect(read.ok()).toBeTruthy();
	const readNotification = (await read.json()).notification;
	expect(readNotification).toMatchObject({ status: "pending", revision: 2 });
	expect(readNotification.readAt).not.toBe("0");

	const claimId = "00000000-0000-4000-8000-000000000001";
	const claim = await office.rpc(
		"UpdateNotification",
		{
			id: first.id,
			expectedRevision: readNotification.revision,
			action: "claim",
			claimId,
		},
		agentToken,
	);
	expect(claim.ok()).toBeTruthy();
	const claimedNotification = (await claim.json()).notification;
	expect(claimedNotification).toMatchObject({
		status: "claimed",
		claimId,
		revision: 3,
	});

	const acknowledge = await office.rpc(
		"UpdateNotification",
		{
			id: first.id,
			expectedRevision: claimedNotification.revision,
			action: "acknowledge",
			claimId,
			note: "Reviewed and sent my response.",
		},
		agentToken,
	);
	expect(acknowledge.ok()).toBeTruthy();
	const acknowledged = (await acknowledge.json()).notification;
	expect(acknowledged).toMatchObject({
		status: "acknowledged",
		claimId,
		note: "Reviewed and sent my response.",
		revision: 4,
	});

	const changes = await office.rpc(
		"PollNotifications",
		{ afterCursor: cursor, pageSize: 20 },
		agentToken,
	);
	expect(changes.ok()).toBeTruthy();
	const polled = await changes.json();
	expect(
		polled.notifications.map((item: { status: string }) => item.status),
	).toEqual(["pending", "claimed", "acknowledged"]);
	expect(BigInt(polled.nextCursor)).toBeGreaterThan(BigInt(cursor));
	expect(polled.hasMore ?? false).toBe(false);
	const retryPoll = await office.rpc(
		"PollNotifications",
		{ afterCursor: cursor, pageSize: 20 },
		agentToken,
	);
	expect((await retryPoll.json()).notifications).toEqual(polled.notifications);

	await office.restart();
	const restored = await office.rpc(
		"ListNotifications",
		{ scope: "inbox", pageSize: 20, offset: 0 },
		agentToken,
	);
	expect(restored.ok()).toBeTruthy();
	expect((await restored.json()).notifications).toContainEqual(acknowledged);
	const afterRestart = await office.rpc(
		"PollNotifications",
		{ afterCursor: polled.nextCursor, pageSize: 20 },
		agentToken,
	);
	expect((await afterRestart.json()).notifications ?? []).toEqual([]);
});

test("the Notifications board sends to an AI member and lets them read and acknowledge", async ({
	office,
	page,
}, testInfo) => {
	const { token: adminToken } = await office.bootstrap(false);
	const created = await office.rpc(
		"SaveMember",
		{
			member: {
				name: "Prachi",
				kind: "agent",
				role: "member",
				status: "active",
			},
		},
		adminToken,
	);
	expect(created.ok()).toBeTruthy();
	const { secret } = await created.json();
	await page.addInitScript((value) => {
		if (!sessionStorage.getItem("office-office-session"))
			sessionStorage.setItem("office-office-session", value);
	}, adminToken);
	await page.goto("/");
	await page
		.getByRole("button", { name: "Notifications", exact: true })
		.click();
	await expect(page).toHaveURL(`${office.url}/notifications`);
	await page
		.getByRole("button", { name: "Send notification", exact: true })
		.click();
	const composer = page.getByRole("form", { name: "Notification composer" });
	await composer
		.getByLabel("Title", { exact: true })
		.fill("Review the launch notes");
	await composer
		.getByLabel("Message", { exact: true })
		.fill("Please review and reply when you are ready.");
	await composer
		.getByLabel("Search recipients", { exact: true })
		.fill("Prachi");
	await composer.getByLabel("Prachi").check();
	await composer
		.getByRole("button", { name: "Send notification", exact: true })
		.click();
	await page.getByRole("button", { name: "Sent", exact: true }).click();
	await expect(
		page.getByText("Review the launch notes", { exact: true }),
	).toBeVisible();

	const exchanged = await office.rpc("ExchangeAgentKey", { key: secret });
	expect(exchanged.ok()).toBeTruthy();
	const { token: agentToken } = await exchanged.json();
	await page.evaluate(() => sessionStorage.removeItem("office-office-session"));
	await page.evaluate((value) => {
		if (!sessionStorage.getItem("office-office-session"))
			sessionStorage.setItem("office-office-session", value);
	}, agentToken);
	await page.reload();
	await page
		.getByRole("button", { name: "Notifications", exact: true })
		.click();
	await page.getByRole("button", { name: "My inbox", exact: true }).click();
	const card = page
		.locator("article")
		.filter({ hasText: "Review the launch notes" });
	await expect(card).toBeVisible();
	await page.screenshot({
		path: testInfo.outputPath("notifications-desktop.png"),
		animations: "disabled",
	});
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(
		page.getByRole("button", { name: "Overview", exact: true }),
	).not.toBeInViewport();
	await card.scrollIntoViewIfNeeded();
	await expect
		.poll(() =>
			page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth,
			),
		)
		.toBe(true);
	await page.screenshot({
		path: testInfo.outputPath("notifications-mobile.png"),
		animations: "disabled",
	});
	await card
		.getByLabel("Response note (optional)")
		.fill("Findings will stay in Office Office.");
	await expect(card.getByText("pending", { exact: true })).toBeVisible();
	await card.getByRole("button", { name: "Mark read", exact: true }).click();
	await expect(card.getByText("Unread", { exact: true })).toHaveCount(0);
	await expect(card.getByLabel("Response note (optional)")).toHaveValue(
		"Findings will stay in Office Office.",
	);
	await card.getByRole("button", { name: "Acknowledge", exact: true }).click();
	await expect(card.getByText("acknowledged", { exact: true })).toBeVisible();
});

test("Request response from task details creates a task-linked inbox item", async ({
	office,
	page,
}) => {
	const { token: adminToken } = await office.bootstrap(true);
	const workspace = await (
		await office.rpc("GetWorkspace", {}, adminToken)
	).json();
	const task = workspace.tasks.find(
		(item: { title: string }) => item.title === "Sample task — plan launch",
	);
	expect(task).toBeDefined();
	const created = await office.rpc(
		"SaveMember",
		{
			member: {
				name: "Prachi",
				kind: "agent",
				role: "member",
				status: "active",
			},
		},
		adminToken,
	);
	expect(created.ok()).toBeTruthy();
	const { member } = await created.json();
	const comment = await office.rpc(
		"SaveTaskComment",
		{
			taskId: task.id,
			body: "@Prachi ordinary progress note, not a response request.",
		},
		adminToken,
	);
	expect(comment.ok()).toBeTruthy();
	const beforeRequest = await office.rpc(
		"ListNotifications",
		{ scope: "all" },
		adminToken,
	);
	expect((await beforeRequest.json()).notifications ?? []).toEqual([]);
	await page.addInitScript((value) => {
		if (!sessionStorage.getItem("office-office-session"))
			sessionStorage.setItem("office-office-session", value);
	}, adminToken);
	await page.goto("/");
	await page.getByRole("button", { name: /^Projects/ }).click();
	await page.getByRole("button", { name: /Sample launch/ }).click();
	await page
		.getByRole("button", {
			name: `Open task: ${task.title}`,
			exact: true,
		})
		.click();
	const dialog = page.getByRole("dialog");
	await dialog
		.getByRole("button", { name: "Request response", exact: true })
		.click();
	const composer = dialog.getByRole("form", { name: "Notification composer" });
	await expect(composer.getByLabel("Title", { exact: true })).toHaveValue(
		`Response requested: ${task.title}`,
	);
	await composer
		.getByLabel("Search recipients", { exact: true })
		.fill("Prachi");
	await composer.getByLabel("Prachi").check();
	await composer
		.getByLabel("Message", { exact: true })
		.fill("Please review this task and reply with findings.");
	await composer
		.getByRole("button", { name: "Send notification", exact: true })
		.click();
	await expect(composer).toHaveCount(0);

	const sent = await office.rpc(
		"ListNotifications",
		{ scope: "sent", pageSize: 20, offset: 0 },
		adminToken,
	);
	expect(sent.ok()).toBeTruthy();
	expect((await sent.json()).notifications).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				recipientId: member.id,
				title: `Response requested: ${task.title}`,
				kind: "response_request",
				sourceKind: "task",
				sourceId: task.id,
				status: "pending",
			}),
		]),
	);
});

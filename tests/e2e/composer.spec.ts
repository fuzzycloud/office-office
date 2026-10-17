import { expect, test } from "./fixtures";

test("Keyboard mentions stay FYI, requests are explicit, and no-op edits do not claim a second notification", async ({
	office,
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const { token } = await office.bootstrap();
	const created = await office.rpc(
		"SaveMember",
		{
			member: {
				name: "Tara Review",
				kind: "agent",
				role: "member",
				status: "active",
			},
		},
		token,
	);
	expect(created.ok()).toBeTruthy();
	const { member, secret } = await created.json();
	const exchange = await (
		await office.rpc("ExchangeAgentKey", { key: secret })
	).json();
	const workspace = await (await office.rpc("GetWorkspace", {}, token)).json();
	const task = workspace.tasks[0];
	await page.addInitScript(
		(value) => sessionStorage.setItem("office-office-session", value),
		token,
	);
	await page.goto(`/projects?sourceKind=task&sourceId=${task.id}`);
	const dialog = page.getByRole("dialog").filter({
		has: page.getByRole("heading", { name: task.title, exact: true }),
	});
	const body = dialog.getByLabel("Add a comment", { exact: true });
	await body.fill("Please review @Tar");
	await expect(
		dialog.getByRole("listbox", { name: "Active teammates" }),
	).toBeVisible();
	await body.press("Escape");
	await expect(dialog).toBeVisible();
	await expect(
		dialog.getByRole("listbox", { name: "Active teammates" }),
	).toHaveCount(0);
	await body.press("End");
	await body.pressSequentially("a");
	await body.press("Enter");
	await expect(
		dialog.getByRole("list", { name: "Mention / FYI recipients" }),
	).toContainText(member.name);
	await dialog
		.getByRole("button", { name: "Post comment", exact: true })
		.click();
	const receipt = dialog.getByRole("status", { name: "Notification receipt" });
	await expect(receipt).toContainText(`Mention / FYI notified: ${member.name}`);
	const polled = await (
		await office.rpc("PollNotifications", {}, exchange.token)
	).json();
	expect(polled.notifications).toEqual([
		expect.objectContaining({ kind: "notice", recipientId: member.id }),
	]);
	const comment = dialog
		.getByRole("article")
		.filter({ hasText: `Please review @${member.name}` });
	await comment
		.getByRole("button", { name: "Edit comment", exact: true })
		.click();
	await dialog
		.getByRole("button", { name: "Save comment", exact: true })
		.click();
	await expect(receipt).toContainText("No new notifications were created.");

	await body.fill("A decision is needed");
	await dialog
		.getByRole("button", { name: "Add response request", exact: true })
		.click();
	await dialog
		.getByRole("combobox", {
			name: "Find teammate to request a response",
			exact: true,
		})
		.fill(member.name);
	await dialog.getByRole("option").filter({ hasText: member.name }).click();
	await body.fill("A decision is needed from @Tar");
	await body.press("Enter");
	await expect(
		dialog.getByRole("list", { name: "Request response recipients" }),
	).toContainText(member.name);
	await expect(
		dialog.getByRole("list", { name: "Mention / FYI recipients" }),
	).toHaveCount(0);
	await dialog
		.getByRole("button", { name: "Post comment", exact: true })
		.click();
	await expect(receipt).toContainText(
		`Response requested from: ${member.name}`,
	);
	const requested = await (
		await office.rpc(
			"PollNotifications",
			{ afterCursor: polled.nextCursor },
			exchange.token,
		)
	).json();
	expect(requested.notifications).toEqual([
		expect.objectContaining({
			kind: "response_request",
			recipientId: member.id,
		}),
	]);
	await expect
		.poll(() =>
			page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
		)
		.toBeTruthy();
});

test("Unlinked names require acknowledgement, removing a chip restores the warning, and emails remain ordinary text", async ({
	office,
	page,
}) => {
	const { token, user } = await office.bootstrap();
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
	const body = discussion.getByLabel("Add project message", { exact: true });
	let writes = 0;
	page.on("request", (request) => {
		if (request.url().endsWith("/SaveProjectMessage")) writes++;
	});
	await body.fill("Ask @unlinked-person before continuing");
	await discussion
		.getByRole("button", { name: "Post message", exact: true })
		.click();
	await expect(discussion.getByRole("alert")).toContainText(
		"Choose recipients",
	);
	expect(writes).toBe(0);
	await discussion
		.getByLabel("Post without notifying these names", { exact: true })
		.check();
	await body.fill("Ask @another-person before continuing");
	await expect(
		discussion.getByLabel("Post without notifying these names", {
			exact: true,
		}),
	).not.toBeChecked();
	await discussion
		.getByLabel("Post without notifying these names", { exact: true })
		.check();
	await discussion
		.getByRole("button", { name: "Post message", exact: true })
		.click();
	const receipt = discussion.getByRole("status", {
		name: "Notification receipt",
	});
	await expect(receipt).toContainText("No new notifications were created.");
	await body.fill("Contact reviewer@example.test for the source material");
	await expect(
		discussion.getByLabel("Post without notifying these names", {
			exact: true,
		}),
	).toHaveCount(0);
	await discussion
		.getByRole("button", { name: "Post message", exact: true })
		.click();
	await expect(body).toHaveValue("");
	await body.fill("A note for @E2E");
	await discussion.getByRole("option").filter({ hasText: user.email }).click();
	await expect(
		discussion.getByRole("list", { name: "Mention / FYI recipients" }),
	).toContainText(user.name);
	await discussion
		.getByRole("button", {
			name: new RegExp(`Remove ${user.name}.*from Mention / FYI`),
		})
		.click();
	await expect(
		discussion.getByLabel("Post without notifying these names", {
			exact: true,
		}),
	).toBeVisible();
	expect(writes).toBe(2);
});

test("Duplicate names require an explicit identity and receipt retries never repeat a successful write", async ({
	office,
	page,
}) => {
	const { token } = await office.bootstrap();
	const recipients = [];
	for (const email of ["tara-one@example.test", "tara-two@example.test"]) {
		const result = await office.rpc(
			"SaveMember",
			{
				member: {
					name: "Tara",
					email,
					kind: "agent",
					role: "member",
					status: "active",
				},
			},
			token,
		);
		expect(result.ok()).toBeTruthy();
		recipients.push((await result.json()).member);
	}
	const workspace = await (await office.rpc("GetWorkspace", {}, token)).json();
	await page.addInitScript(
		(value) => sessionStorage.setItem("office-office-session", value),
		token,
	);
	await page.goto(
		`/projects?sourceKind=project&sourceId=${workspace.projects[0].id}`,
	);
	const discussion = page.getByRole("region", {
		name: "Project discussion",
		exact: true,
	});
	const body = discussion.getByLabel("Add project message", { exact: true });
	await body.fill("Please review @Tara");
	await expect(discussion.getByRole("option")).toHaveCount(2);
	await discussion
		.getByRole("option")
		.filter({ hasText: recipients[1].email })
		.click();
	await expect(
		discussion.getByRole("list", { name: "Mention / FYI recipients" }),
	).toContainText(recipients[1].email);
	let failReceipt = true;
	let failWrite = true;
	let writes = 0;
	page.on("request", (request) => {
		if (request.url().endsWith("/SaveProjectMessage")) writes++;
	});
	await page.route(
		"**/rpc/office.v1.OfficeService/SaveProjectMessage",
		async (route) => {
			if (failWrite)
				await route.fulfill({
					status: 503,
					contentType: "application/json",
					body: JSON.stringify({
						code: "unavailable",
						message: "Save test failure",
					}),
				});
			else await route.continue();
		},
	);
	await page.route(
		"**/rpc/office.v1.OfficeService/ListNotifications",
		async (route) => {
			if (route.request().postDataJSON().scope === "sent" && failReceipt) {
				await route.fulfill({
					status: 503,
					contentType: "application/json",
					body: JSON.stringify({
						code: "unavailable",
						message: "Receipt test failure",
					}),
				});
			} else await route.continue();
		},
	);
	await discussion
		.getByRole("button", { name: "Post message", exact: true })
		.click();
	await expect(discussion.getByRole("alert")).toContainText(
		"Your draft is preserved.",
	);
	await expect(body).toHaveValue("Please review @Tara ");
	await expect(
		discussion.getByRole("list", { name: "Mention / FYI recipients" }),
	).toContainText(recipients[1].email);
	failWrite = false;
	await discussion
		.getByRole("button", { name: "Post message", exact: true })
		.click();
	const receipt = discussion.getByRole("status", {
		name: "Notification receipt",
	});
	await expect(receipt).toContainText(
		"Your message is saved, but notification recipients could not be verified.",
	);
	expect(writes).toBe(2);
	failReceipt = false;
	await receipt
		.getByRole("button", { name: "Retry verification", exact: true })
		.click();
	await expect(receipt).toContainText("Mention / FYI notified: Tara");
	expect(writes).toBe(2);
	const sent = await (
		await office.rpc(
			"ListNotifications",
			{ scope: "sent", pageSize: 100 },
			token,
		)
	).json();
	expect(sent.notifications).toEqual([
		expect.objectContaining({ kind: "notice", recipientId: recipients[1].id }),
	]);
});

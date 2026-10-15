import { expect, test } from "./fixtures";

test("empty registration, authentication and validation protect the real RPC pipeline", async ({
	office,
}) => {
	const setup = await office.rpc("GetSetupStatus");
	expect(await setup.json()).toMatchObject({
		needsSetup: true,
		persistentStorage: true,
	});
	expect((await office.rpc("GetWorkspace")).status()).toBe(401);
	const { token } = await office.bootstrap(false);
	const workspace = await (await office.rpc("GetWorkspace", {}, token)).json();
	expect(workspace.customers ?? []).toEqual([]);
	expect(workspace.projects ?? []).toEqual([]);
	expect(workspace.tasks ?? []).toEqual([]);
	expect(
		(
			await office.rpc("BootstrapAdmin", {
				name: "Replacement",
				email: "replacement@example.test",
				password: "replacement-password-123",
				workspaceName: "Replacement",
			})
		).status(),
	).toBe(409);
	expect(
		(
			await office.rpc("Login", {
				email: "admin@example.test",
				password: "incorrect-password",
			})
		).status(),
	).toBe(401);
	const invalid = await office.rpc(
		"SaveCustomer",
		{ customer: { name: "", company: "Invalid", status: "active" } },
		token,
	);
	expect(invalid.status()).toBe(400);
	const after = await (await office.rpc("GetWorkspace", {}, token)).json();
	expect(after.customers ?? []).toEqual([]);
	expect(after.activity).toEqual(workspace.activity);
});

test("SQLite restart retains records, discussion, reports and a browser session", async ({
	office,
	page,
}) => {
	const { token } = await office.bootstrap(true);
	const workspace = await (await office.rpc("GetWorkspace", {}, token)).json();
	expect(workspace.demoMode).toBe(true);
	expect(workspace.persistentStorage).toBe(true);
	expect(workspace.customers.length).toBeGreaterThan(0);
	expect(workspace.projects.length).toBeGreaterThan(0);
	expect(workspace.connections.length).toBeGreaterThan(0);
	for (const connection of workspace.connections) {
		expect(connection).toMatchObject({ status: "disconnected", demo: true });
	}
	const task = workspace.tasks.find(
		(entry: { title: string }) => entry.title === "Sample task — plan launch",
	);
	const commentResponse = await office.rpc(
		"SaveTaskComment",
		{ taskId: task.id, body: "Persistent browser research update." },
		token,
	);
	expect(commentResponse.ok()).toBeTruthy();
	const { comment } = await commentResponse.json();
	const reportResponse = await office.rpc(
		"SaveReport",
		{
			report: {
				title: "Persistent research",
				body: "Durable research findings.",
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
	await page.goto("/");
	await page.getByRole("button", { name: /^Projects/ }).click();
	await page
		.getByRole("button", { name: `Open task: ${task.title}`, exact: true })
		.click();
	await expect(
		page.getByRole("dialog").getByText(comment.body, { exact: true }),
	).toBeVisible();
	await office.restart();
	const restored = await (await office.rpc("GetWorkspace", {}, token)).json();
	expect(restored.persistentStorage).toBe(true);
	expect(restored.customers).toEqual(workspace.customers);
	expect(
		restored.tasks.find((entry: { id: string }) => entry.id === task.id)
			.commentCount,
	).toBe(task.commentCount + 1);
	const discussion = await (
		await office.rpc("ListTaskDiscussion", { taskId: task.id }, token)
	).json();
	expect(discussion.comments).toContainEqual(comment);
	const restoredReport = await (
		await office.rpc("GetReport", { id: report.id }, token)
	).json();
	expect(restoredReport.report).toEqual(report);
	await page.reload();
	await page.getByRole("button", { name: /^Projects/ }).click();
	await page
		.getByRole("button", { name: `Open task: ${task.title}`, exact: true })
		.click();
	const dialog = page.getByRole("dialog");
	await expect(dialog.getByText(comment.body, { exact: true })).toBeVisible();
	await dialog.getByRole("button", { name: report.title, exact: true }).click();
	await expect(dialog.getByText(report.body, { exact: true })).toBeVisible();
});

test("an exchanged agent token keeps stable member attribution and revocation stops future writes", async ({
	office,
	page,
	request,
}) => {
	const { token } = await office.bootstrap(true);
	const workspace = await (await office.rpc("GetWorkspace", {}, token)).json();
	const task = workspace.tasks.find(
		(entry: { title: string }) => entry.title === "Sample task — plan launch",
	);
	const memberResponse = await office.rpc(
		"SaveMember",
		{
			member: {
				name: "E2E Research Agent",
				kind: "agent",
				role: "member",
				status: "active",
				access: ["projects"],
			},
		},
		token,
	);
	expect(memberResponse.ok()).toBeTruthy();
	const { member } = await memberResponse.json();
	const created = await office.rpc(
		"CreateAgentKey",
		{
			name: "E2E researcher",
			memberId: member.id,
			scopes: ["projects:write"],
			expiresInDays: 1,
		},
		token,
	);
	expect(created.ok()).toBeTruthy();
	const { key, secret } = await created.json();
	const rawKeyMcp = await request.post(`${office.url}/mcp`, {
		headers: {
			Authorization: `Bearer ${secret}`,
			Accept: "application/json, text/event-stream",
			"MCP-Protocol-Version": "2025-03-26",
		},
		data: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
	});
	expect(rawKeyMcp.status()).toBe(401);
	const exchanged = await office.rpc("ExchangeAgentKey", { key: secret });
	expect(exchanged.ok()).toBeTruthy();
	const agentSession = await exchanged.json();
	expect(agentSession.user).toMatchObject({ id: member.id, kind: "agent" });
	const call = () =>
		request.post(`${office.url}/mcp`, {
			headers: {
				Authorization: `Bearer ${agentSession.token}`,
				Accept: "application/json, text/event-stream",
				"MCP-Protocol-Version": "2025-03-26",
			},
			data: {
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "office_add_task_comment",
					arguments: {
						task_id: task.id,
						body: "Agent research is ready for review.",
					},
				},
			},
		});
	const result = await call();
	expect(result.ok()).toBeTruthy();
	// The real MCP server may return JSON or SSE; the authoritative RPC projection verifies the write.
	const discussion = await (
		await office.rpc("ListTaskDiscussion", { taskId: task.id }, token)
	).json();
	const agentComment = discussion.comments.find(
		(entry: { body: string }) =>
			entry.body === "Agent research is ready for review.",
	);
	expect(agentComment).toMatchObject({
		actorKind: "agent",
		authorId: member.id,
	});
	await page.addInitScript(
		(value) => sessionStorage.setItem("office-office-session", value),
		token,
	);
	await page.goto("/");
	await page.getByRole("button", { name: /^Projects/ }).click();
	await page
		.getByRole("button", { name: `Open task: ${task.title}`, exact: true })
		.click();
	const entry = page
		.getByRole("dialog")
		.locator("article")
		.filter({ hasText: agentComment.body });
	await expect(entry.getByText("Agent", { exact: true })).toBeVisible();
	await expect(
		entry.getByText("E2E Research Agent", { exact: true }),
	).toBeVisible();
	expect(
		(await office.rpc("RevokeAgentKey", { id: key.id }, token)).ok(),
	).toBeTruthy();
	expect((await call()).status()).toBe(401);
	expect(
		(
			await office.rpc(
				"SaveTaskComment",
				{ taskId: task.id, body: "Revoked token cannot write" },
				agentSession.token,
			)
		).status(),
	).toBe(401);
	expect((await office.rpc("ExchangeAgentKey", { key: secret })).status()).toBe(
		401,
	);
	const after = await (
		await office.rpc("ListTaskDiscussion", { taskId: task.id }, token)
	).json();
	expect(after.comments).toEqual(discussion.comments);
});

test("agent member status and key scopes are checked on RPC and MCP calls", async ({
	office,
	request,
}) => {
	const { token } = await office.bootstrap();
	const memberResponse = await office.rpc(
		"SaveMember",
		{
			member: {
				name: "Read-only E2E Agent",
				kind: "agent",
				role: "member",
				status: "active",
				access: ["projects"],
			},
		},
		token,
	);
	expect(memberResponse.ok()).toBeTruthy();
	const { member } = await memberResponse.json();
	const created = await office.rpc(
		"CreateAgentKey",
		{
			name: "E2E read-only key",
			memberId: member.id,
			scopes: ["projects:read"],
			expiresInDays: 1,
		},
		token,
	);
	expect(created.ok()).toBeTruthy();
	const { key, secret } = await created.json();
	const exchange = await office.rpc("ExchangeAgentKey", { key: secret });
	expect(exchange.ok()).toBeTruthy();
	const { token: agentToken } = await exchange.json();
	const workspace = await (await office.rpc("GetWorkspace", {}, token)).json();
	const task = workspace.tasks[0];
	const mcpWrite = await request.post(`${office.url}/mcp`, {
		headers: {
			Authorization: `Bearer ${agentToken}`,
			Accept: "application/json, text/event-stream",
			"MCP-Protocol-Version": "2025-03-26",
		},
		data: {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "office_add_task_comment",
				arguments: { task_id: task.id, body: "Must be denied" },
			},
		},
	});
	expect(mcpWrite.ok()).toBeTruthy();
	expect((await mcpWrite.json()).result.isError).toBe(true);
	const rpcWrite = await office.rpc(
		"SaveTaskComment",
		{ taskId: task.id, body: "Must also be denied" },
		agentToken,
	);
	expect(rpcWrite.status()).toBe(403);

	const disabled = await office.rpc(
		"SaveMember",
		{ member: { ...member, status: "inactive" } },
		token,
	);
	expect(disabled.ok()).toBeTruthy();
	expect((await office.rpc("GetWorkspace", {}, agentToken)).status()).toBe(401);
	expect((await office.rpc("ExchangeAgentKey", { key: secret })).status()).toBe(
		401,
	);
	const revokedKey = await office.rpc("RevokeAgentKey", { id: key.id }, token);
	expect(revokedKey.ok()).toBeTruthy();
});

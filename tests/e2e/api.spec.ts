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

test("AI member creation issues a key for direct MCP and token access with stable attribution", async ({
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
			},
		},
		token,
	);
	expect(memberResponse.ok()).toBeTruthy();
	const { member, agentKey: key, secret } = await memberResponse.json();
	expect(secret).toMatch(/^oo_[a-f0-9]{64}$/);
	expect(key).toMatchObject({ memberId: member.id });
	expect(key.scopes ?? []).toEqual([]);
	expect(
		Math.abs(key.expiresAt - key.createdAt - 90 * 86_400),
	).toBeLessThanOrEqual(1);
	const rawKeyMcp = await request.post(`${office.url}/mcp`, {
		headers: {
			Authorization: `Bearer ${secret}`,
			Accept: "application/json, text/event-stream",
			"MCP-Protocol-Version": "2025-03-26",
		},
		data: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
	});
	expect(rawKeyMcp.ok()).toBeTruthy();
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
			await request.post(`${office.url}/mcp`, {
				headers: {
					Authorization: `Bearer ${secret}`,
					Accept: "application/json, text/event-stream",
					"MCP-Protocol-Version": "2025-03-26",
				},
				data: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
			})
		).status(),
	).toBe(401);
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

test("fixed roles expose the same permissions in ListRoles and GetWorkspace and enforce writes", async ({
	office,
}) => {
	const { token: adminToken } = await office.bootstrap(true);
	const modules = [
		"team",
		"customers",
		"projects",
		"reports",
		"social",
		"settings",
	];
	const writeModules: Record<string, string[]> = {
		admin: modules,
		manager: ["customers", "projects", "reports", "social"],
		member: ["projects", "reports"],
		viewer: [],
	};
	const rolesResponse = await office.rpc("ListRoles", {}, adminToken);
	expect(rolesResponse.ok()).toBeTruthy();
	const { roles } = await rolesResponse.json();
	expect(roles.map((role: { id: string }) => role.id)).toEqual([
		"admin",
		"manager",
		"member",
		"viewer",
	]);
	for (const role of roles) {
		const expected = modules.flatMap((module) => [
			`${module}:read`,
			...(writeModules[role.id].includes(module) ? [`${module}:write`] : []),
		]);
		expect(role.permissions).toEqual(expected);
	}
	const adminWorkspace = await (
		await office.rpc("GetWorkspace", {}, adminToken)
	).json();
	const connectionId = adminWorkspace.connections[0].id;
	for (const role of ["admin", "manager", "member", "viewer"]) {
		let token = adminToken;
		if (role !== "admin") {
			const email = `${role}@example.test`;
			const saved = await office.rpc(
				"SaveMember",
				{
					member: { name: `E2E ${role}`, email, role, status: "active" },
					password: "role-password-123",
				},
				adminToken,
			);
			expect(saved.ok()).toBeTruthy();
			const login = await office.rpc("Login", {
				email,
				password: "role-password-123",
			});
			expect(login.ok()).toBeTruthy();
			token = (await login.json()).token;
		}
		const workspaceResponse = await office.rpc("GetWorkspace", {}, token);
		expect(workspaceResponse.ok()).toBeTruthy();
		const workspace = await workspaceResponse.json();
		expect(workspace.permissions).toEqual(
			roles.find((item: { id: string }) => item.id === role).permissions,
		);
		expect(workspace.members.length).toBeGreaterThan(0);
		expect(workspace.customers.length).toBeGreaterThan(0);
		expect(workspace.projects.length).toBeGreaterThan(0);
		expect(workspace.connections.length).toBeGreaterThan(0);
		expect(workspace.settings).toBeDefined();
		expect((await office.rpc("ListReports", {}, token)).ok()).toBeTruthy();
		const writes: Record<string, [string, unknown]> = {
			team: [
				"SaveMember",
				{
					member: {
						name: `Writer by ${role}`,
						email: `writer-${role}@example.test`,
						role: "viewer",
						status: "active",
					},
					password: "writer-password-123",
				},
			],
			customers: [
				"SaveCustomer",
				{
					customer: {
						name: `Customer by ${role}`,
						company: "E2E",
						status: "active",
					},
				},
			],
			projects: [
				"SaveProject",
				{ project: { name: `Project by ${role}`, status: "planning" } },
			],
			reports: [
				"SaveReport",
				{
					report: {
						title: `Report by ${role}`,
						kind: "research",
						status: "draft",
						body: "Role matrix.",
					},
				},
			],
			social: [
				"SavePost",
				{
					post: { content: `Draft by ${role}`, connectionId, status: "draft" },
				},
			],
			settings: ["SaveSettings", { settings: workspace.settings }],
		};
		for (const module of modules) {
			const [method, body] = writes[module];
			const response = await office.rpc(method, body, token);
			expect(response.status(), `${role} writing ${module}`).toBe(
				writeModules[role].includes(module) ? 200 : 403,
			);
		}
	}
});

test("AI admin can create AI users; rotating a key invalidates every prior key and token", async ({
	office,
}) => {
	const { token: humanAdminToken, user: humanAdmin } = await office.bootstrap();
	const saveAI = async (token: string, name: string, role: string) => {
		const response = await office.rpc(
			"SaveMember",
			{ member: { name, kind: "agent", role, status: "active" } },
			token,
		);
		expect(response.ok()).toBeTruthy();
		return response.json();
	};
	const adminAI = await saveAI(humanAdminToken, "AI administrator", "admin");
	const adminSession = await office.rpc("ExchangeAgentKey", {
		key: adminAI.secret,
	});
	expect(adminSession.ok()).toBeTruthy();
	const { token: aiAdminToken } = await adminSession.json();
	const subordinate = await saveAI(aiAdminToken, "AI researcher", "member");
	expect(subordinate.agentKey).toMatchObject({
		memberId: subordinate.member.id,
		issuedBy: adminAI.member.id,
	});
	const memberSession = await office.rpc("ExchangeAgentKey", {
		key: subordinate.secret,
	});
	expect(memberSession.ok()).toBeTruthy();
	const { token: oldToken } = await memberSession.json();
	const memberWorkspace = await (
		await office.rpc("GetWorkspace", {}, oldToken)
	).json();
	expect(memberWorkspace.permissions).toEqual([
		"team:read",
		"customers:read",
		"projects:read",
		"projects:write",
		"reports:read",
		"reports:write",
		"social:read",
		"settings:read",
	]);
	expect(
		(
			await office.rpc(
				"SaveProject",
				{ project: { name: "AI member project", status: "planning" } },
				oldToken,
			)
		).ok(),
	).toBeTruthy();
	expect(
		(
			await office.rpc(
				"SaveMember",
				{
					member: {
						name: "Unauthorized AI user",
						kind: "agent",
						role: "viewer",
						status: "active",
					},
				},
				oldToken,
			)
		).status(),
	).toBe(403);
	const secondResponse = await office.rpc(
		"CreateAgentKey",
		{ memberId: subordinate.member.id },
		aiAdminToken,
	);
	expect(secondResponse.ok()).toBeTruthy();
	const second = await secondResponse.json();
	const secondSession = await office.rpc("ExchangeAgentKey", {
		key: second.secret,
	});
	expect(secondSession.ok()).toBeTruthy();
	const { token: secondToken } = await secondSession.json();
	const rotatedResponse = await office.rpc(
		"RotateAgentKey",
		{ memberId: subordinate.member.id },
		aiAdminToken,
	);
	expect(rotatedResponse.ok()).toBeTruthy();
	const rotated = await rotatedResponse.json();
	expect(rotated.secret).toMatch(/^oo_[a-f0-9]{64}$/);
	expect(rotated.key).toMatchObject({
		memberId: subordinate.member.id,
		issuedBy: adminAI.member.id,
	});
	for (const oldKey of [subordinate.secret, second.secret]) {
		expect(
			(await office.rpc("ExchangeAgentKey", { key: oldKey })).status(),
		).toBe(401);
	}
	for (const oldSession of [oldToken, secondToken]) {
		expect((await office.rpc("GetWorkspace", {}, oldSession)).status()).toBe(
			401,
		);
	}
	expect(
		(await office.rpc("ExchangeAgentKey", { key: rotated.secret })).ok(),
	).toBeTruthy();
	const keys = await (
		await office.rpc("ListAgentKeys", {}, aiAdminToken)
	).json();
	expect(
		keys.keys.filter(
			(key: { memberId: string; revoked: boolean }) =>
				key.memberId === subordinate.member.id && !key.revoked,
		),
	).toHaveLength(1);
	const demoteHuman = await office.rpc(
		"SaveMember",
		{ member: { ...humanAdmin, role: "viewer" } },
		aiAdminToken,
	);
	expect(demoteHuman.status()).toBe(400);
});

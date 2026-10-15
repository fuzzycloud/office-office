import { expect, type Office, test } from "./fixtures";

const viewerEmail = "profile-viewer@example.test";
const viewerPassword = "profile-viewer-password-123";

async function createViewer(office: Office, adminToken: string) {
	const response = await office.rpc(
		"SaveMember",
		{
			member: {
				name: "Profile Viewer",
				email: viewerEmail,
				role: "viewer",
				status: "active",
			},
			password: viewerPassword,
		},
		adminToken,
	);
	expect(response.ok()).toBeTruthy();
	const { member } = await response.json();
	const login = await office.rpc("Login", {
		email: viewerEmail,
		password: viewerPassword,
	});
	expect(login.ok()).toBeTruthy();
	return { member, token: (await login.json()).token as string };
}

test("Viewer can edit only their profile, with validated fields that survive restart", async ({
	office,
}) => {
	const { token: adminToken } = await office.bootstrap(false);
	const { member: initial, token: viewerToken } = await createViewer(
		office,
		adminToken,
	);
	const avatarUrl = "https://images.example.test/viewer.png";
	const bio = "Researcher and careful reader.";
	expect((await office.rpc("SaveProfile", { bio, avatarUrl })).status()).toBe(
		401,
	);
	const savedResponse = await office.rpc(
		"SaveProfile",
		{ bio, avatarUrl },
		viewerToken,
	);
	expect(savedResponse.ok()).toBeTruthy();
	const { member: saved } = await savedResponse.json();
	expect(saved).toMatchObject({
		...initial,
		bio,
		avatarUrl,
	});
	const adminWorkspace = await (
		await office.rpc("GetWorkspace", {}, adminToken)
	).json();
	expect(
		adminWorkspace.members.find(
			(member: { id: string }) => member.id === initial.id,
		),
	).toMatchObject(saved);
	const viewerWorkspace = await (
		await office.rpc("GetWorkspace", {}, viewerToken)
	).json();
	expect(viewerWorkspace.permissions).not.toContain("team:write");
	expect(
		viewerWorkspace.members.find(
			(member: { id: string }) => member.id === initial.id,
		),
	).toMatchObject(saved);
	expect(
		(
			await office.rpc(
				"SaveMember",
				{
					member: {
						...initial,
						name: "Unauthorized rename",
					},
				},
				viewerToken,
			)
		).status(),
	).toBe(403);

	for (const invalid of [
		{ bio, avatarUrl: "http://images.example.test/viewer.png" },
		{ bio, avatarUrl: "https://user:pass@images.example.test/viewer.png" },
		{ bio, avatarUrl: `https://images.example.test/${"a".repeat(2049)}` },
		{ bio: "🙂".repeat(501), avatarUrl },
	]) {
		expect(
			(await office.rpc("SaveProfile", invalid, viewerToken)).status(),
		).toBe(400);
	}
	const afterInvalid = await (
		await office.rpc("GetWorkspace", {}, adminToken)
	).json();
	expect(
		afterInvalid.members.find(
			(member: { id: string }) => member.id === initial.id,
		),
	).toMatchObject(saved);

	await office.restart();
	const restored = await (
		await office.rpc("GetWorkspace", {}, adminToken)
	).json();
	expect(
		restored.members.find((member: { id: string }) => member.id === initial.id),
	).toMatchObject(saved);
	const cleared = await office.rpc(
		"SaveProfile",
		{ bio: "", avatarUrl: "" },
		viewerToken,
	);
	expect(cleared.ok()).toBeTruthy();
	const clearedMember = (await cleared.json()).member;
	expect(clearedMember).toMatchObject(initial);
	expect(clearedMember.bio ?? "").toBe("");
	expect(clearedMember.avatarUrl ?? "").toBe("");
});

test("Viewer edits their profile in Settings and sees the image in Team", async ({
	office,
	page,
}) => {
	const { token: adminToken } = await office.bootstrap(false);
	const { member, token } = await createViewer(office, adminToken);
	const avatarUrl = "https://images.example.test/profile-viewer.png";
	const brokenAvatarUrl = "https://images.example.test/missing-viewer.png";
	let imageRequests = 0;
	await page.route(avatarUrl, async (route) => {
		imageRequests += 1;
		await route.fulfill({
			status: 200,
			contentType: "image/png",
			body: Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=",
				"base64",
			),
		});
	});
	await page.route(brokenAvatarUrl, (route) => route.fulfill({ status: 404 }));
	await page.addInitScript(
		(value) => sessionStorage.setItem("office-office-session", value),
		token,
	);
	await page.goto("/");
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(page.getByText("Your profile", { exact: true })).toBeVisible();
	await page
		.getByLabel("Bio", { exact: true })
		.fill("A short viewer biography.");
	await page
		.getByLabel("Profile picture URL (hosted HTTPS image)", { exact: true })
		.fill(avatarUrl);
	await page.getByRole("button", { name: "Save profile" }).click();
	await expect(page.getByRole("status")).toHaveText("Profile saved.");
	await expect(
		page.getByRole("img", { name: "Profile Viewer avatar" }).first(),
	).toHaveJSProperty("naturalWidth", 1);
	expect(imageRequests).toBeGreaterThan(0);
	const after = await (await office.rpc("GetWorkspace", {}, adminToken)).json();
	expect(
		after.members.find((entry: { id: string }) => entry.id === member.id),
	).toMatchObject({
		bio: "A short viewer biography.",
		avatarUrl,
		role: "viewer",
		status: "active",
	});
	await page.getByRole("button", { name: "Team", exact: true }).click();
	const row = page.getByRole("row").filter({ hasText: "Profile Viewer" });
	await expect(row.getByText("A short viewer biography.")).toBeVisible();
	await expect(
		row.getByRole("img", { name: "Profile Viewer avatar" }),
	).toHaveJSProperty("naturalWidth", 1);
	await expect(page.getByRole("button", { name: /Add member/ })).toHaveCount(0);

	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const profile = page
		.locator("section.card")
		.filter({ hasText: "Your profile" });
	await profile
		.getByLabel("Profile picture URL (hosted HTTPS image)", { exact: true })
		.fill(brokenAvatarUrl);
	await Promise.all([
		page.waitForResponse(
			(response) =>
				response.url().endsWith("/office.v1.OfficeService/SaveProfile") &&
				response.ok(),
		),
		profile.getByRole("button", { name: "Save profile" }).click(),
	]);
	await expect(profile.getByLabel("Profile Viewer initials")).toBeVisible();
	await profile
		.getByLabel("Profile picture URL (hosted HTTPS image)", { exact: true })
		.fill(avatarUrl);
	await Promise.all([
		page.waitForResponse(
			(response) =>
				response.url().endsWith("/office.v1.OfficeService/SaveProfile") &&
				response.ok(),
		),
		profile.getByRole("button", { name: "Save profile" }).click(),
	]);
	await expect(
		profile.getByRole("img", { name: "Profile Viewer avatar" }),
	).toHaveJSProperty("naturalWidth", 1);
});

test("AI Viewer updates its own profile through MCP without changing its key", async ({
	office,
	request,
}) => {
	const { token: adminToken } = await office.bootstrap(false);
	const created = await office.rpc(
		"SaveMember",
		{
			member: {
				name: "Profile Agent",
				kind: "agent",
				role: "viewer",
				status: "active",
			},
		},
		adminToken,
	);
	expect(created.ok()).toBeTruthy();
	const { member, agentKey, secret } = await created.json();
	const call = await request.post(`${office.url}/mcp`, {
		headers: {
			Authorization: `Bearer ${secret}`,
			Accept: "application/json, text/event-stream",
			"MCP-Protocol-Version": "2025-03-26",
		},
		data: {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "office_update_profile",
				arguments: {
					bio: "An AI colleague.",
					avatar_url: "https://images.example.test/agent.png",
				},
			},
		},
	});
	expect(call.ok()).toBeTruthy();
	const workspace = await (
		await office.rpc("GetWorkspace", {}, adminToken)
	).json();
	expect(
		workspace.members.find((entry: { id: string }) => entry.id === member.id),
	).toMatchObject({
		...member,
		bio: "An AI colleague.",
		avatarUrl: "https://images.example.test/agent.png",
	});
	const keys = await (await office.rpc("ListAgentKeys", {}, adminToken)).json();
	expect(
		keys.keys.find((key: { id: string }) => key.id === agentKey.id),
	).toMatchObject(agentKey);
	const exchange = await office.rpc("ExchangeAgentKey", { key: secret });
	expect(exchange.ok()).toBeTruthy();
	expect((await exchange.json()).user).toMatchObject({
		id: member.id,
		role: "viewer",
	});
});

import { expect, test } from "./fixtures";

test("rotated keys are revealed only to the session that requested them", async ({
	page,
	office,
}) => {
	const { token } = await office.bootstrap(false);
	expect(
		(
			await office.rpc(
				"SaveMember",
				{
					member: {
						name: "Rotation agent",
						kind: "agent",
						role: "member",
						status: "active",
					},
				},
				token,
			)
		).ok(),
	).toBeTruthy();
	expect(
		(
			await office.rpc(
				"SaveMember",
				{
					member: {
						name: "Next viewer",
						email: "next@example.test",
						kind: "human",
						role: "viewer",
						status: "active",
					},
					password: "next-viewer-password-123",
				},
				token,
			)
		).ok(),
	).toBeTruthy();
	await page.addInitScript(
		(value) => sessionStorage.setItem("office-office-session", value),
		token,
	);
	await page.goto("/settings");
	const rotate = page.getByRole("button", { name: "Rotate key", exact: true });
	await rotate.click();
	const reveal = page.getByRole("dialog", {
		name: "Copy your new key",
		exact: true,
	});
	await expect(reveal).toBeVisible();
	const currentSecret = await reveal.locator("code").innerText();
	expect(
		(await office.rpc("ExchangeAgentKey", { key: currentSecret })).ok(),
	).toBeTruthy();
	await reveal.getByRole("button", { name: "Done", exact: true }).click();

	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let fetched!: () => void;
	const actualResponseReady = new Promise<void>((resolve) => {
		fetched = resolve;
	});
	let delayedSecret = "";
	await page.route(
		"**/office.v1.OfficeService/RotateAgentKey",
		async (route) => {
			const response = await route.fetch();
			expect(response.ok()).toBeTruthy();
			delayedSecret = (await response.json()).secret;
			fetched();
			await held;
			await route.fulfill({ response });
		},
		{ times: 1 },
	);
	await rotate.click();
	await actualResponseReady;
	await page.getByRole("button", { name: "Sign out", exact: true }).click();
	await page
		.getByLabel("Email address", { exact: true })
		.fill("next@example.test");
	await page
		.getByLabel("Password", { exact: true })
		.fill("next-viewer-password-123");
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(
		page.getByRole("heading", {
			name: "Your office, at a glance",
			exact: true,
		}),
	).toBeVisible();
	const responseDelivered = page.waitForResponse(
		"**/office.v1.OfficeService/RotateAgentKey",
	);
	release();
	await (await responseDelivered).finished();
	// Let the browser consume the response and run any mutation callbacks.
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			),
	);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(page.getByText("Your profile", { exact: true })).toBeVisible();
	await expect(reveal).toHaveCount(0);
	await expect(page.getByText(delayedSecret, { exact: true })).toHaveCount(0);
	const viewerToken = await page.evaluate(() =>
		sessionStorage.getItem("office-office-session"),
	);
	if (!viewerToken) throw new Error("Viewer session was lost");
	const workspace = await office.rpc("GetWorkspace", {}, viewerToken);
	expect(workspace.ok()).toBeTruthy();
	expect((await workspace.json()).currentUser.role).toBe("viewer");
});

test("an old unauthorized response cannot sign out a newer session", async ({
	page,
	office,
}) => {
	const { token } = await office.bootstrap(false);
	expect(
		(
			await office.rpc(
				"SaveMember",
				{
					member: {
						name: "Next viewer",
						email: "next@example.test",
						role: "viewer",
						status: "active",
					},
					password: "next-viewer-password-123",
				},
				token,
			)
		).ok(),
	).toBeTruthy();
	await page.addInitScript(
		(value) => sessionStorage.setItem("office-office-session", value),
		token,
	);
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let fetched: () => void = () => {};
	const ready = new Promise<void>((resolve) => {
		fetched = resolve;
	});
	await page.route(
		"**/office.v1.OfficeService/ListAgentKeys",
		async (route) => {
			// Ask the real server to reject an invalid older credential, then delay
			// its response until a different member has signed in.
			const response = await route.fetch({
				headers: {
					...route.request().headers(),
					authorization: "Bearer invalid-older-session",
				},
			});
			expect(response.status()).toBe(401);
			fetched();
			await held;
			await route.fulfill({ response });
		},
		{ times: 1 },
	);
	await page.goto("/settings");
	await ready;
	await page.getByRole("button", { name: "Sign out", exact: true }).click();
	await page
		.getByLabel("Email address", { exact: true })
		.fill("next@example.test");
	await page
		.getByLabel("Password", { exact: true })
		.fill("next-viewer-password-123");
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(
		page.getByRole("heading", {
			name: "Your office, at a glance",
			exact: true,
		}),
	).toBeVisible();
	const delivered = page.waitForResponse(
		"**/office.v1.OfficeService/ListAgentKeys",
	);
	release();
	await (await delivered).finished();
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			),
	);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(page.getByText("Your profile", { exact: true })).toBeVisible();
	const viewerToken = await page.evaluate(() =>
		sessionStorage.getItem("office-office-session"),
	);
	if (!viewerToken)
		throw new Error("The new session was cleared by an older response");
	const workspace = await office.rpc("GetWorkspace", {}, viewerToken);
	expect(workspace.ok()).toBeTruthy();
	expect((await workspace.json()).currentUser.role).toBe("viewer");
});

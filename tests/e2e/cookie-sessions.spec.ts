import type { Page } from "@playwright/test";
import { browserRpc, expect, test } from "./fixtures";

const csrf = { "X-Office-CSRF": "1" };
const credentials = {
	email: "admin@example.test",
	password: "e2e-admin-password-123",
};

async function signIn(page: Page) {
	await page.goto("/");
	await page
		.getByLabel("Email address", { exact: true })
		.fill(credentials.email);
	await page.getByLabel("Password", { exact: true }).fill(credentials.password);
	const response = page.waitForResponse("**/auth/login");
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	const login = await response;
	expect(login.ok()).toBeTruthy();
	expect(await login.json()).not.toHaveProperty("token");
	expect(login.request().headers()["x-office-csrf"]).toBe("1");
	await expect(
		page.getByRole("heading", {
			name: "Your office, at a glance",
			exact: true,
		}),
	).toBeVisible();
	return login;
}

test("UI login keeps a seven-day HttpOnly cookie and recovers in a new browser context", async ({
	office,
	page,
	browser,
}) => {
	await office.bootstrap(false);
	const before = Date.now() / 1000;
	await signIn(page);
	const cookies = await page.context().cookies(office.url);
	const session = cookies.find((cookie) => cookie.name === "office_session");
	expect(session).toMatchObject({
		httpOnly: true,
		sameSite: "Lax",
		path: "/",
		secure: false,
	});
	expect(session?.expires).toBeGreaterThanOrEqual(
		before + 7 * 24 * 60 * 60 - 5,
	);
	expect(session?.expires).toBeLessThanOrEqual(
		Date.now() / 1000 + 7 * 24 * 60 * 60 + 5,
	);
	const visible = await page.evaluate(() => ({
		cookie: document.cookie,
		session: sessionStorage.getItem("office-office-session"),
		local: Object.values(localStorage),
	}));
	expect(visible.cookie).not.toContain("office_session");
	expect(visible.session).toMatch(/^cookie:/);
	expect(visible.session).not.toContain(session?.value);
	expect(visible.local).not.toContain(session?.value);
	const workspace = await browserRpc(page, office.url, "GetWorkspace");
	expect(workspace.ok()).toBeTruthy();

	await page.evaluate(() => sessionStorage.clear());
	const tab = await page.context().newPage();
	await tab.goto(`${office.url}/settings`);
	await expect(tab.getByText("Your profile", { exact: true })).toBeVisible();
	expect(
		await tab.evaluate(() => sessionStorage.getItem("office-office-session")),
	).toMatch(/^cookie:/);
	await tab.close();

	// A fresh context restores only persistent browser state, with no sessionStorage.
	const state = await page.context().storageState();
	await office.restart();
	const restored = await browser.newContext({ storageState: state });
	try {
		const reopened = await restored.newPage();
		await reopened.goto(`${office.url}/settings`);
		await expect(
			reopened.getByText("Your profile", { exact: true }),
		).toBeVisible();
		expect(
			(await browserRpc(reopened, office.url, "GetWorkspace")).ok(),
		).toBeTruthy();
		await reopened
			.getByRole("button", { name: "Sign out", exact: true })
			.click();
		await expect(
			reopened.getByRole("heading", { name: "Sign in", exact: true }),
		).toBeVisible();
		expect(
			(await restored.cookies(office.url)).find(
				(cookie) => cookie.name === "office_session",
			),
		).toBeUndefined();
		expect(
			(await reopened.request.get(`${office.url}/auth/session`)).status(),
		).toBe(401);
		await reopened.evaluate(() => sessionStorage.clear());
		await reopened.reload();
		await expect(
			reopened.getByRole("heading", { name: "Sign in", exact: true }),
		).toBeVisible();
	} finally {
		await restored.close();
	}
});

test("UI bootstrap establishes a cookie without returning or storing a JWT", async ({
	office,
	page,
}) => {
	await page.goto("/");
	await page.getByLabel("Your name", { exact: true }).fill("Cookie Admin");
	await page
		.getByLabel("Workspace name", { exact: true })
		.fill("Cookie office");
	await page
		.getByLabel("Email address", { exact: true })
		.fill(credentials.email);
	await page.getByLabel("Password", { exact: true }).fill(credentials.password);
	await page
		.getByLabel("Confirm password", { exact: true })
		.fill(credentials.password);
	const response = page.waitForResponse("**/auth/bootstrap");
	await page
		.getByRole("button", { name: "Create workspace", exact: true })
		.click();
	const bootstrap = await response;
	expect(bootstrap.ok()).toBeTruthy();
	const result = await bootstrap.json();
	expect(result).not.toHaveProperty("token");
	expect(result.user.email).toBe(credentials.email);
	expect(result.expiresAt).toBeGreaterThan(
		Date.now() / 1000 + 6 * 24 * 60 * 60,
	);
	await expect(page.getByRole("button", { name: /^Projects/ })).toBeVisible();
	expect(
		await page.evaluate(() => sessionStorage.getItem("office-office-session")),
	).toMatch(/^cookie:/);
	expect(await page.evaluate(() => document.cookie)).not.toContain(
		"office_session",
	);
	expect(
		(await browserRpc(page, office.url, "GetWorkspace")).ok(),
	).toBeTruthy();
});

test("cookie RPC and file access require CSRF protection for unsafe requests", async ({
	office,
	page,
}) => {
	await office.bootstrap(false);
	await signIn(page);
	const rpc = `${office.url}/rpc/office.v1.OfficeService/GetWorkspace`;
	expect((await page.request.post(rpc, { data: {} })).status()).toBe(403);
	expect(
		(
			await page.request.post(rpc, {
				data: {},
				headers: { ...csrf, Origin: "https://untrusted.example" },
			})
		).status(),
	).toBe(403);
	expect(
		(await browserRpc(page, office.url, "GetWorkspace")).ok(),
	).toBeTruthy();
	const upload = `${office.url}/api/files?module=profile&name=avatar.txt`;
	expect(
		(await page.request.post(upload, { data: "private bytes" })).status(),
	).toBe(403);
	expect(
		(
			await page.request.post(upload, {
				data: "private bytes",
				headers: { ...csrf, "Content-Type": "text/plain" },
			})
		).status(),
	).toBe(503);
	// Authenticated file requests reach storage/metadata policy rather than a 401.
	expect(
		(
			await page.request.get(`${office.url}/api/files/nonexistent/content`)
		).status(),
	).toBe(404);
	expect((await page.request.post(`${office.url}/auth/logout`)).status()).toBe(
		403,
	);
	expect(
		(await page.request.get(`${office.url}/auth/session`)).ok(),
	).toBeTruthy();
});

// Only the private storage transport is intercepted; login and workspace use the server.
test("cookie sessions upload and download files without a bearer header", async ({
	office,
	page,
}) => {
	await office.bootstrap(false);
	await signIn(page);
	const content = "Cookie authenticated upload";
	let uploaded = false;
	await page.route(
		"**/rpc/office.v1.OfficeService/ListFiles",
		async (route) => {
			const headers = await route.request().allHeaders();
			expect(headers.authorization).toBeUndefined();
			expect(headers.cookie).toContain("office_session=");
			expect(headers["x-office-csrf"]).toBe("1");
			await route.fulfill({
				json: {
					storageConfigured: true,
					files: uploaded
						? [
								{
									id: "cookie-file",
									name: "cookie.txt",
									module: "projects",
									sizeBytes: String(content.length),
									contentType: "text/plain",
									revision: 1,
								},
							]
						: [],
				},
			});
		},
	);
	await page.route("**/api/files?*", async (route) => {
		const headers = await route.request().allHeaders();
		expect(headers.authorization).toBeUndefined();
		expect(headers.cookie).toContain("office_session=");
		expect(headers["x-office-csrf"]).toBe("1");
		expect(route.request().postDataBuffer()?.toString()).toBe(content);
		uploaded = true;
		await route.fulfill({ json: { file: { id: "cookie-file" } } });
	});
	await page.route("**/api/files/cookie-file/content", async (route) => {
		const headers = await route.request().allHeaders();
		expect(headers.authorization).toBeUndefined();
		expect(headers.cookie).toContain("office_session=");
		await route.fulfill({ contentType: "text/plain", body: content });
	});
	await page.getByRole("button", { name: "Files", exact: true }).click();
	await page.getByLabel("Upload a file", { exact: true }).setInputFiles({
		name: "cookie.txt",
		mimeType: "text/plain",
		buffer: Buffer.from(content),
	});
	await page.getByRole("button", { name: "Upload file", exact: true }).click();
	await expect(page.getByText("cookie.txt", { exact: true })).toBeVisible();
	const downloading = page.waitForEvent("download");
	await page.getByRole("button", { name: "Download", exact: true }).click();
	expect((await downloading).suggestedFilename()).toBe("cookie.txt");
});

test("a cookie identity change in another tab clears the admin workspace", async ({
	office,
	page,
}) => {
	const { token } = await office.bootstrap(false);
	const created = await office.rpc(
		"SaveMember",
		{
			member: {
				name: "Cross-tab Viewer",
				email: "cross-tab-viewer@example.test",
				kind: "human",
				role: "viewer",
				status: "active",
			},
			password: "cross-tab-viewer-password-123",
		},
		token,
	);
	expect(created.ok()).toBeTruthy();
	await signIn(page);
	await page.getByRole("button", { name: "Team", exact: true }).click();
	await expect(page.getByRole("button", { name: /Add member/ })).toBeVisible();
	const adminMarker = await page.evaluate(() =>
		sessionStorage.getItem("office-office-session"),
	);
	const other = await page.context().newPage();
	try {
		await other.goto(`${office.url}/settings`);
		await expect(
			other.getByRole("heading", { name: "E2E Admin", exact: true }),
		).toBeVisible();
		await other.getByRole("button", { name: "Sign out", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "Sign in", exact: true }),
		).toBeVisible();
		await expect(page.getByRole("button", { name: /Add member/ })).toHaveCount(
			0,
		);
		await other
			.getByLabel("Email address", { exact: true })
			.fill("cross-tab-viewer@example.test");
		await other
			.getByLabel("Password", { exact: true })
			.fill("cross-tab-viewer-password-123");
		await other.getByRole("button", { name: "Sign in", exact: true }).click();
		await expect(
			page.getByRole("button", { name: "Team", exact: true }),
		).toBeVisible();
		await page.getByRole("button", { name: "Team", exact: true }).click();
		await expect(page.getByRole("button", { name: /Add member/ })).toHaveCount(
			0,
		);
		await page.getByRole("button", { name: "Settings", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "Cross-tab Viewer", exact: true }),
		).toBeVisible();
		const viewerMarker = await page.evaluate(() =>
			sessionStorage.getItem("office-office-session"),
		);
		expect(viewerMarker).toMatch(/^cookie:/);
		expect(viewerMarker).not.toBe(adminMarker);
		const workspace = await browserRpc(page, office.url, "GetWorkspace");
		expect(workspace.ok()).toBeTruthy();
		expect((await workspace.json()).currentUser.role).toBe("viewer");
	} finally {
		await other.close();
	}
});

test("a delayed cookie login response reconciles identity in both tabs", async ({
	office,
	page,
}) => {
	const { token } = await office.bootstrap(false);
	const created = await office.rpc(
		"SaveMember",
		{
			member: {
				name: "Race Viewer",
				email: "race-viewer@example.test",
				kind: "human",
				role: "viewer",
				status: "active",
			},
			password: "race-viewer-password-123",
		},
		token,
	);
	expect(created.ok()).toBeTruthy();
	await page.goto("/");
	const other = await page.context().newPage();
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let fetched: () => void = () => {};
	const ready = new Promise<void>((resolve) => {
		fetched = resolve;
	});
	await page.route(
		"**/auth/login",
		async (route) => {
			const response = await route.fetch();
			expect(response.ok()).toBeTruthy();
			expect((await response.json()).user.role).toBe("admin");
			fetched();
			await held;
			await route.fulfill({ response });
		},
		{ times: 1 },
	);
	try {
		// Both forms start unauthenticated before the held response changes cookies.
		await other.goto(`${office.url}/`);
		await expect(
			other.getByRole("heading", { name: "Sign in", exact: true }),
		).toBeVisible();
		await page
			.getByLabel("Email address", { exact: true })
			.fill(credentials.email);
		await page
			.getByLabel("Password", { exact: true })
			.fill(credentials.password);
		await page.getByRole("button", { name: "Sign in", exact: true }).click();
		await ready;
		await other
			.getByLabel("Email address", { exact: true })
			.fill("race-viewer@example.test");
		await other
			.getByLabel("Password", { exact: true })
			.fill("race-viewer-password-123");
		await other.getByRole("button", { name: "Sign in", exact: true }).click();
		await other.getByRole("button", { name: "Settings", exact: true }).click();
		await expect(
			other.getByRole("heading", { name: "Race Viewer", exact: true }),
		).toBeVisible();
		const viewerMarker = await other.evaluate(() =>
			sessionStorage.getItem("office-office-session"),
		);
		const delivered = page.waitForResponse("**/auth/login");
		release();
		await delivered;
		// A late Set-Cookie can win at the HTTP layer. Both UIs must reconcile to
		// that actual identity instead of retaining a viewer marker over admin data.
		const session = await other.request.get(`${office.url}/auth/session`);
		expect(session.ok()).toBeTruthy();
		const actual = (await session.json()).user;
		expect(actual.role).toBe("admin");
		for (const tab of [page, other]) {
			await expect(
				tab.getByRole("button", { name: "Settings", exact: true }),
			).toBeVisible();
			await tab.getByRole("button", { name: "Settings", exact: true }).click();
			await expect(
				tab.getByRole("heading", { name: actual.name, exact: true }),
			).toBeVisible();
			await expect(
				tab.getByRole("heading", { name: "Race Viewer", exact: true }),
			).toHaveCount(0);
			const workspace = await browserRpc(tab, office.url, "GetWorkspace");
			expect(workspace.ok()).toBeTruthy();
			expect((await workspace.json()).currentUser.id).toBe(actual.id);
			await tab.getByRole("button", { name: "Team", exact: true }).click();
			await expect(
				tab.getByRole("button", { name: /Add member/ }),
			).toBeVisible();
		}
		expect(
			await other.evaluate(() =>
				sessionStorage.getItem("office-office-session"),
			),
		).not.toBe(viewerMarker);
	} finally {
		release();
		await other.close();
	}
});

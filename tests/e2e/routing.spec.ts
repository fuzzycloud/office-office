import { expect, type Office, test } from "./fixtures";

async function agentToken(
	office: Office,
	adminToken: string,
	role: "manager" | "member",
) {
	const created = await office.rpc(
		"SaveMember",
		{
			member: {
				name: `External ${role} agent`,
				kind: "agent",
				role,
				status: "active",
			},
		},
		adminToken,
	);
	expect(created.ok()).toBeTruthy();
	const { secret } = await created.json();
	const exchanged = await office.rpc("ExchangeAgentKey", { key: secret });
	expect(exchanged.ok()).toBeTruthy();
	return (await exchanged.json()).token as string;
}

test("section URLs survive reload and back/forward while revisits load external customer writes", async ({
	office,
	page,
	context,
}) => {
	const { token } = await office.bootstrap(false);
	const writerToken = await agentToken(office, token, "manager");
	await page.addInitScript(
		(value) => sessionStorage.setItem("office-office-session", value),
		token,
	);
	await page.goto("/");
	await page.getByRole("button", { name: /^Projects/ }).click();
	await expect(page).toHaveURL(`${office.url}/projects`);

	const first = await office.rpc(
		"SaveCustomer",
		{
			customer: {
				name: "External customer one",
				company: "Agent Customer One",
				status: "active",
			},
		},
		writerToken,
	);
	expect(first.ok()).toBeTruthy();
	await page.getByRole("button", { name: "Customers", exact: true }).click();
	await expect(page).toHaveURL(`${office.url}/customers`);
	await expect(
		page.getByText("Agent Customer One", { exact: true }),
	).toBeVisible();

	await page.getByRole("button", { name: /^Projects/ }).click();
	await expect(page).toHaveURL(`${office.url}/projects`);
	const second = await office.rpc(
		"SaveCustomer",
		{
			customer: {
				name: "External customer two",
				company: "Agent Customer Two",
				status: "active",
			},
		},
		writerToken,
	);
	expect(second.ok()).toBeTruthy();
	await page.goBack();
	await expect(page).toHaveURL(`${office.url}/customers`);
	await expect(
		page.getByText("Agent Customer Two", { exact: true }),
	).toBeVisible();
	await page.goForward();
	await expect(page).toHaveURL(`${office.url}/projects`);
	await page.goBack();
	await expect(page).toHaveURL(`${office.url}/customers`);
	await expect(
		page.getByText("Agent Customer Two", { exact: true }),
	).toBeVisible();

	const reload = await page.reload();
	expect(reload?.status()).toBe(200);
	await expect(page).toHaveURL(`${office.url}/customers`);
	await expect(
		page.getByText("Agent Customer Two", { exact: true }),
	).toBeVisible();

	const directTab = await context.newPage();
	try {
		await directTab.addInitScript(
			(value) => sessionStorage.setItem("office-office-session", value),
			token,
		);
		const direct = await directTab.goto(`${office.url}/customers`);
		expect(direct?.status()).toBe(200);
		await expect(directTab).toHaveURL(`${office.url}/customers`);
		await expect(
			directTab.getByText("Agent Customer Two", { exact: true }),
		).toBeVisible();
	} finally {
		await directTab.close();
	}
});

test("an unauthenticated deep URL returns to its section after login", async ({
	office,
	page,
}) => {
	await office.bootstrap(false);
	const deepLink = await page.goto(`${office.url}/settings`);
	expect(deepLink?.status()).toBe(200);
	await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
	await page
		.getByLabel("Email address", { exact: true })
		.fill("admin@example.test");
	await page
		.getByLabel("Password", { exact: true })
		.fill("e2e-admin-password-123");
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(page).toHaveURL(`${office.url}/settings`);
	await expect(page.getByText("Your profile", { exact: true })).toBeVisible();

	const missing = await page.goto(`${office.url}/unknown-section`);
	expect(missing?.status()).toBe(200);
	await expect(
		page.getByRole("heading", { name: "Page not found" }),
	).toBeVisible();
	await expect(
		page.getByRole("link", { name: "Return to overview" }),
	).toBeVisible();
});

test("Reports refreshes its separate list after an AI member writes while away", async ({
	office,
	page,
}) => {
	const { token: adminToken } = await office.bootstrap(false);
	const writerToken = await agentToken(office, adminToken, "member");
	await page.addInitScript(
		(value) => sessionStorage.setItem("office-office-session", value),
		adminToken,
	);
	await page.goto("/");
	await page.getByRole("button", { name: "Reports", exact: true }).click();
	await expect(page).toHaveURL(`${office.url}/reports`);
	await expect(
		page.getByRole("button", { name: /External agent route report/ }),
	).toHaveCount(0);
	await page.getByRole("button", { name: /^Projects/ }).click();
	await expect(page).toHaveURL(`${office.url}/projects`);
	const saved = await office.rpc(
		"SaveReport",
		{
			report: {
				title: "External agent route report",
				kind: "research",
				status: "draft",
				body: "Created by an AI user while the browser is elsewhere.",
			},
		},
		writerToken,
	);
	expect(saved.ok()).toBeTruthy();
	await page.goBack();
	await expect(page).toHaveURL(`${office.url}/reports`);
	await expect(
		page.getByRole("button", { name: /External agent route report/ }),
	).toBeVisible();
});

test("A board source opens that project's exact board", async ({
	office,
	page,
}) => {
	const { token } = await office.bootstrap();
	const workspace = await (await office.rpc("GetWorkspace", {}, token)).json();
	const board = workspace.boards.find(
		(item: { name: string }) => item.name === "Sample editorial board",
	);
	await page.addInitScript(
		(value) => sessionStorage.setItem("office-office-session", value),
		token,
	);
	await page.goto(`/projects?sourceKind=board&sourceId=${board.id}`);
	await expect(
		page.getByRole("tab", { name: /Sample editorial board/ }),
	).toHaveAttribute("aria-selected", "true");
	await expect(
		page.getByRole("region", { name: "Ideas, 1 tasks", exact: true }),
	).toBeVisible();
});

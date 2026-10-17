import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { expect, type Office, test } from "../e2e/fixtures";

const instant = "2030-01-15T09:00:00Z";
const epoch = String(Date.parse(instant) / 1000);
const fontCss =
	[400, 600, 700]
		.map(
			(weight) =>
				`@font-face{font-family:OfficeVisual;src:url('/visual-font-${weight}.woff2') format('woff2');font-weight:${weight};font-style:normal;font-display:block;}`,
		)
		.join("") +
	"html,body,button,input,select,textarea,.report-prose h2,.report-prose h3,.report-prose h4{font-family:OfficeVisual,sans-serif!important}";

// Only presentation timestamps are normalized; writes still enter the real engine.
function stableTimes(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableTimes);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [
			key,
			["createdAt", "updatedAt", "occurredAt"].includes(key) &&
			typeof item === "string"
				? item.includes("T")
					? instant
					: epoch
				: stableTimes(item),
		]),
	);
}
async function rpc(
	office: Office,
	method: string,
	body: unknown,
	token: string,
) {
	const response = await office.rpc(method, body, token);
	expect(response.ok(), `${method} seed command`).toBeTruthy();
	return response.json();
}
async function ready(page: Page) {
	await expect(
		page.getByRole("button", {
			name: "Notifications, 3 unread",
			exact: true,
			includeHidden: true,
		}),
	).toBeVisible();
	await page.addStyleTag({ content: fontCss });
	await page.evaluate(async () => {
		await document.fonts.load("400 16px OfficeVisual");
		await document.fonts.load("600 16px OfficeVisual");
		await document.fonts.load("700 16px OfficeVisual");
		await document.fonts.ready;
	});
	await expect(page.getByText(/^Loading[^a-z]/)).toHaveCount(0);
	await page.mouse.move(0, 0);
}

test("Approved office screens retain layout and SVG icons", async ({
	office,
	page,
}, testInfo) => {
	const theme = testInfo.project.name.startsWith("dark") ? "dark" : "light";
	await page.clock.setFixedTime(new Date(instant));
	const { token, user } = await office.bootstrap(false);
	const { member: agent, secret } = await rpc(
		office,
		"SaveMember",
		{
			member: {
				name: "Sample researcher",
				kind: "agent",
				role: "member",
				status: "active",
				bio: "Research and source verification for the sample office.",
			},
		},
		token,
	);
	const { token: agentToken } = await rpc(
		office,
		"ExchangeAgentKey",
		{ key: secret },
		token,
	);
	const { customer } = await rpc(
		office,
		"SaveCustomer",
		{
			customer: {
				name: "Sample customer",
				company: "Example Studio (sample)",
				email: "sample@example.test",
				status: "active",
				ownerId: user.id,
				notes: "Fictional visual test fixture.",
			},
		},
		token,
	);
	const { project } = await rpc(
		office,
		"SaveProject",
		{
			project: {
				name: "Sample launch",
				customerId: customer.id,
				ownerId: user.id,
				status: "active",
				summary: "Plan the launch, review research, and keep the team aligned.",
				targetDate: "2030-02-01",
			},
		},
		token,
	);
	const workspace = await rpc(office, "GetWorkspace", {}, token);
	const board = workspace.boards.find(
		(item: { projectId: string }) => item.projectId === project.id,
	);
	const { task } = await rpc(
		office,
		"SaveTask",
		{
			task: {
				projectId: project.id,
				boardId: board.id,
				column: board.columns[0],
				title: "Sample: review launch research",
				description:
					"Check the evidence and leave a clear recommendation for the launch team.",
				assigneeId: agent.id,
				priority: "high",
				dueDate: "2030-01-16",
			},
		},
		token,
	);
	await rpc(
		office,
		"SaveTask",
		{
			task: {
				projectId: project.id,
				boardId: board.id,
				column: board.columns[1],
				title: "Sample: prepare the client brief",
				description: "Summarize findings for review.",
				assigneeId: user.id,
				priority: "medium",
				dueDate: "2030-01-20",
			},
		},
		token,
	);
	await rpc(
		office,
		"SaveTaskComment",
		{
			taskId: task.id,
			body: "The sample research draft is ready. Please check the sources and assumptions.",
			mentionIds: [user.id],
		},
		agentToken,
	);
	const { report } = await rpc(
		office,
		"SaveReport",
		{
			report: {
				title: "Sample competitor review",
				summary: "Findings and open questions for the sample launch.",
				body: "# Research findings\n\nThe sample comparison highlights onboarding clarity and response time.\n\n## Recommendation\n\nValidate the assumptions with a small pilot before expanding.",
				kind: "competitor_review",
				status: "draft",
				topic: "Sample launch research",
				period: "January 2030",
				projectId: project.id,
				taskId: task.id,
				sources: [
					{ title: "Sample source", url: "https://example.test/research" },
				],
			},
		},
		token,
	);
	await rpc(
		office,
		"RequestReportReview",
		{
			reportId: report.id,
			reportRevision: report.revision,
			reviewerIds: [agent.id],
			requestId: "visual-review",
		},
		token,
	);
	await rpc(
		office,
		"CreateNotification",
		{
			requestId: "visual-response",
			title: "Sample: choose the next research question",
			body: "Please review the brief and identify the next question to investigate.",
			kind: "response_request",
			recipientIds: [user.id],
			sourceKind: "task",
			sourceId: task.id,
		},
		agentToken,
	);
	const png = await readFile(resolve(__dirname, "assets/sample-gallery.png"));
	await page.route("**/visual-font-*.woff2", async (route) => {
		const weight =
			/visual-font-(\d+)/.exec(route.request().url())?.[1] || "400";
		await route.fulfill({
			contentType: "font/woff2",
			body: await readFile(
				resolve(
					__dirname,
					`../../node_modules/@fontsource/noto-sans/files/noto-sans-latin-${weight}-normal.woff2`,
				),
			),
		});
	});
	await page.route("**/rpc/office.v1.OfficeService/*", async (route) => {
		if (route.request().url().endsWith("/ListFiles")) {
			const request = route.request().postDataJSON();
			const files = [
				{
					id: "visual-sample-image",
					name: "Sample launch artwork.png",
					module: "projects",
					recordId: project.id,
					contentType: "image/png",
					sizeBytes: String(png.length),
					uploadedBy: user.id,
					createdAt: instant,
					revision: 1,
				},
			];
			await route.fulfill({
				json: {
					files: files.filter(
						(file) =>
							(!request.module || file.module === request.module) &&
							(!request.recordId || file.recordId === request.recordId),
					),
					storageConfigured: true,
				},
			});
		} else {
			const response = await route.fetch();
			await route.fulfill({
				response,
				json: stableTimes(await response.json()),
			});
		}
	});
	await page.route("**/api/files/visual-sample-image/**", (route) =>
		route.fulfill({ contentType: "image/png", body: png }),
	);
	await page.addInitScript(
		({ token, theme }) => {
			sessionStorage.setItem("office-office-session", token);
			localStorage.setItem("office-office-theme", theme);
		},
		{ token, theme },
	);

	await page.goto(`/projects?sourceKind=project&sourceId=${project.id}`);
	await expect(
		page.getByRole("button", { name: `Open task: ${task.title}`, exact: true }),
	).toBeVisible();
	const mobile = testInfo.project.name.endsWith("mobile");
	if (mobile) await page.locator('label[for="office-drawer"]').first().click();
	for (const name of [
		"Overview",
		"Team",
		"Customers",
		"Files",
		"Reports",
		"Settings",
	]) {
		await expect(
			page.getByRole("button", { name, exact: true }).locator("svg.lucide"),
		).toHaveCount(1);
	}
	if (mobile) await page.getByRole("button", { name: /^Projects/ }).click();
	await ready(page);
	await expect(
		page.getByRole("region", { name: "Sample launch workspace", exact: true }),
	).toHaveScreenshot("board.png", {
		stylePath: resolve(__dirname, "component-screenshot.css"),
	});
	await page
		.getByRole("button", { name: `Open task: ${task.title}`, exact: true })
		.click();
	await expect(
		page
			.getByRole("dialog")
			.getByText(
				"The sample research draft is ready. Please check the sources and assumptions.",
				{ exact: true },
			),
	).toBeVisible();
	await ready(page);
	await expect(page).toHaveScreenshot("task-discussion.png");
	const composer = page.locator(".task-comment-composer");
	await composer
		.getByLabel("Add a comment", { exact: true })
		.fill("Please review @Sample");
	await composer.getByRole("option").filter({ hasText: agent.name }).click();
	await composer
		.getByRole("button", { name: "Add response request", exact: true })
		.click();
	await composer
		.getByRole("combobox", {
			name: "Find teammate to request a response",
			exact: true,
		})
		.fill(agent.name);
	await composer.getByRole("option").filter({ hasText: agent.name }).click();
	await composer
		.getByRole("button", { name: "Add Mention / FYI", exact: true })
		.click();
	await composer
		.getByRole("combobox", { name: "Find teammate to mention", exact: true })
		.fill(user.name);
	await composer.getByRole("option").filter({ hasText: user.email }).click();
	await ready(page);
	await expect(composer).toHaveScreenshot("conversation-composer.png", {
		stylePath: resolve(__dirname, "component-screenshot.css"),
	});

	await page.goto("/team");
	await page
		.getByRole("row")
		.filter({ hasText: "Sample researcher" })
		.getByRole("button", { name: "Edit", exact: true })
		.click();
	await expect(
		page
			.getByRole("dialog")
			.getByRole("button", { name: "Save changes", exact: true }),
	).toBeInViewport();
	await ready(page);
	await expect(page).toHaveScreenshot("member-editor.png");

	await page.goto(`/reports?sourceKind=report&sourceId=${report.id}`);
	await expect(
		page
			.getByRole("region", { name: "Report review", exact: true })
			.getByText("pending", { exact: true }),
	).toBeVisible();
	await ready(page);
	await expect(page.locator(".report-reader")).toHaveScreenshot(
		"report-review.png",
		{ stylePath: resolve(__dirname, "component-screenshot.css") },
	);

	await page.goto("/files");
	await page.getByRole("tab", { name: "Gallery", exact: true }).click();
	await expect(
		page
			.getByRole("region", { name: "Image gallery" })
			.getByText("Sample launch artwork.png", { exact: true }),
	).toBeVisible();
	await expect(page.locator('img[src^="blob:"]')).toHaveCount(1);
	await page
		.locator('img[src^="blob:"]')
		.evaluateAll(async (images) =>
			Promise.all(images.map((image) => (image as HTMLImageElement).decode())),
		);
	await ready(page);
	// Capture the gallery itself so automatic scrolling and page chrome cannot
	// shift the mobile viewport while fonts and thumbnails settle.
	await expect(
		page.getByRole("region", { name: "Image gallery" }),
	).toHaveScreenshot("gallery.png", {
		stylePath: resolve(__dirname, "component-screenshot.css"),
	});

	await page.goto("/notifications");
	await page.getByRole("button", { name: /Notifications, 3 unread/ }).click();
	const panel = page.getByRole("dialog", { name: "Office notifications" });
	await expect(
		panel.getByText("Sample: choose the next research question", {
			exact: true,
		}),
	).toBeVisible();
	await expect(panel.getByText("Report saved", { exact: true })).toBeVisible();
	await ready(page);
	await expect(page).toHaveScreenshot("notification-panel.png");
	await expect
		.poll(() =>
			page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth,
			),
		)
		.toBeTruthy();
});

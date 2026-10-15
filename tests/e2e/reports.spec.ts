import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function openReports(page: Page, url: string, token: string) {
	await page.addInitScript(
		(value) => sessionStorage.setItem("office-office-session", value),
		token,
	);
	await page.goto(url);
	await page.getByRole("button", { name: "Reports", exact: true }).click();
}

test("research creation, editing and recurring editions retain sources and render HTML safely", async ({
	page,
	office,
}) => {
	const { token } = await office.bootstrap(false);
	await openReports(page, office.url, token);
	await page.getByRole("button", { name: /New report/ }).click();
	const editor = page.getByRole("form", { name: "Report editor", exact: true });
	await editor
		.getByLabel("Report title", { exact: true })
		.fill("Browser competitor review");
	await editor.getByLabel("Topic", { exact: true }).fill("Competitor research");
	await editor.getByLabel("Reporting period", { exact: true }).fill("2026-W42");
	await editor
		.getByLabel("Report type", { exact: true })
		.selectOption("competitor_review");
	await editor.getByLabel("Status", { exact: true }).selectOption("published");
	await editor
		.getByLabel("Short summary", { exact: true })
		.fill("Research from explicit browser input.");
	await editor
		.getByLabel("Report content", { exact: true })
		.fill(
			"# Findings\n\n<script>window.reportExecuted = true</script>\n\n[unsafe](javascript:alert(1))\n\n[Reference](https://example.test/reference)",
		);
	await editor
		.getByLabel("Source title", { exact: true })
		.fill("Research source");
	await editor
		.getByLabel("Source URL", { exact: true })
		.fill("https://example.test/research");
	await editor.getByRole("button", { name: "Add source", exact: true }).click();
	await editor
		.getByRole("button", { name: "Save report", exact: true })
		.click();
	await expect(editor).not.toBeVisible();
	await expect(
		page.getByRole("heading", {
			name: "Browser competitor review",
			exact: true,
		}),
	).toBeVisible();
	await expect(
		page.getByText("<script>window.reportExecuted = true</script>", {
			exact: true,
		}),
	).toBeVisible();
	await expect(
		page.getByRole("link", { name: "unsafe", exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByRole("link", { name: "Reference", exact: true }),
	).toHaveAttribute("href", "https://example.test/reference");
	await expect(
		page.getByRole("link", { name: "Research source", exact: true }),
	).toHaveAttribute("href", "https://example.test/research");
	expect(
		await page.evaluate(() => Reflect.get(window, "reportExecuted")),
	).toBeUndefined();
	await page.getByRole("button", { name: "Edit report", exact: true }).click();
	await editor
		.getByLabel("Short summary", { exact: true })
		.fill("Reviewed first edition.");
	await editor
		.getByRole("button", { name: "Save report", exact: true })
		.click();
	await expect(editor).not.toBeVisible();
	await expect(
		page.getByText("Reviewed first edition.", { exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: "New edition", exact: true }).click();
	await editor
		.getByLabel("Report title", { exact: true })
		.fill("Browser competitor review next edition");
	await expect(editor.getByLabel("Topic", { exact: true })).toHaveValue(
		"Competitor research",
	);
	await editor.getByLabel("Reporting period", { exact: true }).fill("2026-W43");
	await editor
		.getByLabel("Report content", { exact: true })
		.fill("New observations for the following week.");
	await editor
		.getByRole("button", { name: "Save report", exact: true })
		.click();
	await expect(editor).not.toBeVisible();
	await page.getByLabel("Search reports", { exact: true }).fill("2026-W42");
	await expect(page.locator(".report-list-item")).toHaveCount(1);
	await page.getByRole("button", { name: /Browser competitor review/ }).click();
	await expect(
		page.getByRole("heading", {
			name: "Browser competitor review",
			exact: true,
		}),
	).toBeVisible();
	const results = await (
		await office.rpc("ListReports", { query: "Competitor research" }, token)
	).json();
	expect(results.reports).toHaveLength(2);
	expect(
		new Set(results.reports.map((report: { id: string }) => report.id)).size,
	).toBe(2);
	const original = results.reports.find(
		(report: { period: string }) => report.period === "2026-W42",
	);
	const detail = await (
		await office.rpc("GetReport", { id: original.id }, token)
	).json();
	expect(detail.report.summary).toBe("Reviewed first edition.");
	expect(detail.report.revision).toBe(2);
	expect(detail.report.sources).toEqual([
		{ title: "Research source", url: "https://example.test/research" },
	]);
});

test("stale research saves fail through RPC and UI while retaining the local draft", async ({
	page,
	office,
}) => {
	const { token } = await office.bootstrap();
	const list = await (
		await office.rpc("ListReports", { query: "Sample research brief" }, token)
	).json();
	const original = (
		await (
			await office.rpc("GetReport", { id: list.reports[0].id }, token)
		).json()
	).report;
	await openReports(page, office.url, token);
	await page.getByRole("button", { name: /Sample research brief/ }).click();
	await page.getByRole("button", { name: "Edit report", exact: true }).click();
	const editor = page.getByRole("form", { name: "Report editor", exact: true });
	await editor
		.getByLabel("Report content", { exact: true })
		.fill("Unsaved local research draft");
	const winner = await office.rpc(
		"SaveReport",
		{
			report: { ...original, body: "Latest research from another writer" },
			expectedRevision: original.revision,
		},
		token,
	);
	expect(winner.ok()).toBeTruthy();
	const denied = await office.rpc(
		"SaveReport",
		{
			report: { ...original, body: "Stale API content" },
			expectedRevision: original.revision,
		},
		token,
	);
	expect(denied.status()).toBe(409);
	expect((await denied.json()).code).toBe("aborted");
	await editor
		.getByRole("button", { name: "Save report", exact: true })
		.click();
	await expect(editor.getByRole("alert")).toContainText(
		"Your draft is still here",
	);
	await expect(
		editor.getByLabel("Report content", { exact: true }),
	).toHaveValue("Unsaved local research draft");
	const current = await (
		await office.rpc("GetReport", { id: original.id }, token)
	).json();
	expect(current.report.body).toBe("Latest research from another writer");
	expect(current.report.revision).toBe(original.revision + 1);
	await editor
		.getByRole("button", {
			name: "Reload report and discard draft",
			exact: true,
		})
		.click();
	await expect(editor).not.toBeVisible();
	await expect(
		page.getByText("Latest research from another writer", { exact: true }),
	).toBeVisible();
});

test("viewer cannot edit reports and a role change grants report writing immediately", async ({
	page,
	office,
}) => {
	const { token } = await office.bootstrap();
	const reports = await (await office.rpc("ListReports", {}, token)).json();
	const report = (
		await (
			await office.rpc("GetReport", { id: reports.reports[0].id }, token)
		).json()
	).report;
	const memberResponse = await office.rpc(
		"SaveMember",
		{
			member: {
				name: "Report Viewer",
				email: "report-viewer@example.test",
				role: "viewer",
				status: "active",
			},
			password: "viewer-password-123",
		},
		token,
	);
	expect(memberResponse.ok()).toBeTruthy();
	const member = (await memberResponse.json()).member;
	const viewer = await (
		await office.rpc("Login", {
			email: member.email,
			password: "viewer-password-123",
		})
	).json();
	await openReports(page, office.url, viewer.token);
	await page.getByRole("button", { name: "Roles & permissions" }).click();
	const viewerRole = page
		.getByRole("table", { name: "Permissions assigned to each fixed role" })
		.getByRole("row")
		.filter({ has: page.getByRole("rowheader", { name: "Viewer" }) });
	await expect(
		viewerRole.getByText("reports:read", { exact: true }),
	).toBeVisible();
	await expect(
		viewerRole.getByText("reports:write", { exact: true }),
	).toHaveCount(0);
	await page.getByRole("button", { name: "Reports", exact: true }).click();
	await page.getByRole("button", { name: new RegExp(report.title) }).click();
	await expect(
		page.getByRole("heading", { name: report.title, exact: true, level: 3 }),
	).toBeVisible();
	await expect(page.getByRole("button", { name: /New report/ })).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Edit report", exact: true }),
	).toHaveCount(0);
	const write = await office.rpc(
		"SaveReport",
		{
			report: { ...report, body: "Forbidden" },
			expectedRevision: report.revision,
		},
		viewer.token,
	);
	expect(write.status()).toBe(403);
	expect((await write.json()).code).toBe("permission_denied");
	expect(
		(
			await office.rpc(
				"SaveMember",
				{ member: { ...member, role: "member" } },
				token,
			)
		).ok(),
	).toBeTruthy();
	await page.reload();
	await expect(page.getByRole("button", { name: /^Projects/ })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Reports", exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: "Reports", exact: true }).click();
	await expect(page.getByRole("button", { name: /New report/ })).toBeVisible();
	const allowed = await office.rpc(
		"SaveReport",
		{
			report: { ...report, body: "Member can update reports" },
			expectedRevision: report.revision,
		},
		viewer.token,
	);
	expect(allowed.ok()).toBeTruthy();
});

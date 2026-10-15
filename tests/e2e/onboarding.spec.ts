import { expect, test } from "./fixtures";

test("bootstrap, onboard a viewer, and work with RPC demo records", async ({
	page,
}) => {
	test.setTimeout(90_000);
	await page.goto("/");
	await expect(
		page.getByRole("heading", { name: "Create your office" }),
	).toBeVisible();
	await page
		.getByRole("checkbox", {
			name: "Start with sample office data",
			exact: true,
		})
		.check();
	await page.getByLabel("Your name", { exact: true }).fill("Preview Admin");
	await page
		.getByLabel("Workspace name", { exact: true })
		.fill("Browser smoke office");
	await page
		.getByLabel("Email address", { exact: true })
		.fill("admin@example.test");
	await page
		.getByLabel("Password", { exact: true })
		.fill("demo-password-only-123");
	await page
		.getByLabel("Confirm password", { exact: true })
		.fill("demo-password-only-123");
	await page
		.getByRole("button", { name: "Create workspace", exact: true })
		.click();
	await expect(
		page.getByText(/Sample starter data loaded/).first(),
	).toBeVisible();

	await page.getByRole("button", { name: "Team", exact: true }).click();
	await page.getByRole("button", { name: /Add member/ }).click();
	let dialog = page.getByRole("dialog");
	await dialog.getByLabel("Name", { exact: true }).fill("Preview Viewer");
	await dialog.getByLabel("Email", { exact: true }).fill("viewer@example.test");
	await dialog.getByLabel("Job title", { exact: true }).fill("Reviewer");
	const role = dialog.getByLabel("Role", { exact: true });
	await expect(role).toBeVisible();
	await expect(role).toHaveAccessibleName("Role");
	await role.selectOption("viewer");
	await expect(role).toHaveValue("viewer");
	await expect(
		dialog.getByLabel("Status", { exact: true }),
	).toHaveAccessibleName("Status");
	await dialog.getByLabel(/Temporary password/).fill("demo-viewer-only-123");
	await dialog
		.getByRole("button", { name: "Add team member", exact: true })
		.click();
	await expect(dialog).not.toBeVisible();
	await expect(page.getByText("Preview Viewer", { exact: true })).toBeVisible();

	await page.getByRole("button", { name: "Customers", exact: true }).click();
	await page.getByRole("button", { name: /Add customer/ }).click();
	dialog = page.getByRole("dialog");
	await dialog
		.getByLabel("Contact name", { exact: true })
		.fill("Sample Contact");
	await dialog
		.getByLabel("Company", { exact: true })
		.fill("Example Browser Studio");
	await dialog
		.getByLabel("Email", { exact: true })
		.fill("contact@example.test");
	await dialog
		.getByRole("button", { name: "Add customer", exact: true })
		.click();
	await expect(dialog).not.toBeVisible();
	await expect(
		page.getByText("Example Browser Studio", { exact: true }),
	).toBeVisible();

	await page.getByRole("button", { name: /^Projects/ }).click();
	await page.getByRole("button", { name: /New project/ }).click();
	dialog = page.getByRole("dialog");
	await dialog
		.getByLabel("Project name", { exact: true })
		.fill("Browser launch preview");
	await dialog
		.getByLabel("Customer", { exact: true })
		.selectOption({ label: "Example Browser Studio" });
	await dialog.getByLabel("Status", { exact: true }).selectOption("on_hold");
	await dialog
		.getByRole("button", { name: "Add project", exact: true })
		.click();
	await expect(dialog).not.toBeVisible();

	// Each project owns its boards; exercise the task lifecycle through RPC-backed UI.
	await page.getByRole("button", { name: /Browser launch preview/ }).click();
	await page
		.getByRole("button", { name: /Add task/ })
		.first()
		.click();
	dialog = page.getByRole("dialog");
	await dialog
		.getByLabel("Task title", { exact: true })
		.fill("Prepare launch checklist");
	await expect(
		dialog.getByLabel("Priority", { exact: true }),
	).toHaveAccessibleName("Priority");
	await expect(
		dialog.getByLabel("Column", { exact: true }),
	).toHaveAccessibleName("Column");
	await dialog.getByLabel("Priority", { exact: true }).selectOption("high");
	await dialog
		.getByRole("button", { name: "Create task", exact: true })
		.click();
	await expect(dialog).not.toBeVisible();
	await expect(
		page.getByText("Prepare launch checklist", { exact: true }),
	).toBeVisible();
	await page
		.getByLabel("Move Prepare launch checklist to column", { exact: true })
		.selectOption("Done");
	await expect(
		page.getByLabel("Move Prepare launch checklist to column", { exact: true }),
	).toHaveValue("Done");
	// Comments and activity belong to the task, independently of its current column.
	await page
		.getByRole("button", {
			name: "Open task: Prepare launch checklist",
			exact: true,
		})
		.click();
	dialog = page.getByRole("dialog");
	await expect(
		dialog.getByRole("heading", {
			name: "Prepare launch checklist",
			exact: true,
		}),
	).toBeVisible();
	await dialog
		.getByLabel("Add a comment", { exact: true })
		.fill("Browser discussion: ready for review.");
	await dialog
		.getByRole("button", { name: "Post comment", exact: true })
		.click();
	await expect(
		dialog.getByText("Browser discussion: ready for review.", { exact: true }),
	).toBeVisible();
	await page.screenshot({
		path: "test-results/task-details-desktop.png",
		fullPage: true,
	});
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(dialog).toBeVisible();
	expect(
		await page.evaluate(() => document.documentElement.scrollWidth),
	).toBeLessThanOrEqual(390);
	await page.screenshot({
		path: "test-results/task-details-mobile.png",
		fullPage: true,
	});
	await page.setViewportSize({ width: 1440, height: 1000 });
	await dialog
		.getByRole("button", { name: "Edit comment", exact: true })
		.click();
	await dialog
		.getByRole("textbox", { name: "Edit comment", exact: true })
		.fill("Browser discussion: reviewed and ready.");
	await dialog
		.getByRole("button", { name: "Save comment", exact: true })
		.click();
	await expect(
		dialog.getByText("Browser discussion: reviewed and ready.", {
			exact: true,
		}),
	).toBeVisible();
	await dialog
		.getByRole("button", { name: "Delete comment", exact: true })
		.click();
	await dialog
		.getByRole("button", { name: "Delete comment", exact: true })
		.click();
	await expect(
		dialog.getByText("Comment deleted", { exact: true }),
	).toBeVisible();
	await dialog.getByRole("tab", { name: "Activity", exact: true }).click();
	await expect(dialog.getByText(/moved.*Done/i)).toBeVisible();
	await dialog
		.getByRole("button", { name: "Close task details", exact: true })
		.first()
		.click();
	await expect(dialog).not.toBeVisible();
	await page.getByRole("button", { name: /New board/ }).click();
	await page.getByLabel("Board name", { exact: true }).fill("Launch follow-up");
	await page.getByRole("button", { name: "Create board", exact: true }).click();
	await expect(
		page.getByRole("tab", { name: /Launch follow-up/ }),
	).toBeVisible();

	await page.getByRole("button", { name: "Reports", exact: true }).click();
	await page.getByRole("button", { name: /New report/ }).click();
	const reportEditor = page.getByRole("form", {
		name: "Report editor",
		exact: true,
	});
	await reportEditor
		.getByLabel("Report title", { exact: true })
		.fill("Browser competitor review");
	await reportEditor
		.getByLabel("Topic", { exact: true })
		.fill("Competitor research");
	await reportEditor
		.getByLabel("Reporting period", { exact: true })
		.fill("2026-W42");
	await reportEditor
		.getByLabel("Report type", { exact: true })
		.selectOption("competitor_review");
	await reportEditor
		.getByLabel("Status", { exact: true })
		.selectOption("published");
	await reportEditor
		.getByLabel("Project", { exact: true })
		.selectOption({ label: "Browser launch preview" });
	await reportEditor
		.getByLabel("Task", { exact: true })
		.selectOption({ label: "Prepare launch checklist" });
	await reportEditor
		.getByLabel("Short summary", { exact: true })
		.fill("Sample research summary for browser validation.");
	await reportEditor
		.getByLabel("Report content", { exact: true })
		.fill(
			"# Findings\n\nSample findings for the browser test.\n\n<script>window.reportExecuted = true</script>",
		);
	await reportEditor
		.getByLabel("Source title", { exact: true })
		.fill("Illustrative test source");
	await reportEditor
		.getByLabel("Source URL", { exact: true })
		.fill("https://example.test/research");
	await reportEditor
		.getByRole("button", { name: "Add source", exact: true })
		.click();
	await reportEditor
		.getByRole("button", { name: "Save report", exact: true })
		.click();
	await expect(reportEditor).not.toBeVisible();
	await expect(
		page.getByRole("heading", {
			name: "Browser competitor review",
			exact: true,
		}),
	).toBeVisible();
	await expect(
		page.getByRole("link", { name: "Illustrative test source", exact: true }),
	).toHaveAttribute("href", "https://example.test/research");
	await expect(
		page.getByText("<script>window.reportExecuted = true</script>", {
			exact: true,
		}),
	).toBeVisible();
	expect(
		await page.evaluate(() => Reflect.get(window, "reportExecuted")),
	).toBeUndefined();
	await page.screenshot({
		path: "test-results/reports-desktop.png",
		fullPage: true,
	});
	await page.getByRole("button", { name: "Edit report", exact: true }).click();
	await reportEditor
		.getByLabel("Short summary", { exact: true })
		.fill("Updated sample findings.");
	await reportEditor
		.getByRole("button", { name: "Save report", exact: true })
		.click();
	await expect(reportEditor).not.toBeVisible();
	await expect(
		page.getByText("Updated sample findings.", { exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: "New edition", exact: true }).click();
	await reportEditor
		.getByLabel("Report title", { exact: true })
		.fill("Browser competitor review — next edition");
	await reportEditor
		.getByLabel("Reporting period", { exact: true })
		.fill("2026-W43");
	await reportEditor
		.getByLabel("Report content", { exact: true })
		.fill("New sample findings for a later period.");
	await reportEditor
		.getByRole("button", { name: "Save report", exact: true })
		.click();
	await expect(reportEditor).not.toBeVisible();
	await expect(
		page.getByRole("heading", {
			name: "Browser competitor review — next edition",
			exact: true,
		}),
	).toBeVisible();
	await page.getByLabel("Search reports", { exact: true }).fill("2026-W42");
	await expect(
		page.getByRole("button", { name: /Browser competitor review/ }),
	).toHaveCount(1);
	await page.getByRole("button", { name: /Browser competitor review/ }).click();
	await expect(
		page.getByRole("heading", {
			name: "Browser competitor review",
			exact: true,
		}),
	).toBeVisible();
	await page.getByLabel("Search reports", { exact: true }).fill("");

	await page.getByRole("button", { name: "Social queue", exact: true }).click();
	await page.getByRole("button", { name: /Compose post/ }).click();
	dialog = page.getByRole("dialog");
	await dialog
		.getByLabel("Post content", { exact: true })
		.fill("Sample post from browser smoke test. No publishing.");
	await dialog
		.getByLabel("Status", { exact: true })
		.selectOption("needs_review");
	await dialog.getByRole("button", { name: "Add post", exact: true }).click();
	await expect(dialog).not.toBeVisible();
	await expect(
		page.getByText("Sample post from browser smoke test. No publishing.", {
			exact: true,
		}),
	).toBeVisible();

	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(
		page.getByLabel("Color theme", { exact: true }).locator("option"),
	).toHaveCount(35);
	await page.getByLabel("Color theme", { exact: true }).selectOption("nord");
	await expect(page.locator("html")).toHaveAttribute("data-theme", "nord");
	await page
		.getByLabel("Key name", { exact: true })
		.fill("Browser smoke agent");
	await page.getByRole("button", { name: "Create key", exact: true }).click();
	dialog = page.getByRole("dialog");
	await expect(
		dialog.getByRole("heading", { name: "Copy your new key" }),
	).toBeVisible();
	await dialog.getByRole("button", { name: "Done", exact: true }).click();
	await expect(dialog).not.toBeVisible();
	await expect(
		page.getByText("Browser smoke agent", { exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: "Revoke", exact: true }).click();
	await expect(page.getByText("Revoked", { exact: true })).toBeVisible();
	await page.screenshot({
		path: "test-results/office-desktop.png",
		fullPage: true,
	});
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(page.locator("body")).toBeVisible();
	expect(
		await page.evaluate(() => document.documentElement.scrollWidth),
	).toBeLessThanOrEqual(390);
	await page.screenshot({
		path: "test-results/office-mobile.png",
		fullPage: true,
	});
	await page.setViewportSize({ width: 1440, height: 1000 });

	await page.getByRole("button", { name: "Sign out", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Sign in", exact: true }),
	).toBeVisible();
	await page
		.getByLabel("Email address", { exact: true })
		.fill("viewer@example.test");
	await page
		.getByLabel("Password", { exact: true })
		.fill("demo-viewer-only-123");
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await page.getByRole("button", { name: "Customers", exact: true }).click();
	await expect(
		page.getByText("Example Browser Studio", { exact: true }),
	).toBeVisible();
	await expect(page.getByRole("button", { name: /Add customer/ })).toHaveCount(
		0,
	);
	await page.getByRole("button", { name: /^Projects/ }).click();
	await page.getByRole("button", { name: /Browser launch preview/ }).click();
	await page
		.getByRole("button", {
			name: "Open task: Prepare launch checklist",
			exact: true,
		})
		.click();
	dialog = page.getByRole("dialog");
	await expect(
		dialog.getByText("Comment deleted", { exact: true }),
	).toBeVisible();
	await expect(dialog.getByLabel("Add a comment", { exact: true })).toHaveCount(
		0,
	);
	await expect(
		dialog.getByRole("button", { name: "Edit task", exact: true }),
	).toHaveCount(0);
	await dialog
		.getByRole("button", { name: "Close task details", exact: true })
		.first()
		.click();
	await page.getByRole("button", { name: "Reports", exact: true }).click();
	await expect(page.getByRole("button", { name: /New report/ })).toHaveCount(0);
	await page
		.getByRole("button", { name: /Browser competitor review.*2026-W42/ })
		.click();
	await expect(
		page.getByRole("heading", {
			name: "Browser competitor review",
			exact: true,
		}),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Edit report", exact: true }),
	).toHaveCount(0);
});

test("registration without starter data creates an empty durable office", async ({
	page,
	office,
}) => {
	await page.goto("/");
	await expect(
		page.getByRole("heading", { name: "Create your office", exact: true }),
	).toBeVisible();
	const samples = page.getByRole("checkbox", {
		name: "Start with sample office data",
		exact: true,
	});
	await expect(samples).not.toBeChecked();
	await page
		.getByLabel("Your name", { exact: true })
		.fill("Empty Office Admin");
	await page
		.getByLabel("Workspace name", { exact: true })
		.fill("Empty browser office");
	await page
		.getByLabel("Email address", { exact: true })
		.fill("empty-admin@example.test");
	await page
		.getByLabel("Password", { exact: true })
		.fill("empty-office-password-123");
	await page
		.getByLabel("Confirm password", { exact: true })
		.fill("empty-office-password-123");
	await page
		.getByRole("button", { name: "Create workspace", exact: true })
		.click();
	await expect(page.getByRole("button", { name: /^Projects/ })).toBeVisible();
	await expect(page.getByText(/Sample starter data loaded/)).toHaveCount(0);
	const token = await page.evaluate(() =>
		sessionStorage.getItem("office-office-session"),
	);
	expect(token).toBeTruthy();
	const response = await office.rpc("GetWorkspace", {}, token ?? undefined);
	expect(response.ok()).toBeTruthy();
	const workspace = await response.json();
	expect(workspace.persistentStorage).toBe(true);
	expect(workspace.demoMode ?? false).toBe(false);
	expect(workspace.members).toHaveLength(1);
	expect(workspace.members[0]).toMatchObject({
		name: "Empty Office Admin",
		role: "admin",
	});
	for (const collection of [
		"customers",
		"projects",
		"boards",
		"tasks",
		"connections",
		"posts",
	]) {
		expect(workspace[collection] ?? [], collection).toEqual([]);
	}
	const reports = await office.rpc("ListReports", {}, token ?? undefined);
	expect(reports.ok()).toBeTruthy();
	expect((await reports.json()).reports ?? []).toEqual([]);
	await page.getByRole("button", { name: /^Projects/ }).click();
	await expect(page.getByRole("button", { name: /^Open task:/ })).toHaveCount(
		0,
	);
});

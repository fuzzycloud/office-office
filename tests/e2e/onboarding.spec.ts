import { expect, test } from "@playwright/test";

test("bootstrap, onboard a viewer, and work with RPC demo records", async ({
	page,
}) => {
	test.setTimeout(90_000);
	await page.goto("/");
	await expect(
		page.getByRole("heading", { name: "Create your office" }),
	).toBeVisible();
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
	await expect(page.getByText(/Demo workspace/).first()).toBeVisible();

	await page.getByRole("button", { name: "Team", exact: true }).click();
	await page.getByRole("button", { name: /Add member/ }).click();
	let dialog = page.getByRole("dialog");
	await dialog.getByLabel("Name", { exact: true }).fill("Preview Viewer");
	await dialog.getByLabel("Email", { exact: true }).fill("viewer@example.test");
	await dialog.getByLabel("Job title", { exact: true }).fill("Reviewer");
	await dialog.getByLabel("Role", { exact: true }).selectOption("viewer");
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
	await page.getByRole("button", { name: /Add task/ }).first().click();
	dialog = page.getByRole("dialog");
	await dialog.getByLabel("Task title", { exact: true }).fill("Prepare launch checklist");
	await dialog.getByLabel("Priority", { exact: true }).selectOption("high");
	await dialog.getByRole("button", { name: "Create task", exact: true }).click();
	await expect(dialog).not.toBeVisible();
	await expect(page.getByText("Prepare launch checklist", { exact: true })).toBeVisible();
	await page.getByLabel("Move Prepare launch checklist to column", { exact: true }).selectOption("Done");
	await expect(page.getByLabel("Move Prepare launch checklist to column", { exact: true })).toHaveValue("Done");
	await page.getByRole("button", { name: /New board/ }).click();
	await page.getByLabel("Board name", { exact: true }).fill("Launch follow-up");
	await page.getByRole("button", { name: "Create board", exact: true }).click();
	await expect(page.getByRole("tab", { name: /Launch follow-up/ })).toBeVisible();

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
		page.getByLabel("Color theme", { exact: false }).locator("option"),
	).toHaveCount(35);
	await page.getByLabel("Color theme", { exact: false }).selectOption("nord");
	await expect(page.locator("html")).toHaveAttribute("data-theme", "nord");
	await page.getByLabel("Key name", { exact: true }).fill("Browser smoke agent");
	await page.getByRole("button", { name: "Create key", exact: true }).click();
	dialog = page.getByRole("dialog");
	await expect(dialog.getByRole("heading", { name: "Copy your new key" })).toBeVisible();
	await dialog.getByRole("button", { name: "Done", exact: true }).click();
	await expect(dialog).not.toBeVisible();
	await expect(page.getByText("Browser smoke agent", { exact: true })).toBeVisible();
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
});

import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function navigateMobile(page: Page, name: RegExp | string) {
	await page
		.locator('label[for="office-drawer"][aria-label="Open navigation"]')
		.click();
	await page
		.getByRole("button", { name, exact: typeof name === "string" })
		.click();
	await expect(page.locator("#office-drawer")).not.toBeChecked();
}

async function expectNoPageOverflow(page: Page) {
	const { width, viewport } = await page.evaluate(() => ({
		width: document.documentElement.scrollWidth,
		viewport: document.documentElement.clientWidth,
	}));

	expect(
		width,
		"The page must fit the viewport without horizontal scrolling",
	).toBeLessThanOrEqual(viewport);
}

test("390px navigation, board and discussion support keyboard closing and restore focus", async ({
	page,
	office,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const { token } = await office.bootstrap();
	await page.addInitScript(
		(value) => sessionStorage.setItem("office-office-session", value),
		token,
	);
	await page.goto("/");
	await expect(
		page.getByRole("heading", {
			name: "Your office, at a glance",
			exact: true,
		}),
	).toBeVisible();
	await navigateMobile(page, /^Projects/);
	await page.getByRole("button", { name: /Sample launch/ }).click();
	const opener = page.getByRole("button", {
		name: "Open task: Sample task — plan launch",
		exact: true,
	});
	await opener.focus();
	await page.keyboard.press("Enter");
	const dialog = page.getByRole("dialog");
	await expect(
		dialog.getByRole("heading", {
			name: "Sample task — plan launch",
			exact: true,
		}),
	).toBeVisible();
	await expect(
		dialog.getByRole("tab", { name: "Comments (3)", exact: true }),
	).toBeVisible();
	await expectNoPageOverflow(page);
	const draft = "A comment written from the narrow mobile discussion.";
	await dialog.getByLabel("Add a comment", { exact: true }).fill(draft);
	await dialog
		.getByRole("button", { name: "Post comment", exact: true })
		.click();
	await expect(dialog.getByText(draft, { exact: true })).toBeVisible();
	await dialog.getByRole("tab", { name: "Activity", exact: true }).click();
	await expect(dialog.getByRole("tabpanel")).toContainText(/comment/i);
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expect(opener).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(
		dialog.getByRole("tab", { name: "Comments (4)", exact: true }),
	).toBeVisible();
	await expect(dialog.getByText(draft, { exact: true })).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(opener).toBeFocused();
	await expectNoPageOverflow(page);
});

test("browser theme survives reload and settings stay within mobile and desktop viewports", async ({
	page,
	office,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const { token } = await office.bootstrap();
	await page.addInitScript(
		(value) => sessionStorage.setItem("office-office-session", value),
		token,
	);
	await page.goto("/");
	await navigateMobile(page, "Settings");
	await page.getByLabel("Color theme", { exact: true }).selectOption("dark");
	await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
	await expectNoPageOverflow(page);
	await page.reload();
	await expect(page).toHaveURL(`${office.url}/settings`);
	await expect(
		page.getByRole("heading", { name: "Settings", level: 1, exact: true }),
	).toBeVisible();
	await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
	await expect(page.getByLabel("Color theme", { exact: true })).toHaveValue(
		"dark",
	);
	await expectNoPageOverflow(page);
	await page.setViewportSize({ width: 1440, height: 1000 });
	await expect(page.getByLabel("Color theme", { exact: true })).toBeVisible();
	await expectNoPageOverflow(page);
	await page.getByLabel("Color theme", { exact: true }).selectOption("light");
	await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
	await page.reload();
	await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

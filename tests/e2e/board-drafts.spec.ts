import { expect, test } from "./fixtures";

test("changing project status filters discards the previous project's board draft", async ({
	page,
	office,
}) => {
	const { token } = await office.bootstrap();
	const workspace = await (await office.rpc("GetWorkspace", {}, token)).json();
	const customerProject = workspace.projects.find((item: { name: string }) =>
		item.name.includes("customer discovery"),
	);
	expect(customerProject).toBeTruthy();
	expect(
		(
			await office.rpc(
				"SaveProject",
				{
					project: { ...customerProject, status: "on_hold" },
				},
				token,
			)
		).ok(),
	).toBeTruthy();
	await page.addInitScript(
		(value) => sessionStorage.setItem("office-office-session", value),
		token,
	);
	await page.goto("/projects");
	await page.getByRole("button", { name: /Sample launch/ }).click();
	await page.getByRole("button", { name: /New board/ }).click();
	await page
		.getByLabel("Board name", { exact: true })
		.fill("Launch-only draft");
	await page
		.getByRole("textbox", { name: "Columns, one per line", exact: true })
		.fill("Launch backlog\nLaunch review");
	await page.getByRole("tab", { name: "On hold", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: customerProject.name, exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Create board", exact: true }),
	).toHaveCount(0);
	await page.getByRole("button", { name: /New board/ }).click();
	await expect(page.getByLabel("Board name", { exact: true })).toHaveValue("");
	await expect(
		page.getByRole("textbox", { name: "Columns, one per line", exact: true }),
	).toHaveValue("Backlog\nIn progress\nReview\nDone");
	await page
		.getByLabel("Board name", { exact: true })
		.fill("Customer-only board");
	await page.getByRole("button", { name: "Create board", exact: true }).click();
	await expect(
		page.getByRole("tab", { name: /Customer-only board/ }),
	).toBeVisible();
	const saved = await (await office.rpc("GetWorkspace", {}, token)).json();
	expect(
		saved.boards.find(
			(item: { name: string }) => item.name === "Launch-only draft",
		),
	).toBeUndefined();
	expect(
		saved.boards.find(
			(item: { name: string }) => item.name === "Customer-only board",
		).projectId,
	).toBe(customerProject.id);
});

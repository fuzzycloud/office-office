import { expect, test } from "./fixtures";

test("a real invalid-session response returns to sign in and a fresh login recovers", async ({
	page,
	office,
}) => {
	await office.bootstrap();
	await page.goto("/");
	await expect(
		page.getByRole("heading", { name: "Sign in", exact: true }),
	).toBeVisible();
	await page.evaluate(() =>
		sessionStorage.setItem("office-office-session", "invalid-e2e-session"),
	);
	const rejected = page.waitForResponse(
		(response) =>
			response.url().endsWith("/office.v1.OfficeService/GetWorkspace") &&
			response.status() === 401,
	);
	await page.reload();
	expect((await (await rejected).json()).code).toBe("unauthenticated");
	await expect(
		page.getByRole("heading", { name: "Sign in", exact: true }),
	).toBeVisible();
	expect(
		await page.evaluate(() => sessionStorage.getItem("office-office-session")),
	).toBeNull();
	await page
		.getByLabel("Email address", { exact: true })
		.fill("admin@example.test");
	await page
		.getByLabel("Password", { exact: true })
		.fill("e2e-admin-password-123");
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(
		page.getByRole("heading", {
			name: "Your office, at a glance",
			exact: true,
		}),
	).toBeVisible();
	const token = await page.evaluate(() =>
		sessionStorage.getItem("office-office-session"),
	);
	expect(token).toBeTruthy();
	expect(token).not.toBe("invalid-e2e-session");
	await page.reload();
	await expect(
		page.getByRole("heading", {
			name: "Your office, at a glance",
			exact: true,
		}),
	).toBeVisible();
});

test("one failed workspace request offers a working retry without losing the session", async ({
	page,
	office,
}) => {
	const { token } = await office.bootstrap();
	await page.addInitScript(
		(value) => sessionStorage.setItem("office-office-session", value),
		token,
	);
	await page.route(
		"**/office.v1.OfficeService/GetWorkspace",
		(route) => route.abort("failed"),
		{ times: 1 },
	);
	await page.goto("/");
	await expect(
		page.getByRole("heading", {
			name: "We couldn’t open the workspace",
			exact: true,
		}),
	).toBeVisible();
	expect(
		await page.evaluate(() => sessionStorage.getItem("office-office-session")),
	).toBe(token);
	await page.getByRole("button", { name: "Try again", exact: true }).click();
	await expect(
		page.getByRole("heading", {
			name: "Your office, at a glance",
			exact: true,
		}),
	).toBeVisible();
	await expect(
		page.getByText("Sample starter data loaded.", { exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Try again", exact: true }),
	).toHaveCount(0);
});

test("a failed comment request preserves the draft and retry commits exactly once", async ({
	page,
	office,
}) => {
	const { token } = await office.bootstrap();
	const workspace = await (await office.rpc("GetWorkspace", {}, token)).json();
	const task = workspace.tasks.find(
		(item: { title: string }) => item.title === "Sample task — plan launch",
	);
	const before = await (
		await office.rpc("ListTaskDiscussion", { taskId: task.id }, token)
	).json();
	await page.addInitScript(
		(value) => sessionStorage.setItem("office-office-session", value),
		token,
	);
	await page.goto("/");
	await page.getByRole("button", { name: /^Projects/ }).click();
	await page.getByRole("button", { name: /Sample launch/ }).click();
	await page
		.getByRole("button", { name: `Open task: ${task.title}`, exact: true })
		.click();
	const dialog = page.getByRole("dialog");
	await expect(
		dialog.getByRole("tab", { name: "Comments (3)", exact: true }),
	).toBeVisible();
	const draft = "Keep this draft through the temporary connection failure.";
	const composer = dialog.getByRole("textbox", {
		name: "Add a comment",
		exact: true,
	});
	await composer.fill(draft);
	let attempts = 0;
	page.on("request", (request) => {
		if (request.url().endsWith("/office.v1.OfficeService/SaveTaskComment"))
			attempts++;
	});
	// Abort before delivery; every successful RPC still reaches the real server.
	await page.route(
		"**/office.v1.OfficeService/SaveTaskComment",
		(route) => route.abort("failed"),
		{ times: 1 },
	);
	await dialog
		.getByRole("button", { name: "Post comment", exact: true })
		.click();
	await expect(dialog.getByRole("alert")).toBeVisible();
	await expect(composer).toHaveValue(draft);
	const failed = await (
		await office.rpc("ListTaskDiscussion", { taskId: task.id }, token)
	).json();
	expect(failed.comments).toEqual(before.comments);
	expect(failed.activity).toEqual(before.activity);
	await dialog
		.getByRole("button", { name: "Post comment", exact: true })
		.click();
	await expect(dialog.getByText(draft, { exact: true })).toBeVisible();
	await expect(composer).toHaveValue("");
	await expect(
		dialog.getByRole("tab", { name: "Comments (4)", exact: true }),
	).toBeVisible();
	expect(attempts).toBe(2);
	const saved = await (
		await office.rpc("ListTaskDiscussion", { taskId: task.id }, token)
	).json();
	expect(saved.comments).toHaveLength(before.comments.length + 1);
	expect(
		saved.comments.filter(
			(comment: { body: string }) => comment.body === draft,
		),
	).toHaveLength(1);
	expect(saved.activity).toHaveLength(before.activity.length + 1);
	await page.reload();
	await page.getByRole("button", { name: /^Projects/ }).click();
	await page.getByRole("button", { name: /Sample launch/ }).click();
	await page
		.getByRole("button", { name: `Open task: ${task.title}`, exact: true })
		.click();
	await expect(
		page.getByRole("dialog").getByText(draft, { exact: true }),
	).toBeVisible();
});

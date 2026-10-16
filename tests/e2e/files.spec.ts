import { readFile } from "node:fs/promises";
import { expect, test } from "./fixtures";

const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=",
	"base64",
);

test("Files has a reloadable URL and explains unconfigured private storage", async ({
	office,
	page,
}) => {
	const { token } = await office.bootstrap(false);
	await page.addInitScript(
		(token) => sessionStorage.setItem("office-office-session", token),
		token,
	);
	await page.goto("/files");
	await expect(
		page.getByRole("heading", { name: "Files", exact: true }),
	).toBeVisible();
	await expect(
		page.getByText(/File storage is not configured yet/),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Upload file", exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByRole("heading", { name: "No files here yet" }),
	).toBeVisible();
	await page.reload();
	await expect(page).toHaveURL(`${office.url}/files`);
	await expect(
		page.getByText(/File storage is not configured yet/),
	).toBeVisible();
});

// These intercepts exercise the browser contract without requiring external S3 in CI.
// Bootstrap, sessions and role policy still use the real isolated office server.
test("Files UI sends authenticated bytes, downloads and deletes; route revisits refresh", async ({
	office,
	page,
}) => {
	const { token, user } = await office.bootstrap(false);
	const created = await office.rpc(
		"SaveMember",
		{
			member: {
				name: "Files Viewer",
				email: "files-viewer@example.test",
				kind: "human",
				role: "viewer",
				status: "active",
			},
			password: "files-viewer-password-123",
		},
		token,
	);
	expect(created.ok()).toBeTruthy();
	const content = "Research notes from browser automation.";
	let files: Array<{
		id: string;
		name: string;
		module: string;
		sizeBytes: string;
		contentType: string;
		uploadedBy: string;
		revision: number;
	}> = [];
	let listRequests = 0;
	await page.route(
		"**/rpc/office.v1.OfficeService/ListFiles",
		async (route) => {
			const headers = await route.request().allHeaders();
			if (headers.authorization)
				expect(headers.authorization).toBe(`Bearer ${token}`);
			else {
				expect(headers.cookie).toContain("office_session=");
				expect(headers["x-office-csrf"]).toBe("1");
			}
			listRequests += 1;
			const { module } = route.request().postDataJSON();
			await route.fulfill({
				json: {
					storageConfigured: true,
					files: files.filter((file) => file.module === module),
				},
			});
		},
	);
	await page.route("**/api/files?*", async (route) => {
		expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
		expect(route.request().method()).toBe("POST");
		expect(route.request().postDataBuffer()?.toString()).toBe(content);
		expect(new URL(route.request().url()).searchParams.get("name")).toBe(
			"research.txt",
		);
		files.push({
			id: "file-browser-contract",
			name: "research.txt",
			module: "projects",
			contentType: "text/plain",
			sizeBytes: String(Buffer.byteLength(content)),
			uploadedBy: user.id,
			revision: 1,
		});
		await route.fulfill({ json: { file: files[0] } });
	});
	await page.route(
		"**/api/files/file-browser-contract/content",
		async (route) => {
			expect(route.request().headers().authorization).toMatch(/^Bearer /);
			await route.fulfill({ contentType: "text/plain", body: content });
		},
	);
	await page.route(
		"**/rpc/office.v1.OfficeService/DeleteFile",
		async (route) => {
			expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
			expect(route.request().postDataJSON()).toEqual({
				id: "file-browser-contract",
				expectedRevision: 1,
			});
			files = files.filter((file) => file.id !== "file-browser-contract");
			await route.fulfill({ json: {} });
		},
	);
	await page.addInitScript(
		(token) => sessionStorage.setItem("office-office-session", token),
		token,
	);
	await page.goto("/files");
	await page.getByLabel("Upload a file", { exact: true }).setInputFiles({
		name: "research.txt",
		mimeType: "text/plain",
		buffer: Buffer.from(content),
	});
	await page.getByRole("button", { name: "Upload file", exact: true }).click();
	await expect(page.getByText("research.txt", { exact: true })).toBeVisible();
	const downloading = page.waitForEvent("download");
	await page.getByRole("button", { name: "Download", exact: true }).click();
	const download = await downloading;
	expect(download.suggestedFilename()).toBe("research.txt");
	expect(await readFile((await download.path()) || "", "utf8")).toBe(content);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const requestsBeforeReturn = listRequests;
	files.push({
		id: "external-file",
		name: "Added while away.pdf",
		module: "projects",
		contentType: "application/pdf",
		sizeBytes: "100",
		uploadedBy: user.id,
		revision: 1,
	});
	await page.goBack();
	await expect(page).toHaveURL(`${office.url}/files`);
	await expect(
		page.getByText("Added while away.pdf", { exact: true }),
	).toBeVisible();
	expect(listRequests).toBeGreaterThan(requestsBeforeReturn);
	const row = page.getByRole("listitem").filter({ hasText: "research.txt" });
	await row.getByRole("button", { name: "Delete", exact: true }).click();
	await expect(
		row.getByRole("button", { name: "Confirm delete", exact: true }),
	).toBeVisible();
	await row
		.getByRole("button", { name: "Confirm delete", exact: true })
		.click();
	await expect(page.getByText("research.txt", { exact: true })).toHaveCount(0);
	await page.getByRole("button", { name: "Sign out", exact: true }).click();
	await page
		.getByLabel("Email address", { exact: true })
		.fill("files-viewer@example.test");
	await page
		.getByLabel("Password", { exact: true })
		.fill("files-viewer-password-123");
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await page.getByRole("button", { name: "Files", exact: true }).click();
	await expect(
		page.getByText("Added while away.pdf", { exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Upload file", exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Delete", exact: true }),
	).toHaveCount(0);
});

test("private profile uploads use authenticated image bytes and can be removed", async ({
	office,
	page,
}) => {
	const { token, user } = await office.bootstrap(false);
	let avatarFileId = "";
	let contentRequests = 0;
	await page.route("**/rpc/office.v1.OfficeService/ListFiles", (route) =>
		route.fulfill({ json: { storageConfigured: true, files: [] } }),
	);
	await page.route(
		"**/rpc/office.v1.OfficeService/GetWorkspace",
		async (route) => {
			const response = await route.fetch();
			const data = await response.json();
			data.currentUser.avatarFileId = avatarFileId;
			data.members = data.members.map((member: { id: string }) =>
				member.id === user.id ? { ...member, avatarFileId } : member,
			);
			await route.fulfill({ response, json: data });
		},
	);
	await page.route("**/api/files?*", async (route) => {
		expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
		expect(new URL(route.request().url()).searchParams.get("module")).toBe(
			"profile",
		);
		expect(route.request().postDataBuffer()).toEqual(png);
		await route.fulfill({ json: { file: { id: "private-profile-image" } } });
	});
	await page.route(
		"**/rpc/office.v1.OfficeService/SaveProfile",
		async (route) => {
			expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
			avatarFileId = route.request().postDataJSON().avatarFileId || "";
			await route.fulfill({ json: { member: { ...user, avatarFileId } } });
		},
	);
	await page.route(
		"**/api/files/private-profile-image/content",
		async (route) => {
			contentRequests += 1;
			expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
			await route.fulfill({ contentType: "image/png", body: png });
		},
	);
	await page.addInitScript(
		(token) => sessionStorage.setItem("office-office-session", token),
		token,
	);
	await page.goto("/settings");
	await page
		.getByLabel("Upload profile picture", { exact: true })
		.setInputFiles({ name: "me.png", mimeType: "image/png", buffer: png });
	await expect(
		page.getByText("Profile picture saved.", { exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("img", { name: "E2E Admin avatar" }).first(),
	).toHaveJSProperty("naturalWidth", 1);
	expect(contentRequests).toBeGreaterThan(0);
	await page
		.getByRole("button", { name: "Remove uploaded picture", exact: true })
		.click();
	await expect(
		page.getByText("Profile picture removed.", { exact: true }),
	).toBeVisible();
	await expect(page.getByRole("img", { name: "E2E Admin avatar" })).toHaveCount(
		0,
	);
	await expect(
		page.getByRole("img", { name: "E2E Admin initials" }).first(),
	).toBeVisible();
});

import { readFile } from "node:fs/promises";
import { expect, test } from "./fixtures";

const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=",
	"base64",
);

type GalleryFile = {
	id: string;
	name: string;
	module: string;
	recordId: string;
	contentType: string;
	sizeBytes: string;
	uploadedBy: string;
	createdAt: string;
	revision: number;
};

function imageFile(
	id: string,
	name: string,
	module: string,
	uploader: string,
	recordId = "",
): GalleryFile {
	return {
		id,
		name,
		module,
		recordId: module === "profile" ? recordId || uploader : recordId,
		contentType: "image/png",
		sizeBytes: String(png.byteLength),
		uploadedBy: uploader,
		createdAt: "2026-10-01T12:00:00Z",
		revision: 1,
	};
}

async function installFilesRoute(
	page: import("@playwright/test").Page,
	token: string,
	files: GalleryFile[],
) {
	await page.route(
		"**/rpc/office.v1.OfficeService/ListFiles",
		async (route) => {
			expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
			const request = route.request().postDataJSON();
			const selected = files.filter(
				(file) =>
					(!request.module || file.module === request.module) &&
					(!request.recordId || file.recordId === request.recordId),
			);
			await route.fulfill({
				json: { files: selected, storageConfigured: true },
			});
		},
	);
}

async function signInPage(
	page: import("@playwright/test").Page,
	token: string,
	path = "/files",
) {
	await page.addInitScript(
		(value) => sessionStorage.setItem("office-office-session", value),
		token,
	);
	await page.goto(path);
}

test("Gallery filters image types by search, category and project and loads thumbnails on scroll", async ({
	office,
	page,
}) => {
	const { token, user } = await office.bootstrap(false);
	const projectResponse = await office.rpc(
		"SaveProject",
		{ project: { name: "Gallery sample project", status: "planning" } },
		token,
	);
	expect(projectResponse.ok()).toBeTruthy();
	const project = (await projectResponse.json()).project;
	const files: GalleryFile[] = [
		imageFile(
			"gallery-project-match",
			"Sample launch photo.png",
			"projects",
			user.id,
			project.id,
		),
		imageFile(
			"gallery-project-other",
			"Other project photo.png",
			"projects",
			user.id,
			"another-project",
		),
		imageFile("gallery-report", "Sample report cover.png", "reports", user.id),
		imageFile(
			"gallery-profile",
			"Sample profile picture.png",
			"profile",
			user.id,
		),
		{
			...imageFile("excluded-pdf", "Document.pdf", "reports", user.id),
			contentType: "application/pdf",
		},
		{
			...imageFile("excluded-svg", "Vector.svg", "reports", user.id),
			contentType: "image/svg+xml",
		},
		{
			...imageFile("excluded-html", "Page.html", "reports", user.id),
			contentType: "text/html",
		},
	];
	for (let index = 0; index < 80; index += 1) {
		files.push(
			imageFile(
				`far-image-${index}`,
				`Sample image ${index}.png`,
				"reports",
				user.id,
			),
		);
	}
	await installFilesRoute(page, token, files);
	const previewRequests = new Set<string>();
	await page.route("**/api/files/*/preview?*", async (route) => {
		const url = new URL(route.request().url());
		previewRequests.add(url.pathname.split("/").at(-2) || "");
		await route.fulfill({ status: 200, contentType: "image/png", body: png });
	});
	await signInPage(page, token);
	await page.getByRole("tab", { name: "Gallery", exact: true }).click();
	await expect(
		page.getByText("Sample launch photo.png", { exact: true }),
	).toBeVisible();
	await expect(page.getByText("Document.pdf", { exact: true })).toHaveCount(0);
	await expect(page.getByText("Vector.svg", { exact: true })).toHaveCount(0);
	await expect(page.getByText("Page.html", { exact: true })).toHaveCount(0);
	await expect(page.getByText("84 images", { exact: true })).toBeVisible();
	await expect
		.poll(() => previewRequests.has("gallery-project-match"))
		.toBe(true);
	await expect.poll(() => previewRequests.has("far-image-79")).toBe(false);
	await page.getByLabel("Search images", { exact: true }).fill("launch photo");
	await expect(
		page.getByText("Sample launch photo.png", { exact: true }),
	).toBeVisible();
	await expect(
		page.getByText("Other project photo.png", { exact: true }),
	).toHaveCount(0);
	await page.getByLabel("Search images", { exact: true }).fill("");
	await page
		.getByRole("combobox", { name: "Category", exact: true })
		.selectOption("reports");
	await expect(
		page.getByText("Sample report cover.png", { exact: true }),
	).toBeVisible();
	await expect(
		page.getByText("Sample profile picture.png", { exact: true }),
	).toHaveCount(0);
	await page
		.getByRole("combobox", { name: "Category", exact: true })
		.selectOption("projects");
	await page
		.getByRole("combobox", { name: "Project", exact: true })
		.selectOption(project.id);
	await expect(
		page.getByText("Sample launch photo.png", { exact: true }),
	).toBeVisible();
	await expect(
		page.getByText("Other project photo.png", { exact: true }),
	).toHaveCount(0);
	await page.screenshot({ path: "test-results/gallery-desktop.png" });
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(page.locator("#office-drawer")).not.toBeChecked();
	await expect(
		page.getByRole("button", { name: "Overview", exact: true }),
	).not.toBeInViewport();
	await page
		.getByRole("region", { name: "Image gallery" })
		.scrollIntoViewIfNeeded();
	await expect
		.poll(() =>
			page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth,
			),
		)
		.toBe(true);
	await page.screenshot({
		path: "test-results/gallery-mobile.png",
		animations: "disabled",
	});
	await page
		.getByRole("combobox", { name: "Category", exact: true })
		.selectOption("");
	const farCard = page
		.getByRole("listitem")
		.filter({ hasText: "Sample image 79.png" });
	await farCard.scrollIntoViewIfNeeded();
	await expect.poll(() => previewRequests.has("far-image-79")).toBe(true);
});

test("Gallery previews and downloads authenticated bytes, retries failures, restores focus and confirms deletion", async ({
	office,
	page,
}) => {
	const { token, user } = await office.bootstrap(false);
	const files = [
		imageFile("preview-good", "Sample preview.png", "projects", user.id),
		imageFile("preview-retry", "Sample retry.png", "projects", user.id),
	];
	await installFilesRoute(page, token, files);
	let retries = 0;
	await page.route("**/api/files/*/preview?*", async (route) => {
		const url = new URL(route.request().url());
		expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
		if (
			url.pathname.endsWith("/preview-retry/preview") &&
			url.searchParams.get("size") === "full" &&
			retries++ === 0
		) {
			await route.fulfill({ status: 503, body: "preview unavailable" });
			return;
		}
		await route.fulfill({ status: 200, contentType: "image/png", body: png });
	});
	const content = Buffer.from("sample gallery download bytes");
	await page.route("**/api/files/preview-good/content", async (route) => {
		expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
		await route.fulfill({ contentType: "image/png", body: content });
	});
	await page.route(
		"**/rpc/office.v1.OfficeService/DeleteFile",
		async (route) => {
			expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
			expect(route.request().postDataJSON()).toEqual({
				id: "preview-good",
				expectedRevision: 1,
			});
			files.splice(
				files.findIndex((file) => file.id === "preview-good"),
				1,
			);
			await route.fulfill({ json: {} });
		},
	);
	await signInPage(page, token);
	await page.getByRole("tab", { name: "Gallery", exact: true }).click();
	const retryButton = page.getByRole("button", {
		name: "Preview Sample retry.png",
	});
	await retryButton.click();
	const retryDialog = page.getByRole("dialog", { name: "Sample retry.png" });
	await expect(
		retryDialog.getByText("Preview unavailable", { exact: true }),
	).toBeVisible();
	await retryDialog
		.getByRole("button", { name: "Retry preview", exact: true })
		.click();
	await expect(
		retryDialog.getByRole("img", { name: "Sample retry.png" }),
	).toHaveJSProperty("naturalWidth", 1);
	await page.keyboard.press("Escape");
	await expect(retryDialog).toHaveCount(0);
	await expect(retryButton).toBeFocused();

	const previewButton = page.getByRole("button", {
		name: "Preview Sample preview.png",
	});
	await previewButton.click();
	const dialog = page.getByRole("dialog", { name: "Sample preview.png" });
	await expect(
		dialog.getByRole("img", { name: "Sample preview.png" }),
	).toHaveJSProperty("naturalWidth", 1);
	const downloading = page.waitForEvent("download");
	await dialog.getByRole("button", { name: "Download", exact: true }).click();
	const download = await downloading;
	expect(download.suggestedFilename()).toBe("Sample preview.png");
	expect(await readFile((await download.path()) || "")).toEqual(content);
	await dialog.getByRole("button", { name: "Delete", exact: true }).click();
	await expect(
		dialog.getByText(/Delete this file from the office/),
	).toBeVisible();
	await dialog
		.getByRole("button", { name: "Confirm delete", exact: true })
		.click();
	await expect(dialog).toHaveCount(0);
	await expect(
		page.getByText("Sample preview.png", { exact: true }),
	).toHaveCount(0);
});

test("Viewer can browse gallery pictures and reuse their own saved picture without upload or delete", async ({
	office,
	page,
}) => {
	const { token: adminToken } = await office.bootstrap(false);
	const created = await office.rpc(
		"SaveMember",
		{
			member: {
				name: "Gallery Viewer",
				email: "gallery-viewer@example.test",
				kind: "human",
				role: "viewer",
				status: "active",
			},
			password: "gallery-viewer-password-123",
		},
		adminToken,
	);
	expect(created.ok()).toBeTruthy();
	const { member: viewer } = await created.json();
	const login = await office.rpc("Login", {
		email: "gallery-viewer@example.test",
		password: "gallery-viewer-password-123",
	});
	expect(login.ok()).toBeTruthy();
	const { token } = await login.json();
	const adminWorkspace = await (
		await office.rpc("GetWorkspace", {}, adminToken)
	).json();
	const otherMember = adminWorkspace.members.find(
		(member: { id: string }) => member.id !== viewer.id,
	);
	const files = [
		imageFile(
			"viewer-owned-profile-image",
			"Viewer own picture.png",
			"profile",
			viewer.id,
		),
		imageFile(
			"other-owned-profile-image",
			"Other member picture.png",
			"profile",
			otherMember.id,
		),
		imageFile(
			"viewer-project-image",
			"Readable project image.png",
			"projects",
			viewer.id,
		),
	];
	await installFilesRoute(page, token, files);
	await page.route("**/api/files/*/preview?*", (route) =>
		route.fulfill({ status: 200, contentType: "image/png", body: png }),
	);
	await page.route(
		"**/rpc/office.v1.OfficeService/SaveProfile",
		async (route) => {
			expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
			const body = route.request().postDataJSON();
			expect(body.avatarFileId).toBe("viewer-owned-profile-image");
			await route.fulfill({
				json: { member: { ...viewer, avatarFileId: body.avatarFileId } },
			});
		},
	);
	let uploadRequests = 0;
	await page.route("**/api/files?*", (route) => {
		uploadRequests += 1;
		return route.fulfill({ status: 500 });
	});
	await signInPage(page, token, "/settings");
	await page
		.getByRole("button", { name: "Choose existing picture", exact: true })
		.click();
	await expect(
		page.getByRole("button", {
			name: "Use Viewer own picture.png",
			exact: true,
		}),
	).toBeVisible();
	await expect(
		page.getByRole("button", {
			name: "Use Other member picture.png",
			exact: true,
		}),
	).toBeVisible();
	await page
		.getByRole("button", { name: "Use Viewer own picture.png", exact: true })
		.click();
	await expect(
		page.getByText("Profile picture saved.", { exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: "Save profile", exact: true }).click();
	await expect(page.getByText("Profile saved.", { exact: true })).toBeVisible();
	expect(uploadRequests).toBe(0);
	await page.getByRole("button", { name: "Files", exact: true }).click();
	await page.getByRole("tab", { name: "Gallery", exact: true }).click();
	await expect(
		page.getByText("Readable project image.png", { exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Upload files", exact: true }),
	).toHaveCount(0);
	await page
		.getByRole("button", {
			name: "Preview Readable project image.png",
			exact: true,
		})
		.click();
	const dialog = page.getByRole("dialog", {
		name: "Readable project image.png",
	});
	await expect(
		dialog.getByRole("button", { name: "Download", exact: true }),
	).toBeVisible();
	await expect(
		dialog.getByRole("button", { name: "Delete", exact: true }),
	).toHaveCount(0);
});

for (const source of [
	{ module: "projects", contentType: "image/png", extension: "png" },
	{ module: "reports", contentType: "image/jpeg", extension: "jpg" },
	{ module: "profile", contentType: "image/webp", extension: "webp" },
]) {
	test(`Profile picker copies another member's ${source.module} image into an owned PNG`, async ({
		office,
		page,
	}, testInfo) => {
		const { token, user } = await office.bootstrap(false);
		const originalId = `shared-${source.module}-image`;
		const copiedId = `owned-${source.module}-profile-image`;
		const filename = `Shared ${source.module} picture.${source.extension}`;
		const files = [
			{
				...imageFile(originalId, filename, source.module, "another-member"),
				contentType: source.contentType,
			},
			{
				...imageFile(
					"excluded-svg",
					"Shared vector.svg",
					"projects",
					"another-member",
				),
				contentType: "image/svg+xml",
			},
		];
		await installFilesRoute(page, token, files);
		const selectedThumbnailRequests: string[] = [];
		await page.route("**/api/files/*/preview?*", async (route) => {
			expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
			const url = new URL(route.request().url());
			expect(url.searchParams.get("size")).toBe("thumbnail");
			selectedThumbnailRequests.push(url.pathname);
			await route.fulfill({ contentType: "image/png", body: png });
		});
		let uploads = 0;
		await page.route("**/api/files?*", async (route) => {
			const request = route.request();
			expect(request.method()).toBe("POST");
			expect(request.headers().authorization).toBe(`Bearer ${token}`);
			expect(request.headers()["content-type"]).toBe("image/png");
			expect(new URL(request.url()).searchParams.get("module")).toBe("profile");
			expect(request.postDataBuffer()).toEqual(png);
			uploads += 1;
			files.push(imageFile(copiedId, "Copied picture.png", "profile", user.id));
			await route.fulfill({ json: { file: { id: copiedId } } });
		});
		const savedIds: string[] = [];
		await page.route(
			"**/rpc/office.v1.OfficeService/SaveProfile",
			async (route) => {
				expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
				const body = route.request().postDataJSON();
				savedIds.push(body.avatarFileId);
				await route.fulfill({
					json: { member: { ...user, avatarFileId: body.avatarFileId } },
				});
			},
		);
		let deletes = 0;
		await page.route(
			"**/rpc/office.v1.OfficeService/DeleteFile",
			async (route) => {
				deletes += 1;
				await route.fulfill({ json: {} });
			},
		);
		await signInPage(page, token, "/settings");
		await page
			.getByRole("button", { name: "Choose existing picture", exact: true })
			.click();
		const picker = page.getByRole("region", {
			name: "Profile picture gallery",
			exact: true,
		});
		await expect(
			picker.getByRole("button", { name: `Use ${filename}`, exact: true }),
		).toBeVisible();
		await expect(
			picker.getByRole("button", {
				name: "Use Shared vector.svg",
				exact: true,
			}),
		).toHaveCount(0);
		if (source.module === "projects") {
			await page.screenshot({
				path: testInfo.outputPath("profile-gallery-desktop.png"),
				animations: "disabled",
			});
			await page.setViewportSize({ width: 390, height: 844 });
			await picker.scrollIntoViewIfNeeded();
			expect(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= window.innerWidth,
				),
			).toBe(true);
			await page.screenshot({
				path: testInfo.outputPath("profile-gallery-mobile.png"),
				animations: "disabled",
			});
		}
		// Rendering may already fetch a thumbnail; selection must fetch fresh authenticated bytes for the copy.
		const beforeSelection = selectedThumbnailRequests.filter((path) =>
			path.includes(originalId),
		).length;
		await picker
			.getByRole("button", { name: `Use ${filename}`, exact: true })
			.click();
		await expect(
			page.getByText("Profile picture saved.", { exact: true }),
		).toBeVisible();
		expect(
			selectedThumbnailRequests.filter((path) => path.includes(originalId))
				.length,
		).toBeGreaterThan(beforeSelection);
		expect(uploads).toBe(1);
		expect(savedIds).toEqual([copiedId]);
		expect(savedIds).not.toContain(originalId);
		expect(deletes).toBe(0);
		expect(files.some((file) => file.id === originalId)).toBe(true);
	});
}

for (const failure of ["thumbnail", "upload"]) {
	test(`Profile picker ${failure} failure preserves the source and permits retry without saving`, async ({
		office,
		page,
	}) => {
		const { token, user } = await office.bootstrap(false);
		const originalId = "shared-retry-image";
		const copiedId = "owned-retried-image";
		await installFilesRoute(page, token, [
			imageFile(originalId, "Shared retry.png", "reports", "another-member"),
		]);
		let selecting = false;
		let failed = false;
		let uploads = 0;
		await page.route("**/api/files/*/preview?*", async (route) => {
			expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
			expect(new URL(route.request().url()).searchParams.get("size")).toBe(
				"thumbnail",
			);
			if (selecting && failure === "thumbnail" && !failed) {
				failed = true;
				await route.fulfill({
					status: 503,
					body: "Thumbnail temporarily unavailable",
				});
				return;
			}
			await route.fulfill({ contentType: "image/png", body: png });
		});
		await page.route("**/api/files?*", async (route) => {
			expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
			expect(new URL(route.request().url()).searchParams.get("module")).toBe(
				"profile",
			);
			uploads += 1;
			if (failure === "upload" && !failed) {
				failed = true;
				await route.fulfill({
					status: 503,
					body: "Profile upload temporarily unavailable",
				});
				return;
			}
			await route.fulfill({ json: { file: { id: copiedId } } });
		});
		const savedIds: string[] = [];
		await page.route(
			"**/rpc/office.v1.OfficeService/SaveProfile",
			async (route) => {
				const body = route.request().postDataJSON();
				savedIds.push(body.avatarFileId);
				await route.fulfill({
					json: { member: { ...user, avatarFileId: body.avatarFileId } },
				});
			},
		);
		let deletes = 0;
		await page.route(
			"**/rpc/office.v1.OfficeService/DeleteFile",
			async (route) => {
				deletes += 1;
				await route.fulfill({ json: {} });
			},
		);
		await signInPage(page, token, "/settings");
		await page
			.getByRole("button", { name: "Choose existing picture", exact: true })
			.click();
		const usePicture = page.getByRole("button", {
			name: "Use Shared retry.png",
			exact: true,
		});
		await expect(usePicture).toBeVisible();
		await expect(
			page
				.getByRole("region", { name: "Profile picture gallery", exact: true })
				.getByRole("img", { name: "Shared retry.png" }),
		).toHaveJSProperty("naturalWidth", 1);
		selecting = true;
		await usePicture.click();
		await expect(page.getByRole("alert")).toContainText(
			/temporarily unavailable/,
		);
		expect(failed).toBe(true);
		expect(savedIds).toEqual([]);
		expect(uploads).toBe(failure === "thumbnail" ? 0 : 1);
		expect(deletes).toBe(0);
		await expect(usePicture).toBeEnabled();
		await usePicture.click();
		await expect(
			page.getByText("Profile picture saved.", { exact: true }),
		).toBeVisible();
		expect(savedIds).toEqual([copiedId]);
		expect(uploads).toBe(failure === "thumbnail" ? 1 : 2);
		expect(deletes).toBe(0);
	});
}

test("Admin stages a gallery avatar for a teammate until Save changes", async ({
	office,
	page,
}) => {
	const { token, user } = await office.bootstrap(false);
	const created = await office.rpc(
		"SaveMember",
		{
			member: {
				name: "Avatar teammate",
				email: "avatar-teammate@example.test",
				kind: "human",
				role: "member",
				status: "active",
			},
		},
		token,
	);
	expect(created.ok()).toBeTruthy();
	const { member } = await created.json();
	await installFilesRoute(page, token, [
		imageFile(
			"shared-admin-picture",
			"Shared admin picture.png",
			"projects",
			user.id,
		),
	]);
	await page.route("**/api/files/*/preview?*", (route) =>
		route.fulfill({ contentType: "image/png", body: png }),
	);
	await page.route("**/api/files?*", (route) => {
		expect(new URL(route.request().url()).searchParams.get("record_id")).toBe(
			member.id,
		);
		return route.fulfill({ json: { file: { id: "staged-teammate-picture" } } });
	});
	let saves = 0;
	await page.route(
		"**/rpc/office.v1.OfficeService/SaveMember",
		async (route) => {
			saves += 1;
			const body = route.request().postDataJSON();
			expect(body.member.avatarFileId).toBe("staged-teammate-picture");
			await route.fulfill({ json: { member: { ...member, ...body.member } } });
		},
	);
	await signInPage(page, token, "/team");
	await page
		.getByRole("row")
		.filter({ hasText: "Avatar teammate" })
		.getByRole("button", { name: "Edit", exact: true })
		.click();
	const dialog = page.getByRole("dialog", {
		name: "Edit team member",
		exact: true,
	});
	await dialog.getByLabel("Bio", { exact: true }).fill("Unsaved teammate bio");
	await dialog
		.getByRole("button", { name: "Choose existing picture", exact: true })
		.click();
	await dialog
		.getByRole("button", { name: "Use Shared admin picture.png", exact: true })
		.click();
	await expect(
		dialog.getByText("Picture selected. Save changes to apply it.", {
			exact: true,
		}),
	).toBeVisible();
	expect(saves).toBe(0);
	await dialog
		.getByRole("button", { name: "Save changes", exact: true })
		.click();
	await expect(dialog).toHaveCount(0);
	expect(saves).toBe(1);
});

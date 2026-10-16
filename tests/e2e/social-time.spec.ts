import { expect, test } from "./fixtures";

for (const scenario of [
	{
		timezoneId: "Asia/Kolkata",
		stored: "2026-10-20T20:45:37.123Z",
		local: "2026-10-21T02:15",
		changedLocal: "2026-10-21T03:00",
		changedStored: "2026-10-20T21:30:00.000Z",
	},
	{
		timezoneId: "America/New_York",
		// The second occurrence of 01:30 during the autumn DST transition.
		stored: "2026-11-01T06:30:37.123Z",
		local: "2026-11-01T01:30",
		changedLocal: "2026-11-01T03:00",
		changedStored: "2026-11-01T08:00:00.000Z",
	},
]) {
	test.describe(scenario.timezoneId, () => {
		test.use({ timezoneId: scenario.timezoneId });

		test("editing a post preserves its instant and changed local times save as UTC", async ({
			page,
			office,
		}) => {
			const { token } = await office.bootstrap();
			const workspace = await (
				await office.rpc("GetWorkspace", {}, token)
			).json();
			const post = {
				...workspace.posts[0],
				content: "Timezone regression post",
				status: "queued",
				scheduledAt: scenario.stored,
			};
			expect((await office.rpc("SavePost", { post }, token)).ok()).toBeTruthy();
			await page.addInitScript(
				(value) => sessionStorage.setItem("office-office-session", value),
				token,
			);
			await page.goto("/social");
			const card = page.locator("article").filter({ hasText: post.content });
			await card.getByRole("button", { name: "Edit", exact: true }).click();
			const dialog = page.getByRole("dialog");
			await expect(
				dialog.getByLabel("Scheduled time", { exact: true }),
			).toHaveValue(scenario.local);
			await dialog
				.getByLabel("Post content", { exact: true })
				.fill("Edited content");
			await dialog
				.getByRole("button", { name: "Save changes", exact: true })
				.click();
			await expect(dialog).toHaveCount(0);
			let saved = await (await office.rpc("GetWorkspace", {}, token)).json();
			expect(
				saved.posts.find((item: { id: string }) => item.id === post.id)
					.scheduledAt,
			).toBe(scenario.stored);

			await page
				.locator("article")
				.filter({ hasText: "Edited content" })
				.getByRole("button", { name: "Edit", exact: true })
				.click();
			await dialog
				.getByLabel("Scheduled time", { exact: true })
				.fill(scenario.changedLocal);
			await dialog
				.getByRole("button", { name: "Save changes", exact: true })
				.click();
			await expect(dialog).toHaveCount(0);
			saved = await (await office.rpc("GetWorkspace", {}, token)).json();
			expect(
				saved.posts.find((item: { id: string }) => item.id === post.id)
					.scheduledAt,
			).toBe(scenario.changedStored);
		});
	});
}

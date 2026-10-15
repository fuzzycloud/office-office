import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests/e2e",
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	workers: 1,
	retries: 0,
	timeout: 60_000,
	expect: { timeout: 10_000 },
	globalSetup: "./tests/e2e/global-setup.ts",
	reporter: [["list"], ["html", { open: "never" }]],
	use: {
		actionTimeout: 10_000,
		navigationTimeout: 15_000,
		viewport: { width: 1440, height: 1000 },
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
});

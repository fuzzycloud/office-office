import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests/e2e",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	use: {
		baseURL: "http://127.0.0.1:8097",
		viewport: { width: 1440, height: 1000 },
		trace: "retain-on-failure",
	},
	webServer: {
		command: "cargo run --locked -p office-server",
		url: "http://127.0.0.1:8097/healthz",
		env: { ADDR: "127.0.0.1:8097" },
		reuseExistingServer: false,
		timeout: 120_000,
	},
});

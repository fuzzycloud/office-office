import { defineConfig } from "@playwright/test";
import config from "./playwright.config";

export default defineConfig({
	...config,
	testDir: "./tests/visual",
	outputDir: "./test-results/visual",
	snapshotPathTemplate: "{testDir}/__screenshots__/{projectName}/{arg}{ext}",
	updateSnapshots: "none",
	expect: {
		timeout: 10000,
		toHaveScreenshot: {
			animations: "disabled",
			caret: "hide",
			maxDiffPixels: 40,
			threshold: 0.2,
		},
	},
	reporter: [
		["list"],
		["html", { outputFolder: "playwright-report/visual", open: "never" }],
	],
	use: {
		...config.use,
		locale: "en-US",
		timezoneId: "UTC",
		reducedMotion: "reduce",
		deviceScaleFactor: 1,
	},
	projects: [
		{
			name: "light-desktop",
			use: { viewport: { width: 1440, height: 1000 }, colorScheme: "light" },
		},
		{
			name: "dark-desktop",
			use: { viewport: { width: 1440, height: 1000 }, colorScheme: "dark" },
		},
		{
			name: "light-mobile",
			use: { viewport: { width: 390, height: 844 }, colorScheme: "light" },
		},
		{
			name: "dark-mobile",
			use: { viewport: { width: 390, height: 844 }, colorScheme: "dark" },
		},
	],
});

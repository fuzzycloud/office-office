import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type APIResponse, test as base, expect } from "@playwright/test";
import { repositoryRoot, serverBinary } from "./global-setup";

export type BootstrapResult = {
	token: string;
	user: { id: string; name: string; email: string; role: string };
	expiresAt: string;
};

export type Office = {
	url: string;
	rpc(method: string, body?: unknown, token?: string): Promise<APIResponse>;
	bootstrap(loadDemoData?: boolean): Promise<BootstrapResult>;
	restart(): Promise<void>;
};

async function freePort(): Promise<number> {
	const listener = createServer();
	await new Promise<void>((resolve, reject) => {
		listener.once("error", reject);
		listener.listen(0, "127.0.0.1", resolve);
	});
	const address = listener.address();
	if (!address || typeof address === "string")
		throw new Error("No test port allocated");
	await new Promise<void>((resolve, reject) => {
		listener.close((error) => (error ? reject(error) : resolve()));
	});
	return address.port;
}

export const test = base.extend<{ office: Office }>({
	page: async ({ page }, use, testInfo) => {
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await use(page);
		if (errors.length) {
			await testInfo.attach("browser-errors", {
				body: errors.join("\n"),
				contentType: "text/plain",
			});
		}
		expect(errors, "No uncaught browser exceptions").toEqual([]);
	},
	office: async ({ playwright }, use, testInfo) => {
		const url = `http://127.0.0.1:${await freePort()}`;
		const logPath = testInfo.outputPath("server.log");
		await mkdir(dirname(logPath), { recursive: true });
		const logs = createWriteStream(logPath);
		const api = await playwright.request.newContext({ baseURL: url });
		const directory = await mkdtemp(join(tmpdir(), "office-office-e2e-"));
		let child: ChildProcess | undefined;
		let exited: Promise<void> = Promise.resolve();
		let spawnError: Error | undefined;
		let stopped = true;

		async function stop() {
			if (!child || stopped) return;
			child.kill("SIGTERM");
			const timeout = new AbortController();
			try {
				await Promise.race([
					exited,
					delay(5_000, undefined, { signal: timeout.signal }),
				]);
			} finally {
				timeout.abort();
			}
			if (!stopped) {
				child.kill("SIGKILL");
				await exited;
			}
		}

		async function start() {
			spawnError = undefined;
			stopped = false;
			// Deliberately do not inherit provider credentials or developer storage settings.
			child = spawn(serverBinary, [], {
				cwd: repositoryRoot,
				env: {
					PATH: process.env.PATH,
					...(process.env.SystemRoot
						? { SystemRoot: process.env.SystemRoot }
						: {}),
					ADDR: url.replace("http://", ""),
					OFFICE_DEMO_MODE: "false",
					OFFICE_DATABASE_PATH: join(directory, "office.sqlite3"),
					RUST_LOG: "warn",
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
			child.stdout?.pipe(logs, { end: false });
			child.stderr?.pipe(logs, { end: false });
			exited = new Promise((resolve) => {
				child?.once("error", (error) => {
					spawnError = error;
				});
				child?.once("close", () => {
					stopped = true;
					resolve();
				});
			});
			const deadline = Date.now() + 20_000;
			while (Date.now() < deadline) {
				if (spawnError) throw spawnError;
				if (stopped)
					throw new Error(
						"Test server exited before becoming healthy; see server.log",
					);
				try {
					const response = await api.get("/healthz", { timeout: 500 });
					const healthy = response.ok();
					await response.dispose();
					if (healthy) return;
				} catch {
					// Binding and opening the fresh SQLite database can take a moment.
				}
				await delay(100);
			}
			throw new Error("Test server health check timed out; see server.log");
		}

		const office: Office = {
			url,
			rpc: (method, body = {}, token) =>
				api.post(`/rpc/office.v1.OfficeService/${method}`, {
					data: body,
					headers: {
						"Content-Type": "application/json",
						"Connect-Protocol-Version": "1",
						...(token ? { Authorization: `Bearer ${token}` } : {}),
					},
				}),
			async bootstrap(loadDemoData = true) {
				const response = await office.rpc("BootstrapAdmin", {
					name: "E2E Admin",
					email: "admin@example.test",
					password: "e2e-admin-password-123",
					workspaceName: "E2E office",
					loadDemoData,
				});
				expect(response.ok(), "RPC bootstrap succeeds").toBeTruthy();
				return response.json() as Promise<BootstrapResult>;
			},
			async restart() {
				await stop();
				await start();
			},
		};

		try {
			await start();
			await use(office);
		} finally {
			// Cleanup must also run when attaching an artifact fails.
			await stop();
			try {
				await api.dispose();
				await new Promise<void>((resolve) => logs.end(resolve));
				await testInfo.attach("server.log", {
					path: logPath,
					contentType: "text/plain",
				});
			} finally {
				// Remove SQLite and sidecars only after the process has exited.
				await rm(directory, { recursive: true, force: true });
			}
		}
	},
	baseURL: async ({ office }, use) => use(office.url),
});

export { expect };

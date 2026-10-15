import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

export const repositoryRoot = resolve(__dirname, "../..");
export const serverBinary = resolve(
	repositoryRoot,
	process.env.CARGO_TARGET_DIR || "target",
	"debug",
	process.platform === "win32" ? "office-server.exe" : "office-server",
);

export default function globalSetup() {
	// A failed build must fail the suite, including when it runs directly via pnpm.
	execFileSync("pnpm", ["build"], {
		cwd: repositoryRoot,
		stdio: "inherit",
	});
	execFileSync("cargo", ["build", "--locked", "-p", "office-server"], {
		cwd: repositoryRoot,
		stdio: "inherit",
	});
}

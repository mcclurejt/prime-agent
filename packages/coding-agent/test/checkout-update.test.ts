import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildCheckoutUpdateArtifact,
	type CheckoutCommandRunner,
	validatePrimeAgentCheckout,
} from "../src/checkout-update.js";

const packageNames = {
	ai: "@earendil-works/pi-ai",
	tui: "@earendil-works/pi-tui",
	agent: "@earendil-works/pi-agent-core",
	"coding-agent": "@earendil-works/pi-coding-agent",
};

const temporaryDirectories: string[] = [];

function run(command: string, args: string[], cwd: string): string {
	return execFileSync(command, args, { cwd, encoding: "utf8" }).trim();
}

function createCheckout(): string {
	const checkout = join(tmpdir(), `prime-agent-checkout-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	temporaryDirectories.push(checkout);
	mkdirSync(checkout, { recursive: true });
	writeFileSync(
		join(checkout, "package.json"),
		JSON.stringify({ name: "prime-agent", version: "1.2.3", workspaces: ["packages/*"] }),
	);
	for (const [directory, name] of Object.entries(packageNames)) {
		const packageDirectory = join(checkout, "packages", directory);
		mkdirSync(join(packageDirectory, "dist", "bundle"), { recursive: true });
		const dependencies: Record<string, string> = {};
		if (directory === "agent") dependencies[packageNames.ai] = "^1.2.3";
		if (directory === "coding-agent") {
			dependencies[packageNames.ai] = "^1.2.3";
			dependencies[packageNames.tui] = "^1.2.3";
			dependencies[packageNames.agent] = "^1.2.3";
		}
		writeFileSync(
			join(packageDirectory, "package.json"),
			JSON.stringify({
				name,
				version: "1.2.3",
				type: "module",
				main: "./dist/index.js",
				files: ["dist"],
				dependencies,
			}),
		);
		writeFileSync(join(packageDirectory, "dist", "index.js"), "export {};\n");
		if (directory === "coding-agent")
			writeFileSync(join(packageDirectory, "dist", "bundle", "cli.js"), "#!/usr/bin/env node\n");
	}
	run("git", ["init", "-q"], checkout);
	run("git", ["add", "."], checkout);
	run("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"], checkout);
	return checkout;
}

const buildDirectories: string[] = [];
const runner: CheckoutCommandRunner = {
	async run(command, args, cwd) {
		if (command === "git" || (command === "npm" && args[0] === "pack")) return run(command, args, cwd);
		if (command === "npm" && args.join(" ") === "ci --ignore-scripts" && basename(cwd) === "source") {
			buildDirectories.push(cwd);
			return "";
		}
		if (
			command === "npm" &&
			args.join(" ") === "run build" &&
			["tui", "agent", "coding-agent"].includes(basename(cwd)) &&
			basename(dirname(cwd)) === "packages" &&
			basename(dirname(dirname(cwd))) === "source"
		) {
			buildDirectories.push(cwd);
			return "";
		}
		if (
			command === process.execPath &&
			args.join(" ") === `${join(dirname(dirname(cwd)), "node_modules", ".bin", "tsgo")} -p tsconfig.build.json` &&
			basename(cwd) === "ai" &&
			basename(dirname(cwd)) === "packages" &&
			basename(dirname(dirname(cwd))) === "source"
		) {
			buildDirectories.push(cwd);
			return "";
		}
		throw new Error(`Unexpected checkout build command: ${command} ${args.join(" ")} (cwd: ${cwd})`);
	},
};

const integrationCheckout = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
	buildDirectories.length = 0;
});

describe("checkout self-update artifacts", () => {
	it("validates a clean checkout without modifying Git", async () => {
		const checkout = createCheckout();
		const result = await validatePrimeAgentCheckout(checkout, runner);

		expect(result.checkout).toBe(realpathSync(checkout));
		expect(result.head).toMatch(/^[0-9a-f]{40}$/);
		expect(run("git", ["status", "--porcelain=v1", "--untracked-files=all"], checkout)).toBe("");
	});

	it("fails closed when the checkout has an untracked file", async () => {
		const checkout = createCheckout();
		writeFileSync(join(checkout, "untracked.txt"), "nope\n");

		await expect(validatePrimeAgentCheckout(checkout, runner)).rejects.toThrow("tracked or untracked changes");
	});

	it("packages an installable public tarball from an isolated committed source", async () => {
		const checkout = createCheckout();
		const artifact = await buildCheckoutUpdateArtifact(checkout, runner);
		try {
			expect(artifact.version).toMatch(/^1\.2\.3-checkout\.[0-9a-f]{12}$/);
			expect(existsSync(artifact.artifactPath)).toBe(true);
			const manifest = JSON.parse(
				run("tar", ["-xOzf", artifact.artifactPath, "package/package.json"], checkout),
			) as {
				name: string;
				bin: Record<string, string>;
				dependencies: Record<string, string>;
			};
			expect(manifest.name).toBe("prime-agent");
			expect(manifest.bin).toEqual({ "prime-agent": "dist/bundle/cli.js" });
			for (const name of Object.values(packageNames).slice(0, -1)) {
				expect(manifest.dependencies[name]).toMatch(/^file:\/.*\.tgz$/);
			}
			expect(run("tar", ["-tzf", artifact.artifactPath], checkout)).not.toContain("package/local-packages/");
			expect(buildDirectories).not.toContain(checkout);
			expect(run("git", ["status", "--porcelain=v1", "--untracked-files=all"], checkout)).toBe("");

			const prefix = join(tmpdir(), `prime-agent-install-${Date.now()}-${Math.random().toString(36).slice(2)}`);
			temporaryDirectories.push(prefix);
			run("npm", ["install", "-g", "--prefix", prefix, artifact.artifactPath, "--ignore-scripts"], checkout);
			const installed = join(prefix, "lib", "node_modules", "prime-agent");
			expect(existsSync(join(installed, "dist", "bundle", "cli.js"))).toBe(true);
			for (const name of Object.values(packageNames).slice(0, -1)) {
				expect(existsSync(join(installed, "node_modules", ...name.split("/")))).toBe(true);
			}
		} finally {
			const artifactPath = artifact.artifactPath;
			artifact.cleanup();
			expect(existsSync(artifactPath)).toBe(false);
		}
	});
});

describe.skipIf(process.env.PRIME_AGENT_CHECKOUT_INTEGRATION !== "1")("checkout self-update integration", () => {
	it(
		"clones, installs dependencies, builds deterministically, packs, and installs into a temporary prefix",
		{ tags: ["checkout-update-integration"], timeout: 600_000 },
		async () => {
			const artifact = await buildCheckoutUpdateArtifact(integrationCheckout);
			const prefix = join(
				tmpdir(),
				`prime-agent-checkout-integration-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			);
			temporaryDirectories.push(prefix);
			try {
				run(
					"npm",
					["install", "-g", "--prefix", prefix, artifact.artifactPath, "--ignore-scripts"],
					integrationCheckout,
				);
				const installed = join(prefix, "lib", "node_modules", "prime-agent");
				expect(existsSync(join(installed, "dist", "bundle", "cli.js"))).toBe(true);
				for (const name of Object.values(packageNames).slice(0, -1)) {
					expect(existsSync(join(installed, "node_modules", ...name.split("/")))).toBe(true);
				}
			} finally {
				artifact.cleanup();
			}
		},
	);
});

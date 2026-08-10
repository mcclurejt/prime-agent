import { spawn } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const INTERNAL_PACKAGES = ["ai", "tui", "agent", "coding-agent"] as const;
type InternalPackage = (typeof INTERNAL_PACKAGES)[number];
const EXPECTED_PACKAGE_NAMES: Record<InternalPackage, string> = {
	ai: "@earendil-works/pi-ai",
	tui: "@earendil-works/pi-tui",
	agent: "@earendil-works/pi-agent-core",
	"coding-agent": "@earendil-works/pi-coding-agent",
};

export interface CheckoutUpdateArtifact {
	artifactPath: string;
	version: string;
	cleanup(): void;
}

export interface CheckoutCommandRunner {
	run(command: string, args: string[], cwd: string): Promise<string>;
}

const systemRunner: CheckoutCommandRunner = {
	async run(command, args, cwd) {
		return await new Promise<string>((resolvePromise, reject) => {
			const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (data: Buffer) => {
				stdout += data;
				process.stdout.write(data);
			});
			child.stderr.on("data", (data: Buffer) => {
				stderr += data;
				process.stderr.write(data);
			});
			child.on("error", reject);
			child.on("close", (code, signal) => {
				if (code === 0) resolvePromise(stdout.trim());
				else {
					const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
					reject(
						new Error(
							`${command} ${args.join(" ")} ${signal ? `terminated by ${signal}` : `failed: ${output || `exit code ${code ?? "unknown"}`}`}`,
						),
					);
				}
			});
		});
	},
};

function readPackageJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function writePackageJson(path: string, value: Record<string, unknown>): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function packageDir(checkout: string, pkg: InternalPackage): string {
	return join(checkout, "packages", pkg);
}

function requireDirectory(path: string, label: string): void {
	if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`${label} is missing: ${path}`);
}

function requireExpectedWorkspace(checkout: string): void {
	const rootPackage = readPackageJson(join(checkout, "package.json"));
	const workspaces = rootPackage.workspaces;
	if (!Array.isArray(workspaces) || !workspaces.includes("packages/*")) {
		throw new Error("Checkout does not contain the expected Prime Agent workspace configuration");
	}
	for (const pkg of INTERNAL_PACKAGES) {
		const manifestPath = join(packageDir(checkout, pkg), "package.json");
		if (!existsSync(manifestPath)) {
			throw new Error(`Checkout does not contain the expected Prime Agent workspace: packages/${pkg}/package.json`);
		}
		if (readPackageJson(manifestPath).name !== EXPECTED_PACKAGE_NAMES[pkg]) {
			throw new Error(`Checkout does not contain the expected Prime Agent package: ${EXPECTED_PACKAGE_NAMES[pkg]}`);
		}
	}
}

/** Validates only; it never fetches, checks out, resets, or otherwise mutates Git. */
export async function validatePrimeAgentCheckout(
	checkoutPath: string,
	runner: CheckoutCommandRunner = systemRunner,
): Promise<{ checkout: string; head: string }> {
	const requestedCheckout = resolve(checkoutPath);
	requireDirectory(requestedCheckout, "Checkout directory");
	const checkout = realpathSync(requestedCheckout);
	const topLevel = await runner.run("git", ["-C", checkout, "rev-parse", "--show-toplevel"], checkout);
	if (realpathSync(topLevel) !== checkout)
		throw new Error(`Checkout must be the root of a Git worktree: ${requestedCheckout}`);
	const inside = await runner.run("git", ["-C", checkout, "rev-parse", "--is-inside-work-tree"], checkout);
	if (inside !== "true") throw new Error(`Checkout is not a Git worktree: ${checkout}`);
	const status = await runner.run(
		"git",
		["-C", checkout, "status", "--porcelain=v1", "--untracked-files=all"],
		checkout,
	);
	if (status)
		throw new Error("Checkout has tracked or untracked changes; commit, stash, or remove them before updating.");
	const head = await runner.run("git", ["-C", checkout, "rev-parse", "--verify", "HEAD^{commit}"], checkout);
	requireExpectedWorkspace(checkout);
	return { checkout, head };
}

function checkoutVersion(checkout: string, head: string): string {
	const version = String(readPackageJson(join(checkout, "package.json")).version ?? "");
	if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
		throw new Error(`Invalid checkout package version: ${version}`);
	}
	return `${version.split("+")[0]}-checkout.${head.slice(0, 12)}`;
}

function copyReleaseContents(source: string, target: string): void {
	mkdirSync(target, { recursive: true });
	for (const entry of ["dist", "docs", "examples", "skills", "postinstall.cjs", "README.md", "CHANGELOG.md"]) {
		const path = join(source, entry);
		if (existsSync(path)) cpSync(path, join(target, entry), { recursive: true });
	}
}

async function npmPack(directory: string, destination: string, runner: CheckoutCommandRunner): Promise<string> {
	const output = await runner.run(
		"npm",
		["pack", directory, "--pack-destination", destination, "--silent"],
		directory,
	);
	const name = output.split("\n").at(-1);
	if (!name) throw new Error(`npm pack did not report an artifact for ${directory}`);
	const artifact = join(destination, basename(name));
	if (!existsSync(artifact) || !statSync(artifact).isFile()) throw new Error(`npm pack did not create ${artifact}`);
	return artifact;
}

function rewriteInternalDependencies(
	dependencies: Record<string, string> | undefined,
	internalPackageUrls: ReadonlyMap<string, string>,
): Record<string, string> | undefined {
	if (!dependencies) return undefined;
	return Object.fromEntries(
		Object.entries(dependencies).map(([name, range]) => [name, internalPackageUrls.get(name) ?? range]),
	);
}

function releaseManifest(
	source: Record<string, unknown>,
	version: string,
	internalPackageUrls: ReadonlyMap<string, string>,
): Record<string, unknown> {
	const manifest: Record<string, unknown> = {
		...source,
		version,
		dependencies: rewriteInternalDependencies(
			source.dependencies as Record<string, string> | undefined,
			internalPackageUrls,
		),
		optionalDependencies: rewriteInternalDependencies(
			source.optionalDependencies as Record<string, string> | undefined,
			internalPackageUrls,
		),
	};
	if (source.scripts && typeof source.scripts === "object" && "postinstall" in source.scripts) {
		manifest.scripts = { postinstall: (source.scripts as Record<string, unknown>).postinstall };
	} else {
		delete manifest.scripts;
	}
	delete manifest.devDependencies;
	delete manifest.overrides;
	delete manifest.private;
	return manifest;
}

async function createCommittedSourceStage(
	checkout: string,
	head: string,
	stage: string,
	runner: CheckoutCommandRunner,
): Promise<string> {
	const source = join(stage, "source");
	await runner.run("git", ["clone", "--no-checkout", checkout, source], stage);
	await runner.run("git", ["-C", source, "checkout", "--detach", head], stage);
	await runner.run("npm", ["ci", "--ignore-scripts"], source);
	await runner.run("npm", ["run", "build"], packageDir(source, "tui"));
	await runner.run(
		process.execPath,
		[join(source, "node_modules", ".bin", "tsgo"), "-p", "tsconfig.build.json"],
		packageDir(source, "ai"),
	);
	await runner.run("npm", ["run", "build"], packageDir(source, "agent"));
	await runner.run("npm", ["run", "build"], packageDir(source, "coding-agent"));
	return source;
}

/**
 * Builds a disposable copy of the validated commit. The source checkout is never used as a build
 * directory, and internal tarballs are referenced by absolute paths that remain live through npm install.
 */
export async function buildCheckoutUpdateArtifact(
	checkoutPath: string,
	runner: CheckoutCommandRunner = systemRunner,
): Promise<CheckoutUpdateArtifact> {
	const { checkout, head } = await validatePrimeAgentCheckout(checkoutPath, runner);
	const stage = mkdtempSync(join(tmpdir(), "prime-agent-checkout-update-"));
	try {
		const sourceRoot = await createCommittedSourceStage(checkout, head, stage, runner);
		const afterBuild = await validatePrimeAgentCheckout(checkout, runner);
		if (afterBuild.head !== head) {
			throw new Error(
				"Checkout changed while the isolated build was running; retry from a clean committed checkout.",
			);
		}
		const version = checkoutVersion(sourceRoot, head);
		const artifacts = join(stage, "artifacts");
		mkdirSync(artifacts, { recursive: true });
		const sourceManifests = new Map<InternalPackage, Record<string, unknown>>();
		const internalPackageUrls = new Map<string, string>();
		for (const pkg of INTERNAL_PACKAGES) {
			const manifest = readPackageJson(join(packageDir(sourceRoot, pkg), "package.json"));
			sourceManifests.set(pkg, manifest);
			const packageName = pkg === "coding-agent" ? "prime-agent" : String(manifest.name);
			const filename = `${packageName.replace("@", "").replace("/", "-")}-${version}.tgz`;
			internalPackageUrls.set(String(manifest.name), `file:${join(artifacts, filename)}`);
		}
		for (const pkg of INTERNAL_PACKAGES) {
			const source = packageDir(sourceRoot, pkg);
			const staged = join(stage, "packages", pkg);
			copyReleaseContents(source, staged);
			const manifest = releaseManifest(sourceManifests.get(pkg)!, version, internalPackageUrls);
			if (pkg === "coding-agent") {
				manifest.name = "prime-agent";
				manifest.bin = { "prime-agent": "dist/bundle/cli.js" };
				manifest.piConfig = {
					...(manifest.piConfig as Record<string, unknown> | undefined),
					name: "prime-agent",
					configDir: ".prime/agent",
				};
			}
			writePackageJson(join(staged, "package.json"), manifest);
			const tarball = await npmPack(staged, artifacts, runner);
			const expectedPath = internalPackageUrls.get(String(sourceManifests.get(pkg)!.name))!.slice("file:".length);
			if (tarball !== expectedPath) throw new Error(`npm pack created unexpected artifact name: ${tarball}`);
		}
		const artifactPath = internalPackageUrls
			.get(String(sourceManifests.get("coding-agent")!.name))!
			.slice("file:".length);
		return { artifactPath, version, cleanup: () => rmSync(stage, { recursive: true, force: true }) };
	} catch (error) {
		rmSync(stage, { recursive: true, force: true });
		throw error;
	}
}

import { spawn } from "node:child_process";
import { accessSync, constants, mkdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { getLogger } from "@earendil-works/pi-ai";
import { type AwsSsoSessionStatus, readAwsSsoSessionStatus } from "@earendil-works/pi-ai/aws-sso";
import lockfile from "proper-lockfile";

/**
 * Automatic recovery from an expired AWS IAM Identity Center (SSO) session for
 * the Bedrock and Bedrock Mantle providers.
 *
 * The AWS SDK refreshes an SSO token silently while a refresh token is still
 * valid; once it is not, only an interactive browser sign-in can recover, and
 * every Bedrock request fails until someone runs `aws sso login`. This service
 * runs that login on the user's behalf, single-flighted per process and across
 * processes so a fleet of sibling agents produces exactly one browser window.
 */

const log = getLogger("coding-agent.aws-sso");

/** Matches the AWS SDK's own pre-expiry window (`EXPIRE_WINDOW_MS`). */
export const AWS_SSO_MIN_REMAINING_SECONDS = 300;
/** Bounded wait for a human to approve the browser sign-in. */
export const AWS_SSO_LOGIN_TIMEOUT_MS = 180_000;
/** One automatic refresh per process per window, so a broken profile cannot loop browser windows. */
export const AWS_SSO_REFRESH_COOLDOWN_MS = 600_000;
const AWS_SSO_POLL_INTERVAL_MS = 1_000;
/** Cross-process single-flight lock: one browser sign-in per host, shared by every agent process. */
export const AWS_SSO_REFRESH_LOCK_FILE_NAME = "aws-sso-refresh.lock";
/** Slightly above the login timeout so a killed holder cannot block the next attempt forever. */
const LOCK_STALE_MS = AWS_SSO_LOGIN_TIMEOUT_MS + 60_000;

export type AwsSsoRefreshReason = "preflight" | "expired";

/** APIs that sign every request with ambient AWS credentials, including custom Bedrock providers. */
export function isBedrockApi(api: string): boolean {
	return api === "bedrock-converse-stream" || api === "bedrock-mantle-responses";
}

export type AwsSsoRefreshStatus =
	| "refreshed"
	| "already_valid"
	/** Preflight only: the token is stale but the AWS SDK can still refresh it silently. */
	| "deferred"
	| "not_sso"
	| "disabled"
	| "cooldown"
	| "cli_missing"
	| "login_failed"
	| "timeout";

export interface AwsSsoRefreshOutcome {
	status: AwsSsoRefreshStatus;
	profile?: string;
	/** One actionable line, present for every status that leaves the session unusable. */
	message?: string;
}

export interface AwsSsoRefreshProgress {
	phase: "started" | "waiting" | "finished";
	profile: string;
	reason: AwsSsoRefreshReason;
	status?: AwsSsoRefreshStatus;
	message?: string;
}

export interface AwsSsoLoginProcess {
	/** Resolves when the login process exits; never resolves while the sign-in is pending. */
	readonly exitCode: Promise<number | null>;
}

/** Seams for tests: the production defaults read the real AWS config and spawn the real CLI. */
export interface AwsSsoRefresherInternals {
	env?: NodeJS.ProcessEnv;
	now?: () => number;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	readStatus?: (profile?: string) => Promise<AwsSsoSessionStatus>;
	resolveCli?: () => string | undefined;
	spawnLogin?: (cli: string, profile: string) => AwsSsoLoginProcess;
	/** Resolves to a release function, or undefined when another process holds the lock. */
	acquireLock?: (path: string) => Promise<(() => Promise<void>) | undefined>;
}

export interface AwsSsoRefresherOptions {
	settingsManager: { getBedrockAutoSsoRefresh: () => boolean };
	agentDir: string;
	onEvent?: (event: AwsSsoRefreshProgress) => void;
	internals?: AwsSsoRefresherInternals;
}

export interface AwsSsoRefresher {
	ensureFresh(reason: AwsSsoRefreshReason, options?: { signal?: AbortSignal }): Promise<AwsSsoRefreshOutcome>;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** `aws` on PATH, resolved without shelling out. */
function defaultResolveCli(env: NodeJS.ProcessEnv): string | undefined {
	const pathValue = env.PATH ?? env.Path ?? env.path;
	if (!pathValue) return undefined;
	const candidates = process.platform === "win32" ? ["aws.exe", "aws.cmd", "aws.bat", "aws"] : ["aws"];
	for (const directory of pathValue.split(delimiter)) {
		if (!directory) continue;
		for (const candidate of candidates) {
			const executable = join(directory, candidate);
			try {
				accessSync(executable, constants.X_OK);
				return executable;
			} catch {
				// Not executable here; keep scanning PATH.
			}
		}
	}
	return undefined;
}

function defaultSpawnLogin(cli: string, profile: string): AwsSsoLoginProcess {
	// Detached with ignored stdio: the AWS CLI opens the browser itself, and the
	// agent turn must never block on terminal input or have its TUI overwritten.
	const child = spawn(cli, ["sso", "login", "--profile", profile], {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
	const exitCode = new Promise<number | null>((resolve) => {
		child.once("exit", (code) => resolve(code));
		child.once("error", () => resolve(null));
	});
	return { exitCode };
}

async function defaultAcquireLock(path: string): Promise<(() => Promise<void>) | undefined> {
	try {
		const release = await lockfile.lock(path, { realpath: false, retries: 0, stale: LOCK_STALE_MS });
		return async () => {
			try {
				await release();
			} catch {
				// A stale-lock takeover elsewhere already removed it; nothing to release.
			}
		};
	} catch {
		return undefined;
	}
}

/** Env-provided credentials that take precedence over an SSO profile, or replace it entirely. */
function hasNonSsoCredentialSource(env: NodeJS.ProcessEnv): boolean {
	return Boolean(
		env.AWS_BEDROCK_SKIP_AUTH === "1" ||
			env.AWS_BEARER_TOKEN_BEDROCK ||
			(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) ||
			env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
			env.AWS_CONTAINER_CREDENTIALS_FULL_URI ||
			env.AWS_WEB_IDENTITY_TOKEN_FILE,
	);
}

function loginCommand(profile: string): string {
	return `aws sso login --profile ${profile}`;
}

export function createAwsSsoRefresher(options: AwsSsoRefresherOptions): AwsSsoRefresher {
	const internals = options.internals ?? {};
	const env = internals.env ?? process.env;
	const now = internals.now ?? Date.now;
	const sleep = internals.sleep ?? defaultSleep;
	const readStatus = internals.readStatus ?? ((profile?: string) => readAwsSsoSessionStatus(profile));
	const resolveCli = internals.resolveCli ?? (() => defaultResolveCli(env));
	const spawnLogin = internals.spawnLogin ?? defaultSpawnLogin;
	const acquireLock = internals.acquireLock ?? defaultAcquireLock;
	const lockPath = join(options.agentDir, AWS_SSO_REFRESH_LOCK_FILE_NAME);

	let lastAttemptAt: number | undefined;
	let inFlight: Promise<AwsSsoRefreshOutcome> | undefined;

	function emit(event: AwsSsoRefreshProgress): void {
		options.onEvent?.(event);
	}

	function tokenIsUsable(status: AwsSsoSessionStatus): boolean {
		return !status.expired && (status.secondsRemaining ?? 0) > AWS_SSO_MIN_REMAINING_SECONDS;
	}

	/**
	 * The AWS SDK silently refreshes an SSO token inside its own expiry window
	 * whenever the cached refresh grant is still present, so a browser sign-in
	 * before the request would open a window the SDK did not need. The preflight
	 * therefore only signs in when nothing is left to refresh with; a refresh
	 * grant that the SDK tries and fails is caught by the post-failure path.
	 */
	function needsBrowserLogin(status: AwsSsoSessionStatus, reason: AwsSsoRefreshReason): boolean {
		if (tokenIsUsable(status)) return false;
		return reason === "expired" || !status.refreshable;
	}

	async function waitForFreshToken(
		profile: string,
		reason: AwsSsoRefreshReason,
		login: AwsSsoLoginProcess | undefined,
		signal?: AbortSignal,
	): Promise<AwsSsoRefreshOutcome> {
		let exited: { code: number | null } | undefined;
		void login?.exitCode.then((code) => {
			exited = { code };
		});

		const deadline = now() + AWS_SSO_LOGIN_TIMEOUT_MS;
		emit({ phase: "waiting", profile, reason });

		while (now() < deadline) {
			if (signal?.aborted) {
				return {
					status: "timeout",
					profile,
					message: `AWS SSO sign-in for profile "${profile}" was cancelled. Run: ${loginCommand(profile)}`,
				};
			}
			await sleep(AWS_SSO_POLL_INTERVAL_MS, signal);
			const status = await readStatus(profile);
			if (tokenIsUsable(status)) {
				return { status: "refreshed", profile };
			}
			if (exited) {
				return {
					status: "login_failed",
					profile,
					message:
						exited.code === 0
							? `AWS SSO sign-in for profile "${profile}" finished without a usable token. Run: ${loginCommand(profile)}`
							: `AWS SSO sign-in for profile "${profile}" failed. Run: ${loginCommand(profile)}`,
				};
			}
		}

		const seconds = Math.round(AWS_SSO_LOGIN_TIMEOUT_MS / 1000);
		return {
			status: "timeout",
			profile,
			message: `AWS SSO sign-in for profile "${profile}" did not complete within ${seconds}s. Run: ${loginCommand(profile)}`,
		};
	}

	async function refresh(
		profile: string,
		reason: AwsSsoRefreshReason,
		signal?: AbortSignal,
	): Promise<AwsSsoRefreshOutcome> {
		if (signal?.aborted) {
			return {
				status: "timeout",
				profile,
				message: `AWS SSO sign-in for profile "${profile}" was cancelled. Run: ${loginCommand(profile)}`,
			};
		}
		lastAttemptAt = now();
		emit({ phase: "started", profile, reason });

		try {
			mkdirSync(options.agentDir, { recursive: true });
		} catch {
			// The lock directory is best effort; a failure here surfaces as a lock miss below.
		}

		const release = await acquireLock(lockPath);
		try {
			if (!release) {
				// Another process is signing in: ride its login instead of opening a second window.
				log.info("waiting for another process to refresh the AWS SSO session", { profile, reason });
				return await waitForFreshToken(profile, reason, undefined, signal);
			}

			const cli = resolveCli();
			if (!cli) {
				return {
					status: "cli_missing",
					profile,
					message:
						`AWS SSO session for profile "${profile}" needs a browser sign-in, but the AWS CLI ` +
						`was not found on PATH. Install the AWS CLI, or run: ${loginCommand(profile)}`,
				};
			}

			log.info("refreshing the AWS SSO session", { profile, reason, cli });
			const login = spawnLogin(cli, profile);
			return await waitForFreshToken(profile, reason, login, signal);
		} finally {
			await release?.();
		}
	}

	return {
		async ensureFresh(reason, callOptions): Promise<AwsSsoRefreshOutcome> {
			const profileHint = env.AWS_PROFILE?.trim() || undefined;

			if (!options.settingsManager.getBedrockAutoSsoRefresh()) {
				const profile = profileHint ?? "default";
				return {
					status: "disabled",
					profile,
					message:
						`AWS SSO session for profile "${profile}" needs a browser sign-in, but automatic ` +
						`refresh is disabled (bedrock.autoSsoRefresh). Run: ${loginCommand(profile)}`,
				};
			}

			if (hasNonSsoCredentialSource(env)) {
				return { status: "not_sso" };
			}

			const status = await readStatus(profileHint);
			if (!status.ssoBacked) {
				return { status: "not_sso", profile: status.profile };
			}
			if (tokenIsUsable(status)) {
				return { status: "already_valid", profile: status.profile };
			}
			if (!needsBrowserLogin(status, reason)) {
				return { status: "deferred", profile: status.profile };
			}

			if (inFlight) {
				return await inFlight;
			}

			if (lastAttemptAt !== undefined && now() - lastAttemptAt < AWS_SSO_REFRESH_COOLDOWN_MS) {
				const minutes = Math.round(AWS_SSO_REFRESH_COOLDOWN_MS / 60_000);
				return {
					status: "cooldown",
					profile: status.profile,
					message:
						`AWS SSO session for profile "${status.profile}" is not usable and a refresh was already ` +
						`attempted in the last ${minutes} minutes. Run: ${loginCommand(status.profile)}`,
				};
			}

			const pending = refresh(status.profile, reason, callOptions?.signal);
			inFlight = pending;
			try {
				const outcome = await pending;
				emit({
					phase: "finished",
					profile: status.profile,
					reason,
					status: outcome.status,
					message: outcome.message,
				});
				return outcome;
			} finally {
				inFlight = undefined;
			}
		},
	};
}

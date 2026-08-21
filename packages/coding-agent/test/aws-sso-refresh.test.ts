import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AwsSsoSessionStatus } from "@earendil-works/pi-ai/aws-sso";
import { lockSync } from "proper-lockfile";
import { afterEach, describe, expect, it } from "vitest";
import {
	AWS_SSO_LOGIN_TIMEOUT_MS,
	AWS_SSO_MIN_REMAINING_SECONDS,
	AWS_SSO_REFRESH_COOLDOWN_MS,
	AWS_SSO_REFRESH_LOCK_FILE_NAME,
	type AwsSsoLoginProcess,
	type AwsSsoRefresherInternals,
	type AwsSsoRefreshProgress,
	createAwsSsoRefresher,
} from "../src/core/aws-sso-refresh.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "prime-aws-sso-refresh-"));
	tempDirs.push(directory);
	return directory;
}

function ssoStatus(secondsRemaining: number | undefined, overrides: Partial<AwsSsoSessionStatus> = {}) {
	return {
		profile: "bedrock",
		ssoSession: "corp",
		ssoBacked: true,
		expiresAt: secondsRemaining === undefined ? undefined : new Date(Date.now() + secondsRemaining * 1000),
		secondsRemaining,
		expired: secondsRemaining === undefined ? true : secondsRemaining <= 0,
		// Default to a session only a browser sign-in can restore; the SDK-refreshable
		// case is opted into explicitly.
		refreshable: false,
		...overrides,
	} satisfies AwsSsoSessionStatus;
}

interface Fixture {
	spawns: Array<{ cli: string; profile: string }>;
	events: AwsSsoRefreshProgress[];
	internals: AwsSsoRefresherInternals;
	setStatus: (status: AwsSsoSessionStatus) => void;
	advance: (ms: number) => void;
}

interface FixtureOptions {
	status?: AwsSsoSessionStatus;
	/** Status returned once the login process has been observed to finish. */
	statusAfterLogin?: AwsSsoSessionStatus;
	loginExitCode?: number | null;
	/** Simulate a sign-in the user never approves: the CLI process never exits. */
	loginNeverExits?: boolean;
	cli?: string | undefined;
	env?: NodeJS.ProcessEnv;
	/** Simulate another process holding the cross-process lock. */
	lockHeldElsewhere?: boolean;
}

function createFixture(options: FixtureOptions = {}): Fixture {
	let status = options.status ?? ssoStatus(-60);
	let clock = 1_000_000;
	let polls = 0;
	const spawns: Array<{ cli: string; profile: string }> = [];
	const events: AwsSsoRefreshProgress[] = [];

	const internals: AwsSsoRefresherInternals = {
		env: options.env ?? {},
		now: () => clock,
		sleep: async (ms: number) => {
			clock += ms;
			polls++;
			if (polls === 1 && options.statusAfterLogin) status = options.statusAfterLogin;
		},
		readStatus: async () => status,
		resolveCli: () => ("cli" in options ? options.cli : "/usr/local/bin/aws"),
		spawnLogin: (cli: string, profile: string): AwsSsoLoginProcess => {
			spawns.push({ cli, profile });
			return {
				exitCode: options.loginNeverExits
					? new Promise<number | null>(() => {})
					: Promise.resolve(options.loginExitCode ?? 0),
			};
		},
		acquireLock: async () => (options.lockHeldElsewhere ? undefined : async () => {}),
	};

	return {
		spawns,
		events,
		internals,
		setStatus: (next) => {
			status = next;
		},
		advance: (ms) => {
			clock += ms;
		},
	};
}

function createRefresher(fixture: Fixture, autoRefresh = true, agentDir = createTempDir()) {
	return createAwsSsoRefresher({
		agentDir,
		settingsManager: { getBedrockAutoSsoRefresh: () => autoRefresh },
		onEvent: (event) => fixture.events.push(event),
		internals: fixture.internals,
	});
}

describe("createAwsSsoRefresher", () => {
	it("refreshes an expired SSO session and reports the login it launched", async () => {
		const fixture = createFixture({ statusAfterLogin: ssoStatus(28800) });
		const refresher = createRefresher(fixture);

		const outcome = await refresher.ensureFresh("expired");

		expect(outcome.status).toBe("refreshed");
		expect(outcome.profile).toBe("bedrock");
		expect(fixture.spawns).toEqual([{ cli: "/usr/local/bin/aws", profile: "bedrock" }]);
		expect(fixture.events.map((event) => event.phase)).toContain("started");
		expect(fixture.events.at(-1)).toMatchObject({ phase: "finished", status: "refreshed" });
	});

	it("skips work when the token still has more than the expiry window left", async () => {
		const fixture = createFixture({ status: ssoStatus(AWS_SSO_MIN_REMAINING_SECONDS + 60) });
		const refresher = createRefresher(fixture);

		expect((await refresher.ensureFresh("preflight")).status).toBe("already_valid");
		expect(fixture.spawns).toEqual([]);
		expect(fixture.events).toEqual([]);
	});

	it("refreshes proactively when nothing is left for the AWS SDK to refresh with", async () => {
		const fixture = createFixture({
			status: ssoStatus(AWS_SSO_MIN_REMAINING_SECONDS - 60, { refreshable: false }),
			statusAfterLogin: ssoStatus(28800),
		});
		const refresher = createRefresher(fixture);

		expect((await refresher.ensureFresh("preflight")).status).toBe("refreshed");
		expect(fixture.spawns).toHaveLength(1);
	});

	it("defers to the AWS SDK's silent refresh instead of opening a browser before the request", async () => {
		const insideWindow = createFixture({
			status: ssoStatus(AWS_SSO_MIN_REMAINING_SECONDS - 60, { refreshable: true }),
		});
		expect((await createRefresher(insideWindow).ensureFresh("preflight")).status).toBe("deferred");
		expect(insideWindow.spawns).toEqual([]);

		const alreadyExpired = createFixture({ status: ssoStatus(-60, { refreshable: true }) });
		expect((await createRefresher(alreadyExpired).ensureFresh("preflight")).status).toBe("deferred");
		expect(alreadyExpired.spawns).toEqual([]);
	});

	it("still signs in after a failed request even when a refresh grant is present", async () => {
		const fixture = createFixture({
			status: ssoStatus(-60, { refreshable: true }),
			statusAfterLogin: ssoStatus(28800),
		});

		expect((await createRefresher(fixture).ensureFresh("expired")).status).toBe("refreshed");
		expect(fixture.spawns).toHaveLength(1);
	});

	it("never spawns for non-SSO credential sources", async () => {
		const staticKeys = createFixture({
			env: { AWS_ACCESS_KEY_ID: "AKIA", AWS_SECRET_ACCESS_KEY: "secret" },
		});
		expect((await createRefresher(staticKeys).ensureFresh("expired")).status).toBe("not_sso");

		const bearer = createFixture({ env: { AWS_BEARER_TOKEN_BEDROCK: "token" } });
		expect((await createRefresher(bearer).ensureFresh("expired")).status).toBe("not_sso");

		const skipAuth = createFixture({ env: { AWS_BEDROCK_SKIP_AUTH: "1" } });
		expect((await createRefresher(skipAuth).ensureFresh("expired")).status).toBe("not_sso");

		const containerRole = createFixture({ env: { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/creds" } });
		expect((await createRefresher(containerRole).ensureFresh("expired")).status).toBe("not_sso");

		const notSsoProfile = createFixture({
			status: { profile: "static", ssoBacked: false, expired: false, refreshable: false },
		});
		expect((await createRefresher(notSsoProfile).ensureFresh("expired")).status).toBe("not_sso");

		expect([...staticKeys.spawns, ...bearer.spawns, ...skipAuth.spawns, ...notSsoProfile.spawns]).toEqual([]);
	});

	it("does nothing but explain itself when the setting is disabled", async () => {
		const fixture = createFixture();
		const refresher = createRefresher(fixture, false);

		const outcome = await refresher.ensureFresh("expired");

		expect(outcome.status).toBe("disabled");
		expect(outcome.message).toContain("bedrock.autoSsoRefresh");
		expect(fixture.spawns).toEqual([]);
	});

	it("reports a missing AWS CLI once instead of spawning a login loop", async () => {
		const fixture = createFixture({ cli: undefined });
		const refresher = createRefresher(fixture);

		const outcome = await refresher.ensureFresh("expired");

		expect(outcome.status).toBe("cli_missing");
		expect(outcome.message).toContain("aws sso login --profile bedrock");
		expect(fixture.spawns).toEqual([]);
	});

	it("reports a failed login when the AWS CLI exits nonzero", async () => {
		const fixture = createFixture({ loginExitCode: 1 });
		const refresher = createRefresher(fixture);

		const outcome = await refresher.ensureFresh("expired");

		expect(outcome.status).toBe("login_failed");
		expect(outcome.message).toContain("aws sso login --profile bedrock");
	});

	it("times out when the sign-in is never approved", async () => {
		const fixture = createFixture({ loginNeverExits: true });
		const refresher = createRefresher(fixture);

		const outcome = await refresher.ensureFresh("expired");

		expect(outcome.status).toBe("timeout");
		expect(outcome.message).toContain(`${Math.round(AWS_SSO_LOGIN_TIMEOUT_MS / 1000)}`);
	});

	it("enforces the per-process cooldown so a broken profile cannot loop browser windows", async () => {
		const fixture = createFixture({ loginExitCode: 1 });
		const refresher = createRefresher(fixture);

		expect((await refresher.ensureFresh("expired")).status).toBe("login_failed");
		expect((await refresher.ensureFresh("expired")).status).toBe("cooldown");
		expect(fixture.spawns).toHaveLength(1);

		fixture.advance(AWS_SSO_REFRESH_COOLDOWN_MS + 1);
		expect((await refresher.ensureFresh("expired")).status).toBe("login_failed");
		expect(fixture.spawns).toHaveLength(2);
	});

	it("waits for the lock holder's login instead of starting a second one", async () => {
		const fixture = createFixture({ lockHeldElsewhere: true, statusAfterLogin: ssoStatus(28800) });
		const refresher = createRefresher(fixture);

		const outcome = await refresher.ensureFresh("expired");

		expect(outcome.status).toBe("refreshed");
		expect(fixture.spawns).toEqual([]);
	});

	it("reports a timeout for a lock waiter whose holder never completes the login", async () => {
		const fixture = createFixture({ lockHeldElsewhere: true });
		const refresher = createRefresher(fixture);

		expect((await refresher.ensureFresh("expired")).status).toBe("timeout");
		expect(fixture.spawns).toEqual([]);
	});

	it("shares one in-flight refresh between concurrent callers", async () => {
		const fixture = createFixture({ statusAfterLogin: ssoStatus(28800) });
		const refresher = createRefresher(fixture);

		const [first, second] = await Promise.all([refresher.ensureFresh("expired"), refresher.ensureFresh("preflight")]);

		expect(first.status).toBe("refreshed");
		expect(second.status).toBe("refreshed");
		expect(fixture.spawns).toHaveLength(1);
	});

	it("stops waiting when the caller aborts", async () => {
		const fixture = createFixture({ loginNeverExits: true });
		const refresher = createRefresher(fixture);
		const controller = new AbortController();
		controller.abort();

		const outcome = await refresher.ensureFresh("expired", { signal: controller.signal });

		expect(outcome.status).toBe("timeout");
		expect(outcome.message).toContain("cancelled");
		expect(fixture.spawns).toEqual([]);
	});

	it("treats a token another process already refreshed as valid", async () => {
		const fixture = createFixture({ status: ssoStatus(28800) });
		const refresher = createRefresher(fixture);

		expect((await refresher.ensureFresh("expired")).status).toBe("already_valid");
		expect(fixture.spawns).toEqual([]);
	});

	it("rides another process's sign-in when the real lock file is already held", async () => {
		const agentDir = createTempDir();
		const fixture = createFixture({ statusAfterLogin: ssoStatus(28800) });
		// Exercise the production lock path, not the injected one.
		delete fixture.internals.acquireLock;
		const release = lockSync(join(agentDir, AWS_SSO_REFRESH_LOCK_FILE_NAME), { realpath: false });
		try {
			const outcome = await createRefresher(fixture, true, agentDir).ensureFresh("expired");
			expect(outcome.status).toBe("refreshed");
			expect(fixture.spawns).toEqual([]);
		} finally {
			release();
		}
	});

	it("acquires the real lock file and releases it when the sign-in completes", async () => {
		const agentDir = createTempDir();
		const fixture = createFixture({ statusAfterLogin: ssoStatus(28800) });
		delete fixture.internals.acquireLock;

		const outcome = await createRefresher(fixture, true, agentDir).ensureFresh("expired");

		expect(outcome.status).toBe("refreshed");
		expect(fixture.spawns).toHaveLength(1);
		// Released: a later holder can take the same lock.
		const release = lockSync(join(agentDir, AWS_SSO_REFRESH_LOCK_FILE_NAME), { realpath: false });
		release();
	});
});

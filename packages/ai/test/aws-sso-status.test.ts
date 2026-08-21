import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAwsSsoSessionStatus } from "../src/aws-sso.js";

const tempHomes: string[] = [];

afterEach(() => {
	while (tempHomes.length > 0) {
		const dir = tempHomes.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

interface FixtureOptions {
	config: string;
	/** Cache id (sso session name or legacy start url) -> ISO expiry, or null to skip writing. */
	cache?: { id: string; expiresAt: string | null; refreshable?: boolean };
}

function createAwsHome(options: FixtureOptions): string {
	const home = mkdtempSync(join(tmpdir(), "pi-aws-sso-"));
	tempHomes.push(home);
	mkdirSync(join(home, ".aws", "sso", "cache"), { recursive: true });
	writeFileSync(join(home, ".aws", "config"), options.config, "utf-8");
	if (options.cache && options.cache.expiresAt !== null) {
		const cacheName = createHash("sha1").update(options.cache.id).digest("hex");
		writeFileSync(
			join(home, ".aws", "sso", "cache", `${cacheName}.json`),
			JSON.stringify({
				accessToken: "token-value",
				expiresAt: options.cache.expiresAt,
				region: "us-east-1",
				startUrl: "https://example.awsapps.com/start",
				...(options.cache.refreshable === false
					? {}
					: { clientId: "client-id", clientSecret: "client-secret", refreshToken: "refresh-token" }),
			}),
			"utf-8",
		);
	}
	return home;
}

const SSO_CONFIG = `[profile bedrock]
sso_session = corp
sso_account_id = 111122223333
sso_role_name = BedrockUser
region = us-west-2

[sso-session corp]
sso_start_url = https://example.awsapps.com/start
sso_region = us-east-1

[profile static]
aws_access_key_id = AKIAIOSFODNN7EXAMPLE
aws_secret_access_key = secret
`;

function isoIn(seconds: number): string {
	return new Date(Date.now() + seconds * 1000).toISOString();
}

describe("readAwsSsoSessionStatus", () => {
	it("reports a valid sso-session token", async () => {
		const home = createAwsHome({ config: SSO_CONFIG, cache: { id: "corp", expiresAt: isoIn(3600) } });
		const status = await readAwsSsoSessionStatus("bedrock", { home });
		expect(status.profile).toBe("bedrock");
		expect(status.ssoSession).toBe("corp");
		expect(status.ssoBacked).toBe(true);
		expect(status.expired).toBe(false);
		expect(status.secondsRemaining ?? 0).toBeGreaterThan(3500);
		expect(status.expiresAt?.toISOString()).toBeDefined();
		expect(status.refreshable).toBe(true);
	});

	it("reports a token that is inside the expiry window but not yet expired", async () => {
		const home = createAwsHome({ config: SSO_CONFIG, cache: { id: "corp", expiresAt: isoIn(60) } });
		const status = await readAwsSsoSessionStatus("bedrock", { home });
		expect(status.expired).toBe(false);
		expect(status.secondsRemaining ?? 0).toBeLessThan(120);
	});

	it("reports an expired token", async () => {
		const home = createAwsHome({ config: SSO_CONFIG, cache: { id: "corp", expiresAt: isoIn(-60) } });
		const status = await readAwsSsoSessionStatus("bedrock", { home });
		expect(status.ssoBacked).toBe(true);
		expect(status.expired).toBe(true);
		expect(status.secondsRemaining ?? 0).toBeLessThanOrEqual(0);
	});

	it("reports a token the AWS SDK can no longer refresh silently", async () => {
		const home = createAwsHome({
			config: SSO_CONFIG,
			cache: { id: "corp", expiresAt: isoIn(-60), refreshable: false },
		});
		const status = await readAwsSsoSessionStatus("bedrock", { home });
		expect(status.expired).toBe(true);
		expect(status.refreshable).toBe(false);
	});

	it("treats a missing cache file as expired", async () => {
		const home = createAwsHome({ config: SSO_CONFIG, cache: { id: "corp", expiresAt: null } });
		const status = await readAwsSsoSessionStatus("bedrock", { home });
		expect(status.ssoBacked).toBe(true);
		expect(status.expiresAt).toBeUndefined();
		expect(status.secondsRemaining).toBeUndefined();
		expect(status.expired).toBe(true);
		expect(status.refreshable).toBe(false);
	});

	it("supports legacy sso_start_url profiles keyed by start url", async () => {
		const legacyConfig = `[profile legacy]
sso_start_url = https://example.awsapps.com/start
sso_region = us-east-1
sso_account_id = 111122223333
sso_role_name = BedrockUser
`;
		const home = createAwsHome({
			config: legacyConfig,
			cache: { id: "https://example.awsapps.com/start", expiresAt: isoIn(1800) },
		});
		const status = await readAwsSsoSessionStatus("legacy", { home });
		expect(status.ssoBacked).toBe(true);
		expect(status.ssoSession).toBeUndefined();
		expect(status.expired).toBe(false);
	});

	it("reports non-SSO profiles as not sso-backed", async () => {
		const home = createAwsHome({ config: SSO_CONFIG });
		const status = await readAwsSsoSessionStatus("static", { home });
		expect(status.ssoBacked).toBe(false);
		expect(status.expired).toBe(false);
	});

	it("reports an unknown profile as not sso-backed", async () => {
		const home = createAwsHome({ config: SSO_CONFIG });
		const status = await readAwsSsoSessionStatus("missing", { home });
		expect(status.profile).toBe("missing");
		expect(status.ssoBacked).toBe(false);
	});

	it("falls back to AWS_PROFILE and then the default profile", async () => {
		const home = createAwsHome({ config: SSO_CONFIG, cache: { id: "corp", expiresAt: isoIn(3600) } });
		const previous = process.env.AWS_PROFILE;
		process.env.AWS_PROFILE = "bedrock";
		try {
			const status = await readAwsSsoSessionStatus(undefined, { home });
			expect(status.profile).toBe("bedrock");
			expect(status.ssoBacked).toBe(true);
		} finally {
			if (previous === undefined) delete process.env.AWS_PROFILE;
			else process.env.AWS_PROFILE = previous;
		}
	});
});

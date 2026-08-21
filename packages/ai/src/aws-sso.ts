import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseKnownFiles } from "@smithy/core/config";

/**
 * AWS IAM Identity Center (SSO) session inspection for the Bedrock providers.
 *
 * Reading only: nothing here spawns a process, opens a browser, calls the
 * network, or writes to `~/.aws`. The remediation side (running
 * `aws sso login`) lives in the coding agent. This module is a package subpath
 * rather than a root-barrel export because it depends on node and AWS shared
 * config loading.
 */

export { AWS_SSO_EXPIRED_ERROR_TYPE, findAwsSsoExpiryMessage, isAwsSsoExpiryError } from "./utils/aws-sso.js";

export interface AwsSsoSessionStatus {
	/** Profile the status was resolved for (explicit argument, `AWS_PROFILE`, or `default`). */
	profile: string;
	/** `sso_session` name for modern profiles; undefined for legacy `sso_start_url` profiles. */
	ssoSession?: string;
	/** False when the profile resolves to static keys, a container/web-identity role, or nothing. */
	ssoBacked: boolean;
	expiresAt?: Date;
	secondsRemaining?: number;
	/** True only for SSO-backed profiles whose cached token is missing, unreadable, or past expiry. */
	expired: boolean;
	/**
	 * True when the cached token still carries everything the AWS SDK needs to
	 * refresh it silently (`clientId`, `clientSecret`, `refreshToken`). When
	 * false, only an interactive `aws sso login` can restore the session.
	 */
	refreshable: boolean;
}

export interface ReadAwsSsoSessionStatusOptions {
	/** Overrides the resolved home directory. Used by tests; production reads the ambient AWS config. */
	home?: string;
}

const AWS_PROFILE_ENV = "AWS_PROFILE";
const DEFAULT_PROFILE = "default";

function resolveHome(home?: string): string | undefined {
	if (home) return home;
	// Mirrors @smithy/core/config getHomeDir so an overridden HOME behaves the same here.
	const { HOME, USERPROFILE, HOMEPATH, HOMEDRIVE } = process.env;
	if (HOME) return HOME;
	if (USERPROFILE) return USERPROFILE;
	if (HOMEPATH) return `${HOMEDRIVE ?? "C:\\"}${HOMEPATH}`;
	try {
		return homedir();
	} catch {
		return undefined;
	}
}

function ssoTokenFilepath(cacheId: string, home?: string): string | undefined {
	const resolved = resolveHome(home);
	if (!resolved) return undefined;
	const cacheName = createHash("sha1").update(cacheId).digest("hex");
	return join(resolved, ".aws", "sso", "cache", `${cacheName}.json`);
}

async function loadProfile(
	profileName: string,
	home?: string,
): Promise<Record<string, string | undefined> | undefined> {
	const init = home
		? { configFilepath: join(home, ".aws", "config"), filepath: join(home, ".aws", "credentials") }
		: {};
	try {
		const profiles = await parseKnownFiles(init);
		return profiles[profileName];
	} catch {
		// Unreadable or malformed shared config behaves like "no profile configured".
		return undefined;
	}
}

/**
 * Read the SSO token lifetime for a profile from `~/.aws/config` plus
 * `~/.aws/sso/cache`. No network calls; the cache file is re-read on every
 * call so a completed `aws sso login` is observed immediately.
 */
export async function readAwsSsoSessionStatus(
	profile?: string,
	options: ReadAwsSsoSessionStatusOptions = {},
): Promise<AwsSsoSessionStatus> {
	const profileName = profile?.trim() || process.env[AWS_PROFILE_ENV]?.trim() || DEFAULT_PROFILE;
	const resolved = await loadProfile(profileName, options.home);

	const ssoSession = resolved?.sso_session?.trim() || undefined;
	const ssoStartUrl = resolved?.sso_start_url?.trim() || undefined;
	const cacheId = ssoSession ?? ssoStartUrl;
	if (!cacheId) {
		return { profile: profileName, ssoBacked: false, expired: false, refreshable: false };
	}

	const unusable: AwsSsoSessionStatus = {
		profile: profileName,
		ssoSession,
		ssoBacked: true,
		expired: true,
		refreshable: false,
	};

	const filepath = ssoTokenFilepath(cacheId, options.home);
	if (!filepath) return unusable;

	try {
		const parsed = JSON.parse(await readFile(filepath, "utf-8")) as {
			expiresAt?: unknown;
			clientId?: unknown;
			clientSecret?: unknown;
			refreshToken?: unknown;
		};
		const refreshable =
			typeof parsed.clientId === "string" &&
			typeof parsed.clientSecret === "string" &&
			typeof parsed.refreshToken === "string";
		const expiresAtRaw = typeof parsed.expiresAt === "string" ? Date.parse(parsed.expiresAt) : Number.NaN;
		if (Number.isNaN(expiresAtRaw)) {
			return { ...unusable, refreshable };
		}
		const secondsRemaining = Math.floor((expiresAtRaw - Date.now()) / 1000);
		return {
			profile: profileName,
			ssoSession,
			ssoBacked: true,
			expiresAt: new Date(expiresAtRaw),
			secondsRemaining,
			expired: secondsRemaining <= 0,
			refreshable,
		};
	} catch {
		// Missing or unreadable token cache: a login is required, same as an expired token.
		return unusable;
	}
}

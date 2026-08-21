import { describe, expect, it } from "vitest";
import { isAwsSsoExpiryError } from "../src/aws-sso.js";

const TOKEN_PROVIDER_MESSAGE =
	"Token is expired. To refresh this SSO session run 'aws sso login' with the corresponding profile.";
const CREDENTIAL_PROVIDER_EXPIRED =
	"The SSO session associated with this profile has expired. To refresh this SSO session run aws sso login with the corresponding profile.";
const CREDENTIAL_PROVIDER_INVALID =
	"The SSO session associated with this profile is invalid. To refresh this SSO session run aws sso login with the corresponding profile.";
const MISSING_TOKEN_FILE =
	"The SSO session token associated with profile=bedrock was not found or is invalid. To refresh this SSO session run 'aws sso login' with the corresponding profile.";
const MISSING_REFRESH_TOKEN =
	"Value not present for 'refreshToken' in SSO Token. Cannot refresh. To refresh this SSO session run 'aws sso login' with the corresponding profile.";

function tokenProviderError(message: string): Error {
	const error = new Error(message);
	error.name = "TokenProviderError";
	return error;
}

/** Shape produced by openai/providers/bedrock/aws.js when SigV4 signing cannot resolve credentials. */
function mantleWrapped(cause: unknown): Error {
	const error = new Error(
		"Failed to resolve AWS credentials for Bedrock. Verify your AWS profile, environment variables, or runtime identity configuration and try again.",
	) as Error & { cause?: unknown };
	error.name = "OpenAIError";
	error.cause = cause;
	return error;
}

describe("isAwsSsoExpiryError", () => {
	it("detects the native Bedrock token-provider expiry error", () => {
		expect(isAwsSsoExpiryError(tokenProviderError(TOKEN_PROVIDER_MESSAGE))).toBe(true);
	});

	it("detects credential-provider-sso expiry and invalidity variants", () => {
		expect(isAwsSsoExpiryError(new Error(CREDENTIAL_PROVIDER_EXPIRED))).toBe(true);
		expect(isAwsSsoExpiryError(new Error(CREDENTIAL_PROVIDER_INVALID))).toBe(true);
		expect(isAwsSsoExpiryError(new Error(MISSING_TOKEN_FILE))).toBe(true);
		expect(isAwsSsoExpiryError(new Error(MISSING_REFRESH_TOKEN))).toBe(true);
	});

	it("sees through the Bedrock Mantle wrapper that hides the cause", () => {
		expect(isAwsSsoExpiryError(mantleWrapped(tokenProviderError(TOKEN_PROVIDER_MESSAGE)))).toBe(true);
	});

	it("walks nested cause chains", () => {
		const nested = mantleWrapped(new Error("credential resolution failed"));
		(nested.cause as Error & { cause?: unknown }).cause = tokenProviderError(CREDENTIAL_PROVIDER_EXPIRED);
		expect(isAwsSsoExpiryError(nested)).toBe(true);
	});

	it("does not loop on self-referencing cause chains", () => {
		const error = new Error("boom") as Error & { cause?: unknown };
		error.cause = error;
		expect(isAwsSsoExpiryError(error)).toBe(false);
	});

	it("ignores unrelated provider failures", () => {
		expect(isAwsSsoExpiryError(Object.assign(new Error("throttled"), { status: 429 }))).toBe(false);
		expect(isAwsSsoExpiryError(Object.assign(new Error("internal server error"), { status: 500 }))).toBe(false);
		expect(
			isAwsSsoExpiryError(
				new Error(
					"Could not find credentials for Bedrock. Pass AWS credentials to `bedrock(...)` or configure the default AWS credential chain.",
				),
			),
		).toBe(false);
		expect(isAwsSsoExpiryError(new Error("Profile 'bedrock' could not be found in shared credentials file."))).toBe(
			false,
		);
		expect(isAwsSsoExpiryError(undefined)).toBe(false);
		expect(isAwsSsoExpiryError("Token is expired.")).toBe(false);
	});

	it("accepts non-Error values carrying the SSO refresh guidance", () => {
		expect(isAwsSsoExpiryError(TOKEN_PROVIDER_MESSAGE)).toBe(true);
		expect(isAwsSsoExpiryError({ message: CREDENTIAL_PROVIDER_EXPIRED })).toBe(true);
	});
});

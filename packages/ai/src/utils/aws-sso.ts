/**
 * Pure detection of AWS IAM Identity Center (SSO) expiry in provider errors.
 *
 * Dependency-free on purpose: this module is reachable from the package root
 * barrel, so it must not pull in node or AWS SDK modules. Shared-config and
 * token-cache reading lives in `../aws-sso.ts`, and the remediation side
 * (running `aws sso login`) lives in the coding agent.
 */

/** Marker recorded as `providerErrorType` when a stream failed because the SSO token expired. */
export const AWS_SSO_EXPIRED_ERROR_TYPE = "aws_sso_token_expired";

/**
 * Every AWS SDK error whose remedy is an interactive re-login carries the SDK's
 * own refresh guidance sentence, from either `@aws-sdk/token-providers`
 * ("... run 'aws sso login' ...") or `@aws-sdk/credential-provider-sso`
 * ("... run aws sso login ..."). Errors that a re-login cannot fix (missing
 * profile, missing sso-session block, malformed SSO config) do not carry it.
 */
const SSO_REFRESH_GUIDANCE = /refresh this sso session run\s+'?aws sso login/i;

/** Bedrock Mantle hides the real cause behind an OpenAIError wrapper, so cause chains matter. */
const MAX_CAUSE_DEPTH = 5;

function errorMessageOf(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (value instanceof Error) return value.message;
	if (value && typeof value === "object") {
		const message = (value as { message?: unknown }).message;
		if (typeof message === "string") return message;
	}
	return undefined;
}

/**
 * The AWS SDK's own expiry message from `error` or its cause chain, or
 * undefined when this failure is not an SSO re-login case.
 */
export function findAwsSsoExpiryMessage(error: unknown): string | undefined {
	const seen = new Set<unknown>();
	let current: unknown = error;
	for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current !== undefined && current !== null; depth++) {
		if (seen.has(current)) break;
		seen.add(current);

		const message = errorMessageOf(current);
		if (message && SSO_REFRESH_GUIDANCE.test(message)) return message;

		current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
	}
	return undefined;
}

/** True when `error` (or anything in its cause chain) means the AWS SSO session must be re-established. */
export function isAwsSsoExpiryError(error: unknown): boolean {
	return findAwsSsoExpiryMessage(error) !== undefined;
}

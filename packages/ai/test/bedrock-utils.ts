export function hasBedrockCredentials(): boolean {
	return !!(
		process.env.AWS_PROFILE ||
		(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
		process.env.AWS_BEARER_TOKEN_BEDROCK
	);
}

/** Mantle requires AWS SigV4 credentials; bearer-token-only Bedrock auth is insufficient. */
export function hasBedrockMantleCredentials(): boolean {
	return !!(
		process.env.AWS_PROFILE ||
		(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
		process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
		process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI ||
		process.env.AWS_WEB_IDENTITY_TOKEN_FILE
	);
}

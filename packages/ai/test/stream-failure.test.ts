import { afterEach, describe, expect, test } from "vitest";
import { setLogSink } from "../src/log.js";
import type { AssistantMessage } from "../src/types.js";
import { AWS_SSO_EXPIRED_ERROR_TYPE } from "../src/utils/aws-sso.js";
import {
	classifyStreamFailure,
	extractStreamFailureInfo,
	formatStreamFailureMessage,
	recordStreamFailure,
	StreamFailureError,
	streamFailureFromStopReason,
} from "../src/utils/stream-failure.js";

afterEach(() => setLogSink(undefined));

function makeOutput(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		timestamp: 0,
		...overrides,
	};
}

describe("classifyStreamFailure", () => {
	test.each([
		["overloaded_error", undefined, "overloaded"],
		[undefined, 529, "overloaded"],
		["rate_limit_error", undefined, "rate_limit"],
		[undefined, 429, "rate_limit"],
		["refusal", undefined, "refusal"],
		["sensitive", undefined, "safety"],
		["SAFETY", undefined, "safety"],
		["PROHIBITED_CONTENT", undefined, "safety"],
		["content_filter", undefined, "safety"],
		["guardrail_intervened", undefined, "safety"],
		["authentication_error", undefined, "auth"],
		["invalid_request_error", undefined, "invalid_request"],
		["api_error", undefined, "server_error"],
		[undefined, 503, "server_error"],
		["something_else", undefined, "unknown"],
	])("classifies %s / %s as %s", (type, status, expected) => {
		expect(classifyStreamFailure(type, status)).toBe(expected);
	});
});

describe("streamFailureFromStopReason", () => {
	test("preserves the raw stop reason instead of a generic message", () => {
		const error = streamFailureFromStopReason("refusal", { requestId: "req_abc" });
		expect(error.message).toBe("Model refused to respond (refusal) [request_id: req_abc]");
		expect(error.info).toMatchObject({ kind: "refusal", providerErrorType: "refusal", requestId: "req_abc" });
	});

	test("maps Gemini safety finish reasons", () => {
		expect(streamFailureFromStopReason("SAFETY").info.kind).toBe("safety");
		expect(streamFailureFromStopReason("MALFORMED_FUNCTION_CALL").info.kind).toBe("malformed_response");
	});

	test("still explains a missing stop reason", () => {
		const error = streamFailureFromStopReason(undefined);
		expect(error.info.kind).toBe("unknown");
		expect(error.message).toContain("no stop reason");
	});
});

describe("extractStreamFailureInfo", () => {
	test("passes through StreamFailureError info", () => {
		const info = { kind: "overloaded" as const, requestId: "req_1" };
		expect(extractStreamFailureInfo(new StreamFailureError("x", info))).toBe(info);
	});

	test("extracts status, nested error type, and request id from SDK-shaped errors", () => {
		const sdkError = Object.assign(new Error("529 overloaded"), {
			status: 529,
			error: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
			requestID: "req_sdk",
		});
		expect(extractStreamFailureInfo(sdkError)).toMatchObject({
			kind: "overloaded",
			providerErrorType: "overloaded_error",
			status: 529,
			requestId: "req_sdk",
		});
	});

	test("extracts AWS SDK request id and exception name", () => {
		const awsError = Object.assign(new Error("throttled"), {
			name: "ThrottlingException",
			$metadata: { requestId: "aws_req" },
		});
		expect(extractStreamFailureInfo(awsError)).toMatchObject({ requestId: "aws_req" });
	});

	test("falls back to classifying the message text", () => {
		expect(extractStreamFailureInfo(new Error("provider overloaded, retry later")).kind).toBe("overloaded");
		expect(extractStreamFailureInfo("not an error").kind).toBe("unknown");
	});
});

describe("formatStreamFailureMessage", () => {
	test("condenses a classified SDK error to a one-liner instead of the raw payload", () => {
		const sdkError = Object.assign(
			new Error('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'),
			{
				status: 401,
				error: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } },
				requestID: "req_1",
			},
		);
		expect(formatStreamFailureMessage(sdkError)).toBe(
			"Provider authentication failed (authentication_error, 401): invalid x-api-key [request_id: req_1]",
		);
	});

	test("passes unrecognized errors through verbatim", () => {
		expect(formatStreamFailureMessage(new Error("fetch failed"))).toBe("fetch failed");
		expect(formatStreamFailureMessage(new Error("Request was aborted"))).toBe("Request was aborted");
	});

	test("uses the StreamFailureError message as-is", () => {
		const error = streamFailureFromStopReason("refusal");
		expect(formatStreamFailureMessage(error)).toBe(error.message);
	});
});

describe("recordStreamFailure", () => {
	const model = { provider: "anthropic", id: "claude-fable-5", api: "anthropic-messages" };

	test("appends a structured diagnostic and logs one entry", () => {
		const logged: Record<string, unknown>[] = [];
		setLogSink((entry) => logged.push(entry));

		const output = makeOutput({ errorMessage: "Provider overloaded (overloaded_error) [request_id: req_9]" });
		recordStreamFailure(model, output, new StreamFailureError("x", { kind: "overloaded", requestId: "req_9" }));

		expect(output.diagnostics).toHaveLength(1);
		expect(output.diagnostics?.[0]).toMatchObject({
			type: "provider_stream_failure",
			details: { kind: "overloaded", requestId: "req_9" },
		});
		expect(logged).toHaveLength(1);
		expect(logged[0]).toMatchObject({
			level: "error",
			component: "ai.provider",
			provider: "anthropic",
			model: "claude-fable-5",
			kind: "overloaded",
			requestId: "req_9",
		});
	});

	test("does nothing for user aborts", () => {
		const logged: unknown[] = [];
		setLogSink((entry) => logged.push(entry));
		const output = makeOutput({ stopReason: "aborted" });
		recordStreamFailure(model, output, new Error("Request was aborted"));
		expect(output.diagnostics).toBeUndefined();
		expect(logged).toEqual([]);
	});
});

describe("AWS SSO expiry classification", () => {
	const TOKEN_PROVIDER_MESSAGE =
		"Token is expired. To refresh this SSO session run 'aws sso login' with the corresponding profile.";

	function tokenProviderError(): Error {
		const error = new Error(TOKEN_PROVIDER_MESSAGE);
		error.name = "TokenProviderError";
		return error;
	}

	test("classifies a native Bedrock SSO expiry as a permanent auth failure", () => {
		expect(extractStreamFailureInfo(tokenProviderError())).toMatchObject({
			kind: "auth",
			providerErrorType: AWS_SSO_EXPIRED_ERROR_TYPE,
		});
	});

	test("classifies the Bedrock Mantle wrapper by inspecting the cause chain", () => {
		const wrapped = new Error(
			"Failed to resolve AWS credentials for Bedrock. Verify your AWS profile, environment variables, or runtime identity configuration and try again.",
		) as Error & { cause?: unknown };
		wrapped.name = "OpenAIError";
		wrapped.cause = tokenProviderError();
		expect(extractStreamFailureInfo(wrapped)).toMatchObject({
			kind: "auth",
			providerErrorType: AWS_SSO_EXPIRED_ERROR_TYPE,
		});
	});

	test("produces one uniform user-facing message for both Bedrock providers", () => {
		expect(formatStreamFailureMessage(tokenProviderError())).toBe(
			`Provider authentication failed (${AWS_SSO_EXPIRED_ERROR_TYPE}): ${TOKEN_PROVIDER_MESSAGE}`,
		);
	});

	test("persists the SSO marker in the structured diagnostic", () => {
		const output = makeOutput({ api: "bedrock-converse-stream", provider: "amazon-bedrock" });
		recordStreamFailure(
			{ provider: "amazon-bedrock", id: "claude-sonnet-4-6", api: "bedrock-converse-stream" },
			output,
			tokenProviderError(),
		);
		expect(output.diagnostics?.[0]).toMatchObject({
			type: "provider_stream_failure",
			details: { kind: "auth", providerErrorType: AWS_SSO_EXPIRED_ERROR_TYPE },
		});
	});

	test("leaves other AWS credential failures unchanged", () => {
		const generic = new Error(
			"Could not find credentials for Bedrock. Pass AWS credentials to `bedrock(...)` or configure the default AWS credential chain.",
		);
		expect(extractStreamFailureInfo(generic).kind).toBe("unknown");
		expect(formatStreamFailureMessage(generic)).toBe(generic.message);
	});
});

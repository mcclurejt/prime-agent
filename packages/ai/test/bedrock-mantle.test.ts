import OpenAI from "openai";
import { bedrock } from "openai/providers/bedrock/aws";
import { afterEach, describe, expect, it, vi } from "vitest";

const resolverMock = vi.hoisted(() => ({ resolve: vi.fn(async () => undefined as string | undefined) }));
vi.mock("@smithy/core/config", () => ({
	NODE_REGION_CONFIG_OPTIONS: {},
	loadConfig: vi.fn(() => resolverMock.resolve),
}));

import { getModel } from "../src/models.js";
import { getBedrockMantleBaseUrl, resolveBedrockMantleRegion } from "../src/providers/amazon-bedrock-mantle.js";
import { processResponsesStream } from "../src/providers/openai-responses-shared.js";
import type { AssistantMessage } from "../src/types.js";
import { AssistantMessageEventStream } from "../src/utils/event-stream.js";

describe("Amazon Bedrock Mantle", () => {
	it("uses the first-party Codex-compatible regional endpoint", () => {
		expect(getBedrockMantleBaseUrl("us-west-2")).toBe("https://bedrock-mantle.us-west-2.api.aws/openai/v1");
	});
	it("preserves native Bedrock metadata for GPT-5.6 Luna", () => {
		const mantle = getModel("amazon-bedrock-mantle", "openai.gpt-5.6-luna");
		const native = getModel("amazon-bedrock", "openai.gpt-5.6-luna");
		expect(mantle).toMatchObject({
			provider: "amazon-bedrock-mantle",
			api: "bedrock-mantle-responses",
			cost: native.cost,
			contextWindow: native.contextWindow,
			maxTokens: native.maxTokens,
		});
	});
	const originalAwsRegion = process.env.AWS_REGION;
	const originalAwsDefaultRegion = process.env.AWS_DEFAULT_REGION;
	afterEach(() => {
		if (originalAwsRegion === undefined) delete process.env.AWS_REGION;
		else process.env.AWS_REGION = originalAwsRegion;
		if (originalAwsDefaultRegion === undefined) delete process.env.AWS_DEFAULT_REGION;
		else process.env.AWS_DEFAULT_REGION = originalAwsDefaultRegion;
		resolverMock.resolve.mockReset();
		resolverMock.resolve.mockResolvedValue(undefined);
	});
	it("prefers an explicit region without reading ambient configuration", async () => {
		expect(await resolveBedrockMantleRegion({ region: "us-west-2" })).toBe("us-west-2");
	});
	it("uses AWS_DEFAULT_REGION when no explicit region is supplied", async () => {
		delete process.env.AWS_REGION;
		process.env.AWS_DEFAULT_REGION = "us-west-1";
		expect(await resolveBedrockMantleRegion({})).toBe("us-west-1");
		expect(resolverMock.resolve).not.toHaveBeenCalled();
	});
	it("normalizes resolver failures to the actionable missing-region error", async () => {
		delete process.env.AWS_REGION;
		delete process.env.AWS_DEFAULT_REGION;
		resolverMock.resolve.mockRejectedValue(new Error("resolver failure"));
		await expect(resolveBedrockMantleRegion({})).rejects.toThrow("Amazon Bedrock Mantle requires a region");
	});
	it("accounts for Mantle cache writes separately from uncached input and cache reads", async () => {
		const model = getModel("amazon-bedrock-mantle", "openai.gpt-5.6-luna");
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		};
		const events = [
			{
				type: "response.completed",
				response: {
					id: "response",
					status: "completed",
					usage: {
						input_tokens: 2000,
						output_tokens: 100,
						total_tokens: 2100,
						input_tokens_details: { cached_tokens: 800, cache_write_tokens: 400 },
					},
				},
			},
		];
		await processResponsesStream(events as never, output, new AssistantMessageEventStream(), model);
		expect(output.usage).toMatchObject({
			input: 1200,
			output: 100,
			cacheRead: 400,
			cacheWrite: 400,
			totalTokens: 2100,
		});
		expect(output.usage.cost.total).toBe(
			output.usage.cost.input +
				output.usage.cost.output +
				output.usage.cost.cacheRead +
				output.usage.cost.cacheWrite,
		);
	});
	it("never records negative uncached input when cache details over-report", async () => {
		const model = getModel("amazon-bedrock-mantle", "openai.gpt-5.6-luna");
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		};
		const events = [
			{
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: 10,
						output_tokens: 0,
						total_tokens: 10,
						input_tokens_details: { cached_tokens: 30, cache_write_tokens: 20 },
					},
				},
			},
		];
		await processResponsesStream(events as never, output, new AssistantMessageEventStream(), model);
		expect(output.usage).toMatchObject({ input: 0, cacheRead: 10, cacheWrite: 20 });
	});

	it("prepares a real first-party SigV4 request for the canonical host", async () => {
		let outbound: Request | undefined;
		const client = new OpenAI({
			provider: bedrock({
				region: "us-west-2",
				credentialProvider: async () => ({
					accessKeyId: "test-access-key",
					secretAccessKey: "test-secret-key",
					sessionToken: "test-session-token",
				}),
			}),
			fetch: async (input, init) => {
				outbound = input instanceof Request ? input : new Request(input, init);
				return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
			},
		});
		const response = await client.responses
			.create({ model: "openai.gpt-5.6-luna", input: [], stream: true })
			.withResponse();
		await response.data.controller.abort();
		expect(outbound?.url).toBe("https://bedrock-mantle.us-west-2.api.aws/openai/v1/responses");
		expect(outbound?.headers.get("authorization")).toContain("Credential=test-access-key/");
		expect(outbound?.headers.get("authorization")).toContain("/us-west-2/bedrock-mantle/aws4_request");
		expect(outbound?.headers.get("x-amz-security-token")).toBe("test-session-token");
	});
});

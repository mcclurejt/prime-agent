import { describe, expect, it, vi } from "vitest";

const compactMock = vi.hoisted(() => ({
	compact: vi.fn(),
	ctorOptions: [] as unknown[],
}));

vi.mock("openai", () => ({
	default: class MockOpenAI {
		responses = { compact: compactMock.compact };
		constructor(options: unknown) {
			compactMock.ctorOptions.push(options);
		}
	},
}));
vi.mock("openai/providers/bedrock/aws", () => ({ bedrock: vi.fn(() => ({ kind: "bedrock-provider" })) }));
vi.mock("@aws-sdk/credential-provider-node", () => ({ defaultProvider: vi.fn(() => ({})) }));

import { getModel } from "../src/models.js";
import { compactBedrockMantle } from "../src/providers/amazon-bedrock-mantle.js";
import { convertResponsesMessages } from "../src/providers/openai-responses-shared.js";
import type { CompactionContent, Context, UserMessage } from "../src/types.js";

const TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode", "amazon-bedrock-mantle"]);

function compactionBlock(provider: string): CompactionContent {
	return { type: "compaction", provider, encryptedContent: "smry_opaque", id: "cmp_1" };
}

function carrierMessage(provider: string): UserMessage {
	return {
		role: "user",
		content: [compactionBlock(provider), { type: "text", text: "compaction note" }],
		timestamp: Date.now(),
	};
}

describe("Responses conversion of compaction blocks", () => {
	it("emits a top-level compaction item before the note for the producing provider", () => {
		const model = getModel("amazon-bedrock-mantle", "openai.gpt-5.6-luna");
		const context: Context = { messages: [carrierMessage("amazon-bedrock-mantle")] };
		const items = convertResponsesMessages(model, context, TOOL_CALL_PROVIDERS);
		expect(items).toEqual([
			{ type: "compaction", encrypted_content: "smry_opaque", id: "cmp_1" },
			{ role: "user", content: [{ type: "input_text", text: "compaction note" }] },
		]);
	});

	it("keeps conversation order when text precedes the compaction block", () => {
		const model = getModel("amazon-bedrock-mantle", "openai.gpt-5.6-luna");
		const message: UserMessage = {
			role: "user",
			content: [
				{ type: "text", text: "before" },
				compactionBlock("amazon-bedrock-mantle"),
				{ type: "text", text: "after" },
			],
			timestamp: Date.now(),
		};
		const items = convertResponsesMessages(model, { messages: [message] }, TOOL_CALL_PROVIDERS);
		expect(items).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "before" }] },
			{ type: "compaction", encrypted_content: "smry_opaque", id: "cmp_1" },
			{ role: "user", content: [{ type: "input_text", text: "after" }] },
		]);
	});

	it("drops compaction blocks produced by a different provider", () => {
		const model = getModel("openai", "gpt-5.1");
		const context: Context = { messages: [carrierMessage("amazon-bedrock-mantle")] };
		const items = convertResponsesMessages(model, context, TOOL_CALL_PROVIDERS);
		expect(items).toEqual([{ role: "user", content: [{ type: "input_text", text: "compaction note" }] }]);
	});
});

describe("compactBedrockMantle", () => {
	it("maps the compact response to provider-tagged items with priced usage", async () => {
		const model = getModel("amazon-bedrock-mantle", "openai.gpt-5.6-luna");
		compactMock.compact.mockResolvedValueOnce({
			id: "resp_compact",
			object: "response.compaction",
			created_at: 1,
			output: [
				{ type: "message", role: "assistant", content: [{ type: "output_text", text: "kept text" }] },
				{ type: "compaction", id: "cmp_9", encrypted_content: "smry_blob" },
			],
			usage: {
				input_tokens: 100,
				output_tokens: 10,
				total_tokens: 110,
				input_tokens_details: { cached_tokens: 20 },
				output_tokens_details: { reasoning_tokens: 0 },
			},
		});

		const context: Context = {
			systemPrompt: "system rules",
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		};
		const result = await compactBedrockMantle(model, context, { region: "us-east-1" });

		expect(compactMock.compact).toHaveBeenCalledTimes(1);
		const [params] = compactMock.compact.mock.calls[0];
		expect(params.model).toBe("openai.gpt-5.6-luna");
		expect(params.instructions).toBe("system rules");
		expect(params.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "hello" }] }]);

		expect(result.responseId).toBe("resp_compact");
		expect(result.items).toEqual([
			{ type: "text", text: "kept text" },
			{ type: "compaction", provider: "amazon-bedrock-mantle", encryptedContent: "smry_blob", id: "cmp_9" },
		]);
		expect(result.usage.input).toBe(80);
		expect(result.usage.cacheRead).toBe(20);
		expect(result.usage.output).toBe(10);
		expect(result.usage.totalTokens).toBe(110);
		expect(result.usage.cost.total).toBeGreaterThan(0);
	});

	it("rejects when the endpoint returns no compaction item", async () => {
		const model = getModel("amazon-bedrock-mantle", "openai.gpt-5.6-luna");
		compactMock.compact.mockResolvedValueOnce({
			id: "resp_compact",
			object: "response.compaction",
			created_at: 1,
			output: [],
			usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
		});
		await expect(
			compactBedrockMantle(
				model,
				{ messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
				{ region: "us-east-1" },
			),
		).rejects.toThrow("returned no compaction item");
	});
});

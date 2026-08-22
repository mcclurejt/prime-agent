import { describe, expect, it } from "vitest";
import { hasApi } from "../src/index.js";
import type { Api, Model } from "../src/types.js";

function codexModel(): Model<Api> {
	return {
		id: "gpt-5.6-sol",
		name: "GPT-5.6 Sol",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	};
}

describe("model API narrowing", () => {
	it("exports hasApi and checks the model API at runtime", () => {
		const model = codexModel();

		expect(hasApi(model, "openai-codex-responses")).toBe(true);
		expect(hasApi(model, "openai-responses")).toBe(false);
	});
});

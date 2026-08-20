import type { Model } from "../types.js";

const baseUrl = "https://bedrock-mantle.us-east-1.api.aws/openai/v1";
export const BEDROCK_MANTLE_MODELS: Record<string, Model<"bedrock-mantle-responses">> = {
	"openai.gpt-5.6-luna": {
		id: "openai.gpt-5.6-luna",
		name: "GPT-5.6 Luna",
		api: "bedrock-mantle-responses",
		provider: "amazon-bedrock-mantle",
		baseUrl,
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", minimal: null, max: "max" },
		input: ["text", "image"],
		cost: { input: 0.22, output: 1.32, cacheRead: 0.022, cacheWrite: 0.275 },
		contextWindow: 272000,
		maxTokens: 128000,
	},
	"openai.gpt-5.6-sol": {
		id: "openai.gpt-5.6-sol",
		name: "GPT-5.6 Sol",
		api: "bedrock-mantle-responses",
		provider: "amazon-bedrock-mantle",
		baseUrl,
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", minimal: null, max: "max" },
		input: ["text", "image"],
		cost: { input: 5.5, output: 33, cacheRead: 0.55, cacheWrite: 6.88 },
		contextWindow: 272000,
		maxTokens: 128000,
	},
	"openai.gpt-5.6-terra": {
		id: "openai.gpt-5.6-terra",
		name: "GPT-5.6 Terra",
		api: "bedrock-mantle-responses",
		provider: "amazon-bedrock-mantle",
		baseUrl,
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", minimal: null, max: "max" },
		input: ["text", "image"],
		cost: { input: 2.2, output: 13.2, cacheRead: 0.22, cacheWrite: 2.75 },
		contextWindow: 272000,
		maxTokens: 128000,
	},
};

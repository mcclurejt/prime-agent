import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { streamBedrock } from "../src/providers/amazon-bedrock.js";
import type { AssistantMessage, Context, ToolResultMessage } from "../src/types.js";

interface BedrockContentBlock {
	text?: string;
	toolUse?: { toolUseId?: string };
	toolResult?: {
		toolUseId?: string;
		content?: Array<{ text?: string }>;
		status?: string;
	};
}

interface BedrockMessage {
	role?: string;
	content?: BedrockContentBlock[];
}

async function captureMessages(context: Context): Promise<BedrockMessage[]> {
	const model = getModel("amazon-bedrock", "global.anthropic.claude-opus-5");
	let capturedMessages: BedrockMessage[] | undefined;
	const stream = streamBedrock(model, context, {
		cacheRetention: "none",
		signal: AbortSignal.abort(),
		onPayload: (payload) => {
			capturedMessages = (payload as { messages?: BedrockMessage[] }).messages;
			return payload;
		},
	});

	for await (const event of stream) {
		if (event.type === "error") break;
	}

	if (!capturedMessages) throw new Error("Expected Bedrock messages to be captured before request abort");
	return capturedMessages;
}

function assistantToolCall(toolCallId: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: toolCallId, name: "ipython", arguments: { code: "1 + 1" } }],
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		model: "global.anthropic.claude-opus-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 2,
	};
}

function interruptedToolResult(toolCallId: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "ipython",
		content: [{ type: "text", text: "Tool interrupted by Prime Agent update" }],
		isError: true,
		timestamp: 4,
	};
}

describe("Bedrock tool-result payload", () => {
	it("keeps a delayed matching tool result paired with its tool use across an update interruption message", async () => {
		const toolCallId = "tooluse_update_interrupted";
		const context: Context = {
			messages: [
				{ role: "user", content: "Run the tool", timestamp: 1 },
				assistantToolCall(toolCallId),
				{
					role: "user",
					content:
						"<prime_agent_update_interrupted>Update interrupted this session.</prime_agent_update_interrupted>",
					timestamp: 3,
				},
				interruptedToolResult(toolCallId),
				{ role: "user", content: "Prime Agent restarted after an update. Continue.", timestamp: 5 },
			],
		};

		const messages = await captureMessages(context);
		const assistantIndex = messages.findIndex((message) =>
			message.content?.some((block) => block.toolUse?.toolUseId === toolCallId),
		);

		expect(assistantIndex).toBeGreaterThanOrEqual(0);
		expect(messages[assistantIndex + 1]).toEqual({
			role: "user",
			content: [
				{
					toolResult: {
						toolUseId: toolCallId,
						content: [{ text: "Tool interrupted by Prime Agent update" }],
						status: "error",
					},
				},
			],
		});

		const matchingResults = messages.flatMap((message) =>
			(message.content ?? []).filter((block) => block.toolResult?.toolUseId === toolCallId),
		);
		expect(matchingResults).toHaveLength(1);
		expect(messages[assistantIndex + 2]?.content).toEqual([
			{
				text: "<prime_agent_update_interrupted>Update interrupted this session.</prime_agent_update_interrupted>",
			},
		]);
	});
});

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	AssistantMessage,
	CompactionContent,
	Context,
	ServerCompactionResult,
	Usage,
} from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	type CompactionDetails,
	type CompactionSettings,
	compactServerSide,
	prepareCompaction,
} from "../src/core/compaction/index.js";
import {
	convertToLlm,
	createCompactionSummaryMessage,
	getServerCompactionDetails,
	type ServerCompactionDetails,
} from "../src/core/messages.js";
import {
	buildSessionContext,
	type CompactionEntry,
	type SessionEntry,
	type SessionMessageEntry,
} from "../src/core/session-manager.js";

const MANTLE_MODEL = getModel("amazon-bedrock-mantle", "openai.gpt-5.6-luna");

const SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 1000,
	keepRecentTokens: 50,
	serverSide: true,
};

function mockUsage(): Usage {
	return {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 15,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function compactionBlock(): CompactionContent {
	return {
		type: "compaction",
		provider: "amazon-bedrock-mantle",
		encryptedContent: "smry_opaque",
		id: "cmp_1",
	};
}

let entryCounter = 0;
let lastId: string | null = null;

function messageEntry(message: AgentMessage): SessionMessageEntry {
	const id = `entry-${entryCounter++}`;
	const entry: SessionMessageEntry = {
		type: "message",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		message,
	};
	lastId = id;
	return entry;
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: mockUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
		api: "bedrock-mantle-responses",
		provider: "amazon-bedrock-mantle",
		model: "openai.gpt-5.6-luna",
	};
}

function buildEntries(turns: number): SessionEntry[] {
	entryCounter = 0;
	lastId = null;
	const entries: SessionEntry[] = [];
	for (let i = 0; i < turns; i++) {
		entries.push(messageEntry(userMessage(`user request ${i} ${"x".repeat(400)}`)));
		entries.push(messageEntry(assistantMessage(`assistant answer ${i} ${"y".repeat(400)}`)));
	}
	return entries;
}

describe("compactServerSide", () => {
	it("stores provider items in details and a plain note as the summary", async () => {
		const entries = buildEntries(6);
		const preparation = prepareCompaction(entries, SETTINGS);
		expect(preparation).toBeDefined();

		const seenContexts: Context[] = [];
		const fakeCompact = async (_model: unknown, context: Context): Promise<ServerCompactionResult> => {
			seenContexts.push(context);
			return { items: [compactionBlock()], usage: mockUsage(), responseId: "resp_1" };
		};

		const result = await compactServerSide(preparation!, MANTLE_MODEL, undefined, fakeCompact);

		expect(seenContexts).toHaveLength(1);
		expect(seenContexts[0].messages.length).toBeGreaterThan(0);

		expect(result.summary).toContain("compacted server-side by openai.gpt-5.6-luna");
		expect(result.firstKeptEntryId).toBe(preparation!.firstKeptEntryId);
		const details = result.details as CompactionDetails;
		expect(details.serverCompaction).toEqual({
			modelId: "openai.gpt-5.6-luna",
			items: [compactionBlock()],
		});
	});

	it("feeds the previous server compaction back into the next compaction call", async () => {
		const entries = buildEntries(4);
		const firstPreparation = prepareCompaction(entries, SETTINGS);
		const fakeCompact = async (): Promise<ServerCompactionResult> => ({
			items: [compactionBlock()],
			usage: mockUsage(),
			responseId: "resp_1",
		});
		const firstResult = await compactServerSide(firstPreparation!, MANTLE_MODEL, undefined, fakeCompact);

		const compactionEntry: CompactionEntry = {
			type: "compaction",
			id: `entry-${entryCounter++}`,
			parentId: lastId,
			timestamp: new Date().toISOString(),
			summary: firstResult.summary,
			firstKeptEntryId: firstResult.firstKeptEntryId,
			tokensBefore: firstResult.tokensBefore,
			details: firstResult.details,
		};
		lastId = compactionEntry.id;
		const grownEntries = [...entries, compactionEntry];
		for (let i = 0; i < 4; i++) {
			grownEntries.push(messageEntry(userMessage(`later request ${i} ${"x".repeat(400)}`)));
			grownEntries.push(messageEntry(assistantMessage(`later answer ${i} ${"y".repeat(400)}`)));
		}

		const secondPreparation = prepareCompaction(grownEntries, SETTINGS);
		expect(secondPreparation?.previousDetails).toBe(firstResult.details);

		const seenContexts: Context[] = [];
		const secondCompact = async (_model: unknown, context: Context): Promise<ServerCompactionResult> => {
			seenContexts.push(context);
			return { items: [compactionBlock()], usage: mockUsage(), responseId: "resp_2" };
		};
		await compactServerSide(secondPreparation!, MANTLE_MODEL, undefined, secondCompact);

		const firstMessage = seenContexts[0].messages[0];
		expect(firstMessage.role).toBe("user");
		const content = firstMessage.content as Array<{ type: string }>;
		expect(content.some((block) => block.type === "compaction")).toBe(true);
	});
});

describe("server compaction context replay", () => {
	const serverCompaction: ServerCompactionDetails = {
		modelId: "openai.gpt-5.6-luna",
		items: [compactionBlock()],
	};
	const details: CompactionDetails = { readFiles: [], modifiedFiles: [], serverCompaction };

	it("getServerCompactionDetails validates the stored payload shape", () => {
		expect(getServerCompactionDetails(details)).toEqual(serverCompaction);
		expect(getServerCompactionDetails(undefined)).toBeUndefined();
		expect(getServerCompactionDetails({ readFiles: [] })).toBeUndefined();
		expect(getServerCompactionDetails({ serverCompaction: { modelId: 5, items: [] } })).toBeUndefined();
	});

	it("convertToLlm expands the compaction summary into payload items plus the note", () => {
		const message = createCompactionSummaryMessage(
			"the note",
			1000,
			new Date().toISOString(),
			undefined,
			undefined,
			details,
		);
		const [converted] = convertToLlm([message]);
		expect(converted.role).toBe("user");
		const content = converted.content as Array<{ type: string; text?: string }>;
		expect(content[0]).toEqual(compactionBlock());
		expect(content[1].type).toBe("text");
		expect(content[1].text).toContain("the note");
	});

	it("convertToLlm keeps plain text only when there is no server payload", () => {
		const message = createCompactionSummaryMessage("the note", 1000, new Date().toISOString());
		const [converted] = convertToLlm([message]);
		const content = converted.content as Array<{ type: string; text?: string }>;
		expect(content).toHaveLength(1);
		expect(content[0].type).toBe("text");
	});

	it("buildSessionContext carries compaction details into the summary message", () => {
		const entries = buildEntries(2);
		const compactionEntry: CompactionEntry = {
			type: "compaction",
			id: `entry-${entryCounter++}`,
			parentId: lastId,
			timestamp: new Date().toISOString(),
			summary: "the note",
			firstKeptEntryId: entries[entries.length - 2].id,
			tokensBefore: 1000,
			details,
		};
		lastId = compactionEntry.id;
		entries.push(compactionEntry);

		const context = buildSessionContext(entries);
		const summaryMessage = context.messages.find((m) => m.role === "compactionSummary");
		expect(summaryMessage).toBeDefined();
		expect(getServerCompactionDetails((summaryMessage as { details?: unknown }).details)).toEqual(serverCompaction);
	});
});

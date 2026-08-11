import { describe, expect, it } from "vitest";
import type { ExtensionQuestionnaireDraftV1, ExtensionQuestionnaireDraftV2 } from "../src/core/extensions/types.js";
import type { WorkerQuestionnaireBrokerMessage } from "../src/modes/daemon/daemon-worker-protocol.js";
import { WorkerUiClientsMirror } from "../src/modes/daemon/daemon-worker-ui-clients.js";
import {
	QuestionnaireWorkerAuthority,
	type QuestionnaireWorkerMutation,
} from "../src/modes/daemon/questionnaire-worker-authority.js";

const request = {
	version: 1 as const,
	title: "Deploy",
	questions: [
		{ id: "confirm", kind: "confirm" as const, prompt: "Proceed?", other: {} },
		{
			id: "targets",
			kind: "multi-select" as const,
			prompt: "Targets?",
			choices: [
				{ id: "a", label: "A" },
				{ id: "b", label: "B" },
			],
			other: {},
		},
		{ id: "notes", kind: "multiline-text" as const, prompt: "Notes" },
	],
};

function initialDraft(): ExtensionQuestionnaireDraftV1 {
	return {
		version: 1,
		currentStep: { kind: "question", questionId: "confirm" },
		states: [
			{
				questionId: "confirm",
				kind: "confirm",
				selection: null,
				otherEditorOpen: false,
				otherText: "",
			},
			{
				questionId: "targets",
				kind: "multi-select",
				choiceIds: [],
				otherSelected: false,
				otherEditorOpen: false,
				otherText: "",
			},
			{ questionId: "notes", kind: "multiline-text", value: "" },
		],
	};
}

function editedDraft(): ExtensionQuestionnaireDraftV1 {
	return {
		...initialDraft(),
		currentStep: { kind: "review" },
		states: [
			{
				questionId: "confirm",
				kind: "confirm",
				selection: "other",
				otherEditorOpen: true,
				otherText: " custom approval ",
			},
			{
				questionId: "targets",
				kind: "multi-select",
				choiceIds: ["b", "a"],
				otherSelected: true,
				otherEditorOpen: false,
				otherText: "   ",
			},
			{ questionId: "notes", kind: "multiline-text", value: "line one\nline two" },
		],
	};
}

function harness() {
	const mirror = new WorkerUiClientsMirror();
	const messages: WorkerQuestionnaireBrokerMessage[] = [];
	const statuses: Array<{
		activeSessionId: string;
		status: { state: "waiting" | "offered" | "presenting" | undefined; queueDepth: number };
	}> = [];
	let id = 0;
	const authority = new QuestionnaireWorkerAuthority({
		uiClients: mirror,
		sendBrokerMessage: (message) => {
			messages.push(message);
			return true;
		},
		onStatusChanged: (activeSessionId, status) => statuses.push({ activeSessionId, status }),
		createId: () => `id-${++id}`,
		now: () => id,
	});
	return { authority, mirror, messages, statuses };
}

function syncRich(
	mirror: WorkerUiClientsMirror,
	generation = "generation-a",
	revision = 1,
	connectionId = "connection-a",
) {
	mirror.applySync({
		supervisorGeneration: generation,
		syncRevision: revision,
		clients: [
			{
				logicalClientId: `logical-${connectionId}`,
				connectionId,
				activeSessionId: "session-a",
				capabilities: ["extension_ui", "questionnaire_v1"],
				presentable: true,
			},
		],
		complete: true,
	});
}

function syncLegacy(
	mirror: WorkerUiClientsMirror,
	generation = "generation-a",
	revision = 1,
	connectionId = "connection-a",
) {
	mirror.applySync({
		supervisorGeneration: generation,
		syncRevision: revision,
		clients: [
			{
				logicalClientId: `logical-${connectionId}`,
				connectionId,
				activeSessionId: "session-a",
				capabilities: ["extension_ui"],
				presentable: true,
			},
		],
		complete: true,
	});
}

function acceptLatest(
	authority: QuestionnaireWorkerAuthority,
	messages: WorkerQuestionnaireBrokerMessage[],
	mode: "rich" | "legacy" = "rich",
) {
	const need = messages.at(-1);
	if (need?.type !== "presenter_needed") throw new Error("missing presenter need");
	const lease = {
		supervisorGeneration: need.need.supervisorGeneration,
		logicalRequestId: need.need.logicalRequestId,
		offerId: need.need.offerId,
		leaseEpoch: need.need.leaseEpoch,
		logicalClientId: "logical-connection-a",
		connectionId: "connection-a",
		mode,
		...(need.need.questionnaireVersion === 2 ? { questionnaireVersion: 2 as const } : {}),
	};
	authority.handleOfferResult({ status: "accepted", lease });
	return lease;
}

function mutation(
	lease: ReturnType<typeof acceptLatest>,
	baseRevision: number,
	clientMutationId: string,
	completeDraft: ExtensionQuestionnaireDraftV1,
): QuestionnaireWorkerMutation {
	return { lease, baseRevision, clientMutationId, completeDraft };
}

describe("QuestionnaireWorkerAuthority", () => {
	it("waits for an attached but temporarily non-presentable v2 presenter instead of projecting", () => {
		const { authority, mirror, messages } = harness();
		mirror.applySync({
			supervisorGeneration: "generation-a",
			syncRevision: 1,
			clients: [
				{
					logicalClientId: "logical-v1",
					connectionId: "connection-v1",
					activeSessionId: "session-a",
					capabilities: ["extension_ui", "questionnaire_v1"],
					presentable: true,
				},
				{
					logicalClientId: "logical-v2",
					connectionId: "connection-v2",
					activeSessionId: "session-a",
					capabilities: ["extension_ui", "questionnaire_v1", "questionnaire_v2"],
					presentable: false,
				},
			],
			complete: true,
		});
		authority.request("session-a", {
			version: 2,
			questions: [{ id: "q", kind: "short-text", prompt: "Decision", context: "Must remain rich" }],
		});
		expect(messages).toEqual([]);
		expect(authority.status("session-a")).toEqual({ state: "waiting", queueDepth: 1 });

		mirror.applyDelta({
			supervisorGeneration: "generation-a",
			syncRevision: 2,
			change: {
				type: "upsert",
				client: {
					logicalClientId: "logical-v2",
					connectionId: "connection-v2",
					activeSessionId: "session-a",
					capabilities: ["extension_ui", "questionnaire_v1", "questionnaire_v2"],
					presentable: true,
				},
			},
		});
		authority.handleUiClientsChanged();
		expect(messages.at(-1)).toMatchObject({ type: "presenter_needed", need: { questionnaireVersion: 2 } });
	});

	it("projects v2 to v1 before interaction when only a v1 presenter is available", async () => {
		const { authority, mirror, messages } = harness();
		syncRich(mirror);
		const pending = authority.request("session-a", {
			version: 2,
			questions: [
				{
					id: "q",
					kind: "single-select",
					prompt: "Choose",
					context: "Rich context",
					choices: [
						{
							id: "a",
							label: "A",
							detail: "Rich detail",
							preview: { markdown: "diagram", alt: "plain preview" },
						},
					],
				},
			],
		});
		expect(messages.at(-1)).toMatchObject({ type: "presenter_needed", need: { mode: "undecided" } });
		expect(messages.at(-1)).not.toMatchObject({ need: { questionnaireVersion: 2 } });
		const lease = acceptLatest(authority, messages);
		const snapshot = authority.presentationSnapshot(lease.logicalRequestId);
		expect(snapshot?.request.version).toBe(1);
		const projectedQuestion = snapshot?.request.questions[0] as unknown as Record<string, unknown>;
		expect(projectedQuestion).not.toHaveProperty("context");
		expect(projectedQuestion).not.toHaveProperty("recommendation");
		expect(JSON.stringify(snapshot?.request)).toContain("plain preview");
		expect(JSON.stringify(snapshot?.request)).not.toMatch(/"detail"|"preview"|"markdown"/u);
		const terminal = authority.submit({
			lease,
			baseRevision: 0,
			clientMutationId: "projected-submit",
			completeDraft: snapshot!.draft,
		});
		expect(terminal).toMatchObject({
			status: "terminal",
			outcome: {
				presentation: {
					mode: "v1-projection",
					unavailableFeatures: ["notes", "previews"],
				},
			},
		});
		await expect(pending.outcome).resolves.toMatchObject({
			presentation: { mode: "v1-projection", unavailableFeatures: ["notes", "previews"] },
		});
	});

	it("never downgrades an authoritative v2 draft after a presenter loss", () => {
		const { authority, mirror, messages } = harness();
		mirror.applySync({
			supervisorGeneration: "generation-a",
			syncRevision: 1,
			clients: [
				{
					logicalClientId: "logical-connection-a",
					connectionId: "connection-a",
					activeSessionId: "session-a",
					capabilities: ["extension_ui", "questionnaire_v1", "questionnaire_v2"],
					presentable: true,
				},
			],
			complete: true,
		});
		const requestV2 = {
			version: 2 as const,
			questions: [{ id: "q", kind: "short-text" as const, prompt: "Decision", context: "Private context" }],
		};
		authority.request("session-a", requestV2);
		expect(messages.at(-1)).toMatchObject({ type: "presenter_needed", need: { questionnaireVersion: 2 } });
		const lease = acceptLatest(authority, messages);
		const draft: ExtensionQuestionnaireDraftV2 = {
			version: 2,
			currentStep: { kind: "review" },
			states: [{ questionId: "q", kind: "short-text", value: "answer", note: "must survive" }],
		};
		expect(
			authority.checkpoint({ lease, baseRevision: 0, clientMutationId: "v2-edit", completeDraft: draft }),
		).toMatchObject({ status: "ack" });
		authority.handleLeaseRevoked(lease);
		expect(messages.at(-1)).toMatchObject({ type: "presenter_needed", need: { questionnaireVersion: 2 } });
		const before = messages.length;
		syncRich(mirror, "generation-a", 2);
		authority.handleUiClientsChanged();
		expect(messages).toHaveLength(before);
		expect(authority.presentationSnapshot(lease.logicalRequestId)).toBeUndefined();
		expect(JSON.stringify(messages)).not.toContain("must survive");
	});

	it("waits for a complete broker barrier and exposes only the FIFO session head", () => {
		const { authority, mirror, messages, statuses } = harness();
		const first = authority.request("session-a", request);
		const second = authority.request("session-a", request);

		expect(authority.status("session-a")).toEqual({ state: "waiting", queueDepth: 2 });
		expect(messages).toEqual([]);
		syncRich(mirror);
		authority.handleUiClientsChanged();

		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({
			type: "presenter_needed",
			need: { logicalRequestId: first.logicalRequestId, leaseEpoch: 1, mode: "undecided" },
		});
		expect(messages[0]).not.toMatchObject({ need: { logicalRequestId: second.logicalRequestId } });
		expect(authority.status("session-a")).toEqual({ state: "offered", queueDepth: 2 });
		expect(statuses.at(-1)).toEqual({
			activeSessionId: "session-a",
			status: { state: "offered", queueDepth: 2 },
		});
		expect(JSON.stringify(statuses)).not.toMatch(/Deploy|Proceed|Targets|Notes/u);
	});

	it("commits rich mode once, applies canonical checkpoint CAS, and replays only identical mutations", () => {
		const { authority, mirror, messages } = harness();
		syncRich(mirror);
		const pending = authority.request("session-a", request);
		const lease = acceptLatest(authority, messages);
		expect(authority.status("session-a")).toEqual({ state: "presenting", queueDepth: 1 });

		const first = authority.checkpoint(mutation(lease, 0, "mutation-a", editedDraft()));
		expect(first).toMatchObject({ status: "ack", ack: { clientMutationId: "mutation-a", authoritativeRevision: 1 } });
		if (first.status !== "ack") throw new Error("checkpoint did not ACK");
		expect(first.ack.draftHash).toMatch(/^[a-f0-9]{64}$/u);
		expect(authority.checkpoint(mutation(lease, 0, "mutation-a", editedDraft()))).toEqual(first);

		const collisionDraft = editedDraft();
		collisionDraft.states[2] = { questionId: "notes", kind: "multiline-text", value: "different" };
		expect(authority.checkpoint(mutation(lease, 0, "mutation-a", collisionDraft))).toEqual({
			status: "mutation-id-collision",
		});
		const stale = authority.checkpoint(mutation(lease, 0, "mutation-b", initialDraft()));
		expect(stale).toMatchObject({
			status: "conflict",
			authoritativeRevision: 1,
			draftHash: first.ack.draftHash,
			snapshot: { lease, authoritativeRevision: 1, request: pending.request },
		});
	});

	it("rejects wrong leases and prevents an old presenter from overwriting an intervening edit", () => {
		const { authority, mirror, messages } = harness();
		syncRich(mirror);
		authority.request("session-a", request);
		const leaseA = acceptLatest(authority, messages);
		authority.handleLeaseRevoked(leaseA);
		authority.handleUiClientsChanged();
		const leaseB = acceptLatest(authority, messages);
		expect(leaseB.leaseEpoch).toBe(2);
		const applied = authority.checkpoint(mutation(leaseB, 0, "mutation-b", editedDraft()));
		expect(applied).toMatchObject({ status: "ack", ack: { authoritativeRevision: 1 } });

		authority.handleLeaseRevoked(leaseB);
		authority.handleUiClientsChanged();
		const leaseA2 = acceptLatest(authority, messages);
		const oldBase = authority.checkpoint(mutation(leaseA2, 0, "mutation-a-old", initialDraft()));
		expect(oldBase).toMatchObject({ status: "conflict", authoritativeRevision: 1 });
		expect(authority.checkpoint(mutation(leaseA, 1, "mutation-stale-lease", editedDraft()))).toEqual({
			status: "stale-lease",
		});
	});

	it("atomically submits ordered responses, advances FIFO, and tombstones duplicate submit", async () => {
		const { authority, mirror, messages } = harness();
		syncRich(mirror);
		const first = authority.request("session-a", request);
		const second = authority.request("session-a", request);
		const lease = acceptLatest(authority, messages);

		const submitted = authority.submit(mutation(lease, 0, "submit-a", editedDraft()));
		expect(submitted).toMatchObject({
			status: "terminal",
			outcome: {
				status: "submitted",
				responses: [
					{ questionId: "confirm", status: "answered", kind: "confirm", otherText: " custom approval " },
					{ questionId: "targets", status: "answered", kind: "multi-select", choiceIds: ["a", "b"] },
					{ questionId: "notes", status: "answered", kind: "multiline-text", value: "line one\nline two" },
				],
			},
		});
		expect(await first.outcome).toEqual(submitted.status === "terminal" ? submitted.outcome : undefined);
		expect(messages.at(-2)).toEqual({ type: "withdraw", lease });
		expect(messages.at(-1)).toMatchObject({
			type: "presenter_needed",
			need: { logicalRequestId: second.logicalRequestId },
		});
		expect(authority.submit(mutation(lease, 0, "submit-a", editedDraft()))).toEqual(submitted);
		expect(authority.submit(mutation(lease, 0, "submit-a", initialDraft()))).toEqual({
			status: "mutation-id-collision",
		});
		authority.acknowledgeTerminalDelivery(first.logicalRequestId);
		expect(authority.submit(mutation(lease, 0, "submit-a", editedDraft()))).toEqual({ status: "stale-lease" });
	});

	it("settles explicit rich dismissal without exposing or retaining draft responses", async () => {
		const { authority, mirror, messages } = harness();
		syncRich(mirror);
		const pending = authority.request("session-a", request);
		const lease = acceptLatest(authority, messages);

		expect(authority.dismiss({ ...lease, offerId: "stale" })).toEqual({ status: "stale-lease" });
		expect(authority.dismiss(lease)).toEqual({ status: "terminal", outcome: { status: "dismissed" } });
		await expect(pending.outcome).resolves.toEqual({ status: "dismissed" });
		expect(messages.at(-1)).toEqual({ type: "withdraw", lease });
		expect(authority.dismiss(lease)).toEqual({ status: "stale-lease" });
	});

	it("runs legacy primitives on the exact lease and preserves only completed answers across requeue", async () => {
		const { authority, mirror, messages } = harness();
		syncLegacy(mirror);
		const pending = authority.request("session-a", request);
		const firstLease = acceptLatest(authority, messages, "legacy");
		let primitive = messages.at(-1);
		if (primitive?.type !== "legacy_request" || primitive.request.method !== "select") {
			throw new Error("missing legacy confirm request");
		}
		expect(primitive.lease).toEqual(firstLease);
		authority.handleLegacyResponse({
			lease: firstLease,
			requestId: primitive.requestId,
			connectionId: firstLease.connectionId,
			response: { value: primitive.request.payload.options[0]! },
		});

		primitive = messages.at(-1);
		if (primitive?.type !== "legacy_request" || primitive.request.method !== "select") {
			throw new Error("missing legacy multi-select request");
		}
		const selectedA = primitive.request.payload.options.find((option) => option.includes("A"))!;
		authority.handleLegacyResponse({
			lease: firstLease,
			requestId: primitive.requestId,
			connectionId: firstLease.connectionId,
			response: { value: selectedA },
		});
		syncLegacy(mirror, "generation-b");
		authority.handleUiClientsChanged();

		const secondLease = acceptLatest(authority, messages, "legacy");
		primitive = messages.at(-1);
		if (primitive?.type !== "legacy_request" || primitive.request.method !== "select") {
			throw new Error("missing requeued legacy request");
		}
		expect(primitive.request.payload.options.find((option) => option.includes("A"))).toContain("[ ]");
		expect(secondLease.leaseEpoch).toBe(2);
		expect(
			authority.handleLegacyResponse({
				lease: secondLease,
				requestId: primitive.requestId,
				connectionId: "wrong-connection",
				response: { cancelled: true },
			}),
		).toBe("stale");
		expect(
			authority.handleLegacyResponse({
				lease: secondLease,
				requestId: primitive.requestId,
				connectionId: secondLease.connectionId,
				response: { cancelled: true },
			}),
		).toBe("accepted");
		await expect(pending.outcome).resolves.toEqual({
			status: "indeterminate",
			reason: "legacy-cancelled-or-presentation-lost",
		});
	});

	it("rejects an accepted lease that changes an already committed presentation mode", () => {
		const { authority, mirror, messages } = harness();
		syncRich(mirror);
		authority.request("session-a", request);
		const firstLease = acceptLatest(authority, messages);
		authority.handleLeaseRevoked(firstLease);
		const need = messages.at(-1);
		if (need?.type !== "presenter_needed") throw new Error("missing replacement presenter need");
		const wrongModeLease = {
			supervisorGeneration: need.need.supervisorGeneration,
			logicalRequestId: need.need.logicalRequestId,
			offerId: need.need.offerId,
			leaseEpoch: need.need.leaseEpoch,
			logicalClientId: "logical-connection-a",
			connectionId: "connection-a",
			mode: "legacy" as const,
		};

		authority.handleOfferResult({ status: "accepted", lease: wrongModeLease });

		expect(messages.at(-2)).toEqual({ type: "withdraw", lease: wrongModeLease });
		expect(messages.at(-1)).toMatchObject({ type: "presenter_needed", need: { mode: "rich", leaseEpoch: 3 } });
		expect(authority.status("session-a")).toEqual({ state: "offered", queueDepth: 1 });
	});

	it("terminates every queued request for a session and releases private presentation state", async () => {
		const { authority, mirror, messages } = harness();
		syncRich(mirror);
		const first = authority.request("session-a", request);
		const second = authority.request("session-a", request);
		const lease = acceptLatest(authority, messages);

		expect(authority.terminateSession("session-a", "extension-reload")).toBe(2);
		await expect(first.outcome).resolves.toEqual({ status: "terminated", reason: "extension-reload" });
		await expect(second.outcome).resolves.toEqual({ status: "terminated", reason: "extension-reload" });
		expect(authority.status("session-a")).toEqual({ state: undefined, queueDepth: 0 });
		expect(authority.presentationSnapshot(first.logicalRequestId)).toBeUndefined();
		expect(messages.at(-1)).toEqual({ type: "withdraw", lease });
	});

	it("preserves acknowledged authority across generation rollover and aborts without fabricating dismissal", async () => {
		const { authority, mirror, messages } = harness();
		syncRich(mirror);
		const controller = new AbortController();
		const pending = authority.request("session-a", request, { signal: controller.signal });
		const oldLease = acceptLatest(authority, messages);
		authority.checkpoint(mutation(oldLease, 0, "checkpoint-a", editedDraft()));

		syncRich(mirror, "generation-b", 1, "connection-b");
		authority.handleUiClientsChanged();
		const newNeed = messages.at(-1);
		expect(newNeed).toMatchObject({
			type: "presenter_needed",
			need: { supervisorGeneration: "generation-b", leaseEpoch: 2, mode: "rich" },
		});
		controller.abort();
		expect(await pending.outcome).toEqual({ status: "aborted", reason: "signal" });
		expect(authority.status("session-a")).toEqual({ state: undefined, queueDepth: 0 });
	});
});

import type { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import {
	isDaemonWorkerFrameHeader,
	isWorkerQuestionnaireBrokerMessage,
	type WorkerQuestionnaireBrokerMessage,
	type WorkerQuestionnairePresentationMessage,
} from "../src/modes/daemon/daemon-worker-protocol.js";
import { PrivateFrameDecoder } from "../src/modes/session-worker/private-framing.js";

function supervisorClient(write: ReturnType<typeof vi.fn>): DaemonSocketClient {
	return {
		connectionId: "private-connection",
		logicalClientId: "supervisor",
		socket: { destroyed: false, write } as unknown as Socket,
		attachedActiveSessionIds: new Set(),
		catchupActiveSessionIds: new Set(),
		backpressured: false,
		authenticated: true,
		transport: "private-framed",
		detachInput: () => {},
		supportsExtensionUi: false,
		capabilities: new Set(),
	};
}

describe("worker questionnaire broker transport", () => {
	it("emits content-free needs only on the authenticated private supervisor frame", () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-worker-questionnaire.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-worker-questionnaire", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
			worker: { authenticationToken: "worker-token" },
		});
		const writes: Buffer[] = [];
		const write = vi.fn((chunk: Uint8Array) => {
			writes.push(Buffer.from(chunk));
			return true;
		});
		const client = supervisorClient(write);
		const internals = daemon as unknown as {
			supervisorClaims: Map<DaemonSocketClient, unknown>;
			sendWorkerQuestionnaireBrokerMessage(message: WorkerQuestionnaireBrokerMessage): boolean;
			sendWorkerQuestionnairePresentation(message: WorkerQuestionnairePresentationMessage): boolean;
		};
		internals.supervisorClaims.set(client, {});
		const message: WorkerQuestionnaireBrokerMessage = {
			type: "presenter_needed",
			need: {
				supervisorGeneration: "generation-a",
				activeSessionId: "session-a",
				logicalRequestId: "request-a",
				offerId: "offer-a",
				leaseEpoch: 1,
				createdAt: 1,
				mode: "undecided",
			},
		};

		expect(internals.sendWorkerQuestionnaireBrokerMessage(message)).toBe(true);
		expect(write).toHaveBeenCalledOnce();
		const decoder = new PrivateFrameDecoder(isDaemonWorkerFrameHeader);
		const frames = decoder.push(writes[0]!);
		expect(frames).toHaveLength(1);
		expect(frames[0]!.header).toEqual({ kind: "questionnaire_broker", messageType: "presenter_needed" });
		expect(JSON.parse(frames[0]!.payload.toString("utf8"))).toEqual(message);
		expect(frames[0]!.payload.toString("utf8")).not.toMatch(/prompt|draft|answer/i);
	});
	it("accepts a content-free v2 need and rejects legacy v2 routing", () => {
		const need = {
			type: "presenter_needed",
			need: {
				supervisorGeneration: "generation-a",
				activeSessionId: "session-a",
				logicalRequestId: "request-a",
				offerId: "offer-a",
				leaseEpoch: 1,
				createdAt: 1,
				mode: "undecided",
				questionnaireVersion: 2,
			},
		};
		expect(isWorkerQuestionnaireBrokerMessage(need)).toBe(true);
		expect(isWorkerQuestionnaireBrokerMessage({ ...need, need: { ...need.need, mode: "legacy" } })).toBe(false);
		expect(JSON.stringify(need)).not.toMatch(/prompt|draft|note|preview/i);
	});

	it("rejects value-bearing or extra fields from the private broker control payload", () => {
		expect(
			isWorkerQuestionnaireBrokerMessage({
				type: "presenter_needed",
				need: {
					supervisorGeneration: "generation-a",
					activeSessionId: "session-a",
					logicalRequestId: "request-a",
					offerId: "offer-a",
					leaseEpoch: 1,
					createdAt: 1,
					mode: "undecided",
					prompt: "must not cross broker control transport",
				},
			}),
		).toBe(false);
	});

	it("accepts only typed private legacy primitive requests", () => {
		const message = {
			type: "legacy_request",
			activeSessionId: "session-a",
			lease: {
				supervisorGeneration: "generation-a",
				logicalRequestId: "request-a",
				offerId: "offer-a",
				leaseEpoch: 1,
				logicalClientId: "logical-a",
				connectionId: "connection-a",
				mode: "legacy",
			},
			requestId: "step-a",
			request: { method: "select", payload: { title: "private", options: ["A"] } },
		};
		expect(isWorkerQuestionnaireBrokerMessage(message)).toBe(true);
		expect(
			isWorkerQuestionnaireBrokerMessage({
				...message,
				request: { method: "select", payload: { title: "private", options: ["A"], extra: true } },
			}),
		).toBe(false);
		expect(isDaemonWorkerFrameHeader({ kind: "questionnaire_broker", messageType: "legacy_request" })).toBe(true);
	});

	it("frames targeted presentation content separately with exact lease and revision stamps", () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-worker-questionnaire-presentation.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-worker-questionnaire", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
			worker: { authenticationToken: "worker-token" },
		});
		const writes: Buffer[] = [];
		const client = supervisorClient(
			vi.fn((chunk: Uint8Array) => {
				writes.push(Buffer.from(chunk));
				return true;
			}),
		);
		const internals = daemon as unknown as {
			supervisorClaims: Map<DaemonSocketClient, unknown>;
			sendWorkerQuestionnairePresentation(message: WorkerQuestionnairePresentationMessage): boolean;
		};
		internals.supervisorClaims.set(client, {});
		const message: WorkerQuestionnairePresentationMessage = {
			activeSessionId: "session-a",
			snapshot: {
				lease: {
					supervisorGeneration: "generation-a",
					logicalRequestId: "request-a",
					offerId: "offer-a",
					leaseEpoch: 3,
					logicalClientId: "logical-a",
					connectionId: "connection-a",
					mode: "rich",
				},
				authoritativeRevision: 7,
				request: { version: 1, questions: [{ id: "q", kind: "short-text", prompt: "private prompt" }] },
				draft: {
					version: 1,
					currentStep: { kind: "question", questionId: "q" },
					states: [{ questionId: "q", kind: "short-text", value: "private draft" }],
				},
			},
		};

		expect(internals.sendWorkerQuestionnairePresentation(message)).toBe(true);
		const frames = new PrivateFrameDecoder(isDaemonWorkerFrameHeader).push(writes[0]!);
		expect(frames[0]!.header).toMatchObject({
			kind: "questionnaire_presentation",
			supervisorGeneration: "generation-a",
			activeSessionId: "session-a",
			connectionId: "connection-a",
			logicalRequestId: "request-a",
			offerId: "offer-a",
			leaseEpoch: 3,
			authoritativeRevision: 7,
		});
		expect(JSON.parse(frames[0]!.payload.toString("utf8"))).toEqual(message);
	});
});

import { mkdtempSync, rmSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import type { DaemonCommand, DaemonResponse } from "../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import type {
	DaemonWorkerCommand,
	DaemonWorkerFrameHeader,
	WorkerQuestionnaireBrokerMessage,
} from "../src/modes/daemon/daemon-worker-protocol.js";
import { SupervisorWorkerUiClientsSync } from "../src/modes/daemon/daemon-worker-ui-clients.js";

const tempDirs: string[] = [];
afterEach(() => {
	for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function socketClient(connectionId: string, activeSessionId: string, presentable: boolean): DaemonSocketClient {
	return {
		connectionId,
		logicalClientId: `logical-${connectionId}`,
		socket: { destroyed: false, write: vi.fn(() => true) } as unknown as Socket,
		attachedActiveSessionIds: new Set([activeSessionId]),
		catchupActiveSessionIds: new Set(),
		backpressured: false,
		authenticated: true,
		detachInput: () => {},
		supportsExtensionUi: true,
		capabilities: new Set(["extension_ui", "questionnaire_v1"]),
		questionnairePresentableActiveSessionIds: new Set(presentable ? [activeSessionId] : []),
	};
}

describe("daemon supervisor questionnaire brokerage", () => {
	it("revokes a rich lease without tearing down the worker path when its presenter vanished", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-questionnaire-vanished-"));
		tempDirs.push(root);
		const supervisor = new DaemonSupervisor(join(root, "daemon.sock"), {
			descriptorDir: join(root, "workers"),
			defaultSessionConfig: { agentDir: join(root, "agent"), cwd: root },
		});
		const internals = supervisor as unknown as {
			handleWorkerFrame(worker: unknown, frame: { header: DaemonWorkerFrameHeader; payload: Buffer }): void;
			questionnaireBroker: {
				routeToLease: (...args: unknown[]) => boolean;
				presentationError: (...args: unknown[]) => "accepted" | "stale";
			};
		};
		vi.spyOn(internals.questionnaireBroker, "routeToLease").mockImplementation((...args: unknown[]) => {
			const deliver = args[3] as (connectionId: string) => void;
			deliver("vanished-connection");
			return true;
		});
		const presentationError = vi
			.spyOn(internals.questionnaireBroker, "presentationError")
			.mockReturnValue("accepted");
		const lease = {
			supervisorGeneration: "generation-a",
			logicalRequestId: "request-a",
			offerId: "offer-a",
			leaseEpoch: 1,
			logicalClientId: "logical-a",
			connectionId: "vanished-connection",
			mode: "rich" as const,
		};
		const frame = {
			header: {
				kind: "questionnaire_presentation" as const,
				supervisorGeneration: lease.supervisorGeneration,
				activeSessionId: "session-a",
				connectionId: lease.connectionId,
				logicalRequestId: lease.logicalRequestId,
				offerId: lease.offerId,
				leaseEpoch: lease.leaseEpoch,
				authoritativeRevision: 0,
			},
			payload: Buffer.from(
				JSON.stringify({
					activeSessionId: "session-a",
					snapshot: {
						lease,
						authoritativeRevision: 0,
						request: { version: 1, questions: [{ id: "q", kind: "short-text", prompt: "private" }] },
						draft: {
							version: 1,
							currentStep: { kind: "question", questionId: "q" },
							states: [{ questionId: "q", kind: "short-text", value: "" }],
						},
					},
				}),
			),
		};

		expect(() => internals.handleWorkerFrame({ descriptor: { workerId: "worker-a" } }, frame)).not.toThrow();
		expect(presentationError).toHaveBeenCalledWith("vanished-connection", "session-a", lease);
	});

	it("keeps a presentable client eligible after a transient busy offer response", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-questionnaire-busy-"));
		tempDirs.push(root);
		const supervisor = new DaemonSupervisor(join(root, "daemon.sock"), {
			descriptorDir: join(root, "workers"),
			defaultSessionConfig: { agentDir: join(root, "agent"), cwd: root },
		});
		const client = socketClient("connection-a", "session-a", true);
		const internals = supervisor as unknown as {
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonResponse | undefined>;
			questionnaireBroker: { respondToOffer: (...args: unknown[]) => "accepted" | "stale" };
		};
		vi.spyOn(internals.questionnaireBroker, "respondToOffer").mockReturnValue("accepted");
		const lease = {
			supervisorGeneration: "generation-a",
			logicalRequestId: "request-a",
			offerId: "offer-a",
			leaseEpoch: 1,
			logicalClientId: client.logicalClientId,
			connectionId: client.connectionId,
			mode: "rich" as const,
		};

		await internals.handleCommand(client, {
			type: "questionnaire_offer_response",
			activeSessionId: "session-a",
			lease,
			response: "busy",
		});

		expect(client.questionnairePresentableActiveSessionIds).toContain("session-a");
	});

	it("targets one presentable socket and stamps responses from the real connection", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-questionnaire-broker-"));
		tempDirs.push(root);
		const supervisor = new DaemonSupervisor(join(root, "daemon.sock"), {
			descriptorDir: join(root, "workers"),
			defaultSessionConfig: { agentDir: join(root, "agent"), cwd: root },
		});
		const target = socketClient("connection-a", "session-a", true);
		const observer = socketClient("connection-b", "session-a", false);
		const requestWorker = vi.fn(
			async (_command: DaemonWorkerCommand): Promise<DaemonResponse> => ({
				type: "response",
				command: _command.type,
				success: true,
			}),
		);
		const internals = supervisor as unknown as {
			generation: string;
			clients: Set<DaemonSocketClient>;
			workers: Map<string, unknown>;
			synchronizeQuestionnairePresenters(): void;
			handleWorkerFrame(worker: unknown, frame: { header: DaemonWorkerFrameHeader; payload: Buffer }): void;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonResponse | undefined>;
			questionnaireBroker: { disconnect(connectionId: string): void };
			pendingLegacyQuestionnaireRequests: Map<string, unknown>;
		};
		internals.clients.add(target);
		internals.clients.add(observer);
		const worker = {
			descriptor: {
				workerId: "worker-a",
				rootActiveSessionId: "session-a",
				lifecycle: "ready",
			},
			client: { requestWorker },
			summaries: new Map([["session-a", { id: "session-a", activeSessionId: "session-a" }]]),
			snapshotCache: new Map(),
			uiClientsSync: new SupervisorWorkerUiClientsSync(internals.generation),
			uiClientsSyncQueue: Promise.resolve(),
			uiClientsNeedsFullSync: false,
		};
		internals.workers.set("worker-a", worker);
		internals.synchronizeQuestionnairePresenters();
		const brokerMessage: WorkerQuestionnaireBrokerMessage = {
			type: "presenter_needed",
			need: {
				supervisorGeneration: internals.generation,
				activeSessionId: "session-a",
				logicalRequestId: "request-a",
				offerId: "offer-a",
				leaseEpoch: 1,
				createdAt: 1,
				mode: "undecided",
			},
		};
		internals.handleWorkerFrame(worker, {
			header: { kind: "questionnaire_broker", messageType: "presenter_needed" },
			payload: Buffer.from(JSON.stringify(brokerMessage)),
		});

		expect(target.socket.write).toHaveBeenCalledOnce();
		expect(observer.socket.write).not.toHaveBeenCalled();
		const outbound = JSON.parse(String(vi.mocked(target.socket.write).mock.calls[0]![0])) as {
			type: string;
			activeSessionId: string;
			lease: {
				supervisorGeneration: string;
				logicalRequestId: string;
				offerId: string;
				leaseEpoch: number;
				connectionId: string;
				logicalClientId: string;
				mode: string;
			};
		};
		expect(outbound).toMatchObject({
			type: "questionnaire_offer",
			activeSessionId: "session-a",
			lease: { connectionId: "connection-a", logicalClientId: "logical-connection-a", mode: "rich" },
		});

		const stale = await internals.handleCommand(observer, {
			type: "questionnaire_offer_response",
			activeSessionId: "session-a",
			lease: outbound.lease as never,
			response: "accepted",
		});
		expect(stale).toMatchObject({ success: true, data: { status: "stale" } });
		expect(requestWorker).not.toHaveBeenCalled();

		const accepted = await internals.handleCommand(target, {
			type: "questionnaire_offer_response",
			activeSessionId: "session-a",
			lease: outbound.lease as never,
			response: "accepted",
		});
		expect(accepted).toMatchObject({ success: true, data: { status: "accepted" } });
		await vi.waitFor(() =>
			expect(requestWorker).toHaveBeenCalledWith({
				type: "worker_questionnaire_offer_result",
				result: { status: "accepted", lease: outbound.lease },
			}),
		);
		requestWorker.mockClear();
		const presentation = {
			activeSessionId: "session-a",
			snapshot: {
				lease: outbound.lease,
				authoritativeRevision: 0,
				request: { version: 1 as const, questions: [{ id: "q", kind: "short-text" as const, prompt: "private" }] },
				draft: {
					version: 1 as const,
					currentStep: { kind: "question" as const, questionId: "q" },
					states: [{ questionId: "q", kind: "short-text" as const, value: "draft" }],
				},
			},
		};
		internals.handleWorkerFrame(worker, {
			header: {
				kind: "questionnaire_presentation",
				supervisorGeneration: outbound.lease.supervisorGeneration,
				activeSessionId: "session-a",
				connectionId: "connection-a",
				logicalRequestId: "request-a",
				offerId: "offer-a",
				leaseEpoch: 1,
				authoritativeRevision: 0,
			},
			payload: Buffer.from(JSON.stringify(presentation)),
		});
		expect(target.socket.write).toHaveBeenCalledTimes(2);
		expect(observer.socket.write).not.toHaveBeenCalled();
		expect(JSON.parse(String(vi.mocked(target.socket.write).mock.calls[1]![0]))).toMatchObject({
			type: "questionnaire_presentation_snapshot",
			activeSessionId: "session-a",
			lease: { connectionId: "connection-a" },
			request: { questions: [{ prompt: "private" }] },
		});

		await internals.handleCommand(target, {
			type: "questionnaire_checkpoint",
			activeSessionId: "session-a",
			lease: { ...outbound.lease, connectionId: "forged", logicalClientId: "forged" } as never,
			baseRevision: 0,
			clientMutationId: "mutation-a",
			completeDraft: presentation.snapshot.draft,
		});
		expect(requestWorker).toHaveBeenCalledWith({
			type: "worker_questionnaire_checkpoint",
			lease: outbound.lease,
			baseRevision: 0,
			clientMutationId: "mutation-a",
			completeDraft: presentation.snapshot.draft,
		});
		await internals.handleCommand(target, {
			type: "questionnaire_dismiss",
			activeSessionId: "session-a",
			lease: { ...outbound.lease, connectionId: "forged" } as never,
		});
		expect(requestWorker).toHaveBeenCalledWith({
			type: "worker_questionnaire_dismiss",
			lease: outbound.lease,
		});

		internals.handleWorkerFrame(worker, {
			header: { kind: "outbound", outboundType: "session_status", activeSessionId: "session-a" },
			payload: Buffer.from(
				JSON.stringify({
					type: "session_status",
					activeSessionId: "session-a",
					questionnaireState: "presenting",
					questionnaireQueueDepth: 2,
				}),
			),
		});
		expect(worker.summaries.get("session-a")).toMatchObject({
			questionnaireState: "presenting",
			questionnaireQueueDepth: 2,
		});

		internals.handleWorkerFrame(worker, {
			header: { kind: "questionnaire_broker", messageType: "withdraw" },
			payload: Buffer.from(JSON.stringify({ type: "withdraw", lease: outbound.lease })),
		});
		expect(JSON.parse(String(vi.mocked(target.socket.write).mock.calls[3]![0]))).toMatchObject({
			type: "questionnaire_withdraw",
			activeSessionId: "session-a",
			lease: outbound.lease,
		});
		await internals.handleCommand(target, {
			type: "questionnaire_withdraw_ack",
			activeSessionId: "session-a",
			lease: outbound.lease as never,
		});
		await vi.waitFor(() =>
			expect(requestWorker).toHaveBeenCalledWith({
				type: "worker_questionnaire_terminal_ack",
				logicalRequestId: "request-a",
			}),
		);

		internals.questionnaireBroker.disconnect("connection-a");
		requestWorker.mockClear();
		internals.clients.delete(target);
		observer.capabilities = new Set(["extension_ui"]);
		observer.questionnairePresentableActiveSessionIds = new Set(["session-a"]);
		internals.synchronizeQuestionnairePresenters();
		const legacyMessage: WorkerQuestionnaireBrokerMessage = {
			type: "presenter_needed",
			need: {
				supervisorGeneration: internals.generation,
				activeSessionId: "session-a",
				logicalRequestId: "request-legacy",
				offerId: "offer-legacy",
				leaseEpoch: 2,
				createdAt: 2,
				mode: "undecided",
			},
		};
		internals.handleWorkerFrame(worker, {
			header: { kind: "questionnaire_broker", messageType: "presenter_needed" },
			payload: Buffer.from(JSON.stringify(legacyMessage)),
		});
		const legacyLease = {
			supervisorGeneration: internals.generation,
			logicalRequestId: "request-legacy",
			offerId: "offer-legacy",
			leaseEpoch: 2,
			logicalClientId: "logical-connection-b",
			connectionId: "connection-b",
			mode: "legacy" as const,
		};
		await vi.waitFor(() =>
			expect(requestWorker).toHaveBeenCalledWith({
				type: "worker_questionnaire_offer_result",
				result: { status: "accepted", lease: legacyLease },
			}),
		);

		const legacyRequest: WorkerQuestionnaireBrokerMessage = {
			type: "legacy_request",
			activeSessionId: "session-a",
			lease: legacyLease,
			requestId: "legacy-step-a",
			request: { method: "select", payload: { title: "Private legacy prompt", options: ["Submit"] } },
		};
		internals.handleWorkerFrame(worker, {
			header: { kind: "questionnaire_broker", messageType: "legacy_request" },
			payload: Buffer.from(JSON.stringify(legacyRequest)),
		});
		expect(JSON.parse(String(vi.mocked(observer.socket.write).mock.calls.at(-1)![0]))).toEqual({
			type: "extension_ui_request",
			activeSessionId: "session-a",
			id: "legacy-step-a",
			method: "select",
			payload: { title: "Private legacy prompt", options: ["Submit"] },
		});

		const staleLegacyResponse = await internals.handleCommand(target, {
			type: "extension_ui_response",
			activeSessionId: "session-a",
			requestId: "legacy-step-a",
			response: { value: "Submit" },
		});
		expect(staleLegacyResponse).toMatchObject({ success: true, data: { status: "stale" } });
		requestWorker.mockClear();
		await internals.handleCommand(observer, {
			type: "extension_ui_response",
			activeSessionId: "session-a",
			requestId: "legacy-step-a",
			response: { value: "Submit" },
		});
		expect(requestWorker).toHaveBeenCalledWith({
			type: "worker_questionnaire_legacy_response",
			lease: legacyLease,
			requestId: "legacy-step-a",
			connectionId: "connection-b",
			response: { value: "Submit" },
		});

		internals.handleWorkerFrame(worker, {
			header: { kind: "questionnaire_broker", messageType: "legacy_request" },
			payload: Buffer.from(JSON.stringify({ ...legacyRequest, requestId: "legacy-step-b" })),
		});
		expect(internals.pendingLegacyQuestionnaireRequests.has("legacy-step-b")).toBe(true);
		expect(JSON.stringify([...internals.pendingLegacyQuestionnaireRequests])).not.toMatch(
			/Private legacy prompt|Submit/u,
		);
		requestWorker.mockClear();
		internals.questionnaireBroker.disconnect("connection-b");
		expect(internals.pendingLegacyQuestionnaireRequests.size).toBe(0);
		await vi.waitFor(() =>
			expect(requestWorker).toHaveBeenCalledWith({
				type: "worker_questionnaire_lease_revoked",
				lease: legacyLease,
				reason: "client_lost",
			}),
		);
	});
});

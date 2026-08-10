import type { Socket } from "node:net";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import {
	createDaemonCommandEnvelope,
	DAEMON_PROTOCOL_INFO,
	type DaemonAttachResult,
	type DaemonClientCapability,
	type DaemonCommand,
	type DaemonResponse,
	success,
} from "../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import { MutationDrainLatch } from "../src/modes/daemon/mutation-drain-latch.js";
import { type Deferred, createDeferred as deferred } from "./suite/scheduling.js";

interface AdmissionRecord {
	client: DaemonSocketClient;
	activeSessionId: string;
	publicAdmissionId: string;
	workerAdmissionId: string;
	status: "waiting" | "owned" | "cancelled";
	controller: AbortController;
	worker?: unknown;
	workerActiveSessionId?: string;
}

interface SupervisorHarness {
	handleConnection(socket: Socket): void;
	handleLine(client: DaemonSocketClient, line: string): Promise<void>;
	clients: Set<DaemonSocketClient>;
	workers: Map<string, unknown>;
	promptAdmissions: Map<DaemonSocketClient, Map<string, AdmissionRecord>>;
	commandJournal: { acknowledge: ReturnType<typeof vi.fn> };
	protocolClientId(client: DaemonSocketClient): string;
	handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonResponse | undefined>;
	attachClient(client: DaemonSocketClient, command: Extract<DaemonCommand, { type: "attach" }>): Promise<unknown>;
}

function client(logicalClientId: string): DaemonSocketClient {
	return {
		connectionId: `connection-${logicalClientId}`,
		logicalClientId,
		protocolClientId: logicalClientId,
		socket: { destroyed: false } as DaemonSocketClient["socket"],
		attachedActiveSessionIds: new Set(),
		detachInput: vi.fn(),
		supportsExtensionUi: false,
		capabilities: new Set(),
	};
}

function commandLine(command: DaemonCommand & { id: string }, clientId?: string): string {
	return JSON.stringify(createDaemonCommandEnvelope(command, command.id, clientId));
}

function admissionFor(supervisor: SupervisorHarness, owner: DaemonSocketClient): AdmissionRecord | undefined {
	return [...(supervisor.promptAdmissions.get(owner)?.values() ?? [])][0];
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let index = 0; index < 50; index++) {
		if (predicate()) return;
		await Promise.resolve();
	}
	throw new Error("Condition was not reached");
}

// Constructor-bypass harness: the real constructor spawns watchers and needs a
// socket dir. The field list is hand-coupled to what handleLine touches.
function createHarness(
	options: {
		ready?: Promise<void>;
		assertCurrent?: () => Promise<void>;
		findWorker?: (client: DaemonSocketClient, selector: string) => Promise<unknown>;
		forwardToWorker?: (worker: unknown, command: DaemonCommand) => Promise<DaemonResponse>;
		commandJournal?: {
			lookup: ReturnType<typeof vi.fn>;
			begin: ReturnType<typeof vi.fn>;
			recordResult: ReturnType<typeof vi.fn>;
			acknowledge: ReturnType<typeof vi.fn>;
		};
		updateRestartPhase?: "draining" | "fencing" | "prepared";
	} = {},
): SupervisorHarness {
	return Object.assign(Object.create(DaemonSupervisor.prototype), {
		ready: options.ready ?? Promise.resolve(),
		ownership: {
			assertCurrent: options.assertCurrent ?? vi.fn(async () => undefined),
			record: { token: "test-owner", processStartId: "test-process", socketPath: "/tmp/test.sock" },
		},
		workers: new Map(),
		clients: new Set(),
		protocolClientIds: new WeakMap(),
		promptAdmissions: new Map(),
		mutationDrain: new MutationDrainLatch(),
		commandJournal: options.commandJournal ?? {
			lookup: vi.fn(() => undefined),
			begin: vi.fn(() => ({ status: "new" })),
			recordResult: vi.fn(),
			acknowledge: vi.fn(),
		},
		updateRestartPhase: options.updateRestartPhase,
		...(options.findWorker ? { findWorkerForClient: options.findWorker } : {}),
		...(options.forwardToWorker ? { forwardToWorker: options.forwardToWorker } : {}),
		streamReconstructor: { seed: vi.fn() },
		syncWorkerExtensionUi: vi.fn(async () => undefined),
		write: vi.fn(),
		log: vi.fn(),
	}) as SupervisorHarness;
}

function createOwnedIdentityWorker(ownerClientId: string) {
	const summary = (activeSessionId: string) => ({
		id: activeSessionId,
		activeSessionId,
		lifecycle: "live" as const,
		activity: "idle" as const,
		isSessionActive: false,
		sessionId: `${activeSessionId}-session`,
		cwd: "/tmp/project",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 0,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
	});
	const root = summary("owned-root");
	const target = summary("owned-target");
	const attachResult = (sessionSummary: typeof root) =>
		({
			protocol: DAEMON_PROTOCOL_INFO,
			activeSessionId: sessionSummary.activeSessionId,
			snapshot: { summary: sessionSummary, messages: [] },
			replay: { status: "complete", toSequence: 0 },
			lastEventSequence: 0,
			client: { id: ownerClientId, capabilities: [] },
		}) as unknown as DaemonAttachResult;
	const worker = {
		client: {},
		descriptor: {
			workerId: "owned-worker",
			lifecycle: "ready",
			rootActiveSessionId: root.activeSessionId,
			rootSessionId: root.sessionId,
			ownerClientId,
			pid: 1,
		},
		summaries: new Map([
			[root.activeSessionId, root],
			[target.activeSessionId, target],
		]),
		snapshotCache: new Map([
			[root.activeSessionId, attachResult(root)],
			[target.activeSessionId, attachResult(target)],
		]),
		snapshotLoads: new Map(),
		transcriptCaches: new Map(),
		snapshotTransferFrames: new Map(),
	};
	return { worker, root, target };
}

describe("daemon supervisor prompt admission ownership", () => {
	it("owns an immutable connection incarnation separately from caller-supplied logical identity", async () => {
		const supervisor = createHarness();
		const socket = new PassThrough() as unknown as Socket;
		Object.assign(socket, { destroyed: false });

		supervisor.handleConnection(socket);
		await Promise.resolve();

		const connected = [...supervisor.clients][0]!;
		const connectionId = connected.connectionId;
		expect(connectionId).toEqual(expect.any(String));
		expect((supervisor as unknown as { write: ReturnType<typeof vi.fn> }).write).toHaveBeenCalledWith(
			connected,
			expect.objectContaining({
				type: "daemon_hello",
				clientId: connected.logicalClientId,
				connectionId,
			}),
		);

		await supervisor.handleLine(
			connected,
			JSON.stringify(
				createDaemonCommandEnvelope(
					{ type: "future_command" } as unknown as DaemonCommand,
					"future-1",
					"logical-2",
				),
			),
		);

		expect(connected.logicalClientId).toBe("logical-2");
		expect(connected.connectionId).toBe(connectionId);
	});

	it("keeps duplicate logical clients as distinct socket incarnations", async () => {
		const supervisor = createHarness();
		const firstSocket = new PassThrough() as unknown as Socket;
		const secondSocket = new PassThrough() as unknown as Socket;
		Object.assign(firstSocket, { destroyed: false });
		Object.assign(secondSocket, { destroyed: false });
		supervisor.handleConnection(firstSocket);
		supervisor.handleConnection(secondSocket);

		const [first, second] = [...supervisor.clients];
		for (const [index, connected] of [first, second].entries()) {
			await supervisor.handleLine(
				connected!,
				JSON.stringify(
					createDaemonCommandEnvelope(
						{ type: "future_command" } as unknown as DaemonCommand,
						`future-${index}`,
						"shared-logical-client",
					),
				),
			);
		}

		expect(first!.logicalClientId).toBe("shared-logical-client");
		expect(second!.logicalClientId).toBe("shared-logical-client");
		expect(first!.connectionId).toEqual(expect.any(String));
		expect(second!.connectionId).toEqual(expect.any(String));
		expect(first!.connectionId).not.toBe(second!.connectionId);
	});

	it("keeps the envelope protocol owner stable across attach, reattach, and catch-up attachment", async () => {
		const supervisor = createHarness();
		const { worker, root, target } = createOwnedIdentityWorker("protocol-owner");
		(supervisor.workers as Map<string, typeof worker>).set(worker.descriptor.workerId, worker);
		const connected = client("protocol-owner");
		connected.protocolClientId = "protocol-owner";

		await supervisor.attachClient(connected, {
			type: "attach",
			activeSessionId: root.activeSessionId,
			clientId: "logical-after-attach",
		});
		expect(connected.logicalClientId).toBe("logical-after-attach");
		expect(supervisor.protocolClientId(connected)).toBe("protocol-owner");

		await supervisor.handleCommand(connected, {
			type: "reattach",
			activeSessionId: root.activeSessionId,
			targetActiveSessionId: target.activeSessionId,
			clientId: "logical-after-reattach",
		});
		expect(connected.logicalClientId).toBe("logical-after-reattach");
		expect(supervisor.protocolClientId(connected)).toBe("protocol-owner");

		await supervisor.handleCommand(connected, { type: "ack_result", commandId: "owned-result" });
		expect(supervisor.commandJournal.acknowledge).toHaveBeenCalledWith("protocol-owner", "owned-result");

		await expect(
			supervisor.attachClient(connected, { type: "attach", activeSessionId: target.activeSessionId }),
		).resolves.toBeDefined();
		expect(supervisor.protocolClientId(connected)).toBe("protocol-owner");
	});

	it("allowlists unknown capabilities at the public supervisor attach boundary", async () => {
		const supervisor = createHarness();
		const { worker, root } = createOwnedIdentityWorker("protocol-owner");
		(supervisor.workers as Map<string, typeof worker>).set(worker.descriptor.workerId, worker);
		const connected = client("protocol-owner");
		connected.protocolClientId = "protocol-owner";

		await supervisor.attachClient(connected, {
			type: "attach",
			activeSessionId: root.activeSessionId,
			capabilities: ["extension_ui", "unknown_capability"] as unknown as DaemonClientCapability[],
		});

		expect([...connected.capabilities]).toEqual(["extension_ui"]);
	});

	it("pins a clientId-less envelope owner before attach changes logical identity and socket close", async () => {
		const supervisor = createHarness();
		const createOrReuseWorker = vi.fn();
		const scheduleOwnedWorkerCleanup = vi.fn();
		Object.assign(supervisor, { createOrReuseWorker, scheduleOwnedWorkerCleanup });
		const socket = new PassThrough() as unknown as Socket;
		Object.assign(socket, { destroyed: false });
		supervisor.handleConnection(socket);
		const connected = [...supervisor.clients][0]!;
		const ownerClientId = connected.logicalClientId;
		const { worker, root } = createOwnedIdentityWorker(ownerClientId);
		(supervisor.workers as Map<string, typeof worker>).set(worker.descriptor.workerId, worker);
		createOrReuseWorker.mockResolvedValue(worker);

		await supervisor.handleLine(
			connected,
			JSON.stringify(createDaemonCommandEnvelope({ type: "create", lifecycle: "client_owned" }, "create-owned")),
		);
		expect(createOrReuseWorker).toHaveBeenCalledWith(
			ownerClientId,
			expect.objectContaining({ type: "create", lifecycle: "client_owned" }),
		);

		await supervisor.handleLine(
			connected,
			JSON.stringify(
				createDaemonCommandEnvelope(
					{ type: "attach", activeSessionId: root.activeSessionId, clientId: "logical-presenter" },
					"attach-owned",
				),
			),
		);
		expect(connected.logicalClientId).toBe("logical-presenter");

		socket.emit("close");
		expect(connected.protocolClientId).toBe(ownerClientId);
		expect(scheduleOwnedWorkerCleanup).toHaveBeenCalledWith(worker);
	});

	it("cleans up the envelope-owned worker after attach changes logical identity and the socket closes", async () => {
		const supervisor = createHarness();
		const { worker, root } = createOwnedIdentityWorker("protocol-owner");
		(supervisor.workers as Map<string, typeof worker>).set(worker.descriptor.workerId, worker);
		const createOrReuseWorker = vi.fn(async () => worker);
		const scheduleOwnedWorkerCleanup = vi.fn();
		Object.assign(supervisor, { createOrReuseWorker, scheduleOwnedWorkerCleanup });
		const socket = new PassThrough() as unknown as Socket;
		Object.assign(socket, { destroyed: false });
		supervisor.handleConnection(socket);
		const connected = [...supervisor.clients][0]!;
		const connectionId = connected.connectionId;
		expect(connected.protocolClientId).toBeUndefined();

		await supervisor.handleLine(
			connected,
			JSON.stringify(
				createDaemonCommandEnvelope(
					{ type: "create", lifecycle: "client_owned" },
					"create-owned",
					"protocol-owner",
				),
			),
		);
		expect(createOrReuseWorker).toHaveBeenCalledWith(
			"protocol-owner",
			expect.objectContaining({ type: "create", lifecycle: "client_owned" }),
		);

		await supervisor.handleLine(
			connected,
			JSON.stringify({
				...createDaemonCommandEnvelope(
					{
						type: "attach",
						activeSessionId: root.activeSessionId,
						clientId: "logical-presenter",
					} as Extract<DaemonCommand, { type: "attach" }>,
					"attach-owned",
					"protocol-owner",
				),
				connectionId: "forged-envelope-connection",
				command: {
					type: "attach",
					activeSessionId: root.activeSessionId,
					clientId: "logical-presenter",
					connectionId: "forged-attach-connection",
				},
			}),
		);

		expect(connected.logicalClientId).toBe("logical-presenter");
		expect(connected.protocolClientId).toBe("protocol-owner");
		expect(supervisor.protocolClientId(connected)).toBe("protocol-owner");
		expect(connected.connectionId).toBe(connectionId);
		expect(connected.connectionId).not.toBe("forged-envelope-connection");
		expect(connected.connectionId).not.toBe("forged-attach-connection");

		socket.emit("close");
		expect(scheduleOwnedWorkerCleanup).toHaveBeenCalledWith(worker);
	});

	it("registers a prompt synchronously before readiness and ownership awaits", async () => {
		const ready = deferred<void>();
		const ownership = deferred<void>();
		const workerLookup = deferred<unknown>();
		const supervisor = createHarness({
			ready: ready.promise,
			assertCurrent: () => ownership.promise,
			findWorker: vi.fn(() => workerLookup.promise),
		});
		const owner = client("connection-owner");
		const prompt = {
			id: "prompt-1",
			type: "prompt",
			activeSessionId: "session-1",
			admissionId: "public-admission",
			message: "hello",
		} satisfies DaemonCommand;

		const pendingPrompt = supervisor.handleLine(owner, commandLine(prompt));
		const admission = admissionFor(supervisor, owner);
		expect(admission).toMatchObject({
			client: owner,
			activeSessionId: "session-1",
			publicAdmissionId: "public-admission",
			status: "waiting",
		});

		ready.resolve();
		await Promise.resolve();
		expect(admissionFor(supervisor, owner)).toBe(admission);
		ownership.resolve();
		await Promise.resolve();
		expect(admissionFor(supervisor, owner)).toBe(admission);
		workerLookup.reject(new Error("worker lookup stopped"));
		await pendingPrompt;
		expect(admissionFor(supervisor, owner)).toBeUndefined();
	});

	it("cleans up restart-fenced prompt admissions so the same id can retry", async () => {
		const supervisor = createHarness();
		(supervisor as unknown as { updateRestartPhase: "fencing" }).updateRestartPhase = "fencing";
		const owner = client("connection-owner");
		const prompt = {
			id: "prompt-1",
			type: "prompt",
			activeSessionId: "session-1",
			admissionId: "retryable-admission",
			message: "hello",
		} satisfies DaemonCommand;

		await supervisor.handleLine(owner, commandLine(prompt));
		expect(supervisor.promptAdmissions.size).toBe(0);

		await supervisor.handleLine(owner, commandLine({ ...prompt, id: "prompt-2" }));
		expect(supervisor.promptAdmissions.size).toBe(0);
	});

	it("rejects restart-fenced cancellation before mutating its admission", async () => {
		const supervisor = createHarness({ updateRestartPhase: "fencing" });
		const owner = client("connection-owner");
		const admission: AdmissionRecord = {
			client: owner,
			activeSessionId: "session-1",
			publicAdmissionId: "public-admission",
			workerAdmissionId: "worker-admission",
			status: "waiting",
			controller: new AbortController(),
		};
		supervisor.promptAdmissions.set(owner, new Map([["session-1\0public-admission", admission]]));

		await supervisor.handleLine(
			owner,
			commandLine({
				id: "cancel-1",
				type: "cancel_prompt_admission",
				activeSessionId: "session-1",
				admissionId: "public-admission",
			} satisfies DaemonCommand),
		);

		expect(admission.status).toBe("waiting");
		expect(admission.controller.signal.aborted).toBe(false);
	});

	it("admits only one concurrent mutation with the same journal identity", async () => {
		let begun = false;
		const commandJournal = {
			lookup: vi.fn(() => undefined),
			begin: vi.fn(() => {
				if (begun) return { status: "pending" as const };
				begun = true;
				return { status: "new" as const };
			}),
			recordResult: vi.fn(),
			acknowledge: vi.fn(),
		};
		const forward = deferred<DaemonResponse>();
		const supervisor = createHarness({
			commandJournal,
			findWorker: vi.fn(async () => ({
				worker: { descriptor: { lifecycle: "ready", rootActiveSessionId: "session-1" } },
				summary: { id: "session-1", activeSessionId: "session-1" },
			})),
			forwardToWorker: vi.fn(() => forward.promise),
		});
		const owner = client("connection-owner");
		const command = createDaemonCommandEnvelope(
			{ id: "prompt-1", type: "prompt", activeSessionId: "session-1", message: "hello" },
			"prompt-1",
			"logical-client",
		);

		const first = supervisor.handleLine(owner, JSON.stringify(command));
		const second = supervisor.handleLine(owner, JSON.stringify(command));
		await waitFor(() => commandJournal.begin.mock.calls.length === 2);
		expect(
			(supervisor as unknown as { forwardToWorker: ReturnType<typeof vi.fn> }).forwardToWorker,
		).toHaveBeenCalledOnce();
		forward.resolve({ type: "response", command: "prompt", success: true });
		await Promise.all([first, second]);
	});

	it("lets the originating connection cancel before worker lookup starts", async () => {
		const ready = deferred<void>();
		const findWorker = vi.fn(async () => {
			throw new Error("worker lookup should not run");
		});
		const supervisor = createHarness({ ready: ready.promise, findWorker });
		const owner = client("connection-owner");
		const pendingPrompt = supervisor.handleLine(
			owner,
			commandLine({
				id: "prompt-1",
				type: "prompt",
				activeSessionId: "session-1",
				admissionId: "public-admission",
				message: "hello",
			} satisfies DaemonCommand),
		);
		const pendingCancel = supervisor.handleLine(
			owner,
			commandLine({
				id: "cancel-1",
				type: "cancel_prompt_admission",
				activeSessionId: "session-1",
				admissionId: "public-admission",
			} satisfies DaemonCommand),
		);

		await pendingPrompt;
		expect(findWorker).not.toHaveBeenCalled();
		ready.resolve();
		await pendingCancel;
		expect(admissionFor(supervisor, owner)).toBeUndefined();
	});

	it("returns the captured outcome when cancellation handling follows prompt cleanup", async () => {
		const cancelOwnership = deferred<void>();
		let ownershipChecks = 0;
		const workerPrompt = deferred<DaemonResponse>();
		const worker = { descriptor: { lifecycle: "ready", rootActiveSessionId: "worker-session" } };
		const supervisor = createHarness({
			assertCurrent: () => (++ownershipChecks === 2 ? cancelOwnership.promise : Promise.resolve()),
			findWorker: vi.fn(async () => ({
				worker,
				summary: { id: "worker-session", activeSessionId: "worker-session" },
			})),
			forwardToWorker: vi.fn(async () => workerPrompt.promise),
		});
		const owner = client("connection-owner");
		const pendingPrompt = supervisor.handleLine(
			owner,
			commandLine({
				id: "prompt-1",
				type: "prompt",
				activeSessionId: "session-1",
				admissionId: "public-admission",
				message: "hello",
			} satisfies DaemonCommand),
		);
		await waitFor(() => admissionFor(supervisor, owner)?.worker !== undefined);
		const pendingCancel = supervisor.handleLine(
			owner,
			commandLine({
				id: "cancel-1",
				type: "cancel_prompt_admission",
				activeSessionId: "session-1",
				admissionId: "public-admission",
			} satisfies DaemonCommand),
		);
		workerPrompt.resolve({ type: "response", command: "prompt", success: true });
		await pendingPrompt;
		expect(admissionFor(supervisor, owner)).toBeUndefined();
		cancelOwnership.resolve();
		await pendingCancel;

		expect((supervisor as unknown as { write: ReturnType<typeof vi.fn> }).write).toHaveBeenLastCalledWith(
			owner,
			expect.objectContaining({ success: true, data: { status: "owned" } }),
		);
	});

	it("never downgrades a cancelled admission on repeated cancels", async () => {
		const worker = { descriptor: { lifecycle: "ready", rootActiveSessionId: "worker-session" } };
		const forwardToWorker = vi.fn(async (_worker: unknown, command: DaemonCommand) => {
			if (command.type === "cancel_prompt_admission") {
				return success(command.id, command.type, { status: "unknown" as const });
			}
			return new Promise<DaemonResponse>(() => {});
		});
		const supervisor = createHarness({
			findWorker: vi.fn(async () => ({
				worker,
				summary: { id: "worker-session", activeSessionId: "worker-session" },
			})),
			forwardToWorker,
		});
		const owner = client("connection-owner");
		void supervisor.handleLine(
			owner,
			commandLine({
				id: "prompt-1",
				type: "prompt",
				activeSessionId: "session-1",
				admissionId: "public-admission",
				message: "hello",
			} satisfies DaemonCommand),
		);
		await waitFor(() => admissionFor(supervisor, owner)?.worker !== undefined);
		const admission = admissionFor(supervisor, owner);
		expect(admission).toBeDefined();
		if (!admission) throw new Error("admission not registered");
		admission.status = "cancelled";

		await supervisor.handleLine(
			owner,
			commandLine({
				id: "cancel-1",
				type: "cancel_prompt_admission",
				activeSessionId: "session-1",
				admissionId: "public-admission",
			} satisfies DaemonCommand),
		);

		expect(forwardToWorker).not.toHaveBeenCalledWith(
			worker,
			expect.objectContaining({ type: "cancel_prompt_admission" }),
		);
		expect(admission.status).toBe("cancelled");
		expect((supervisor as unknown as { write: ReturnType<typeof vi.fn> }).write).toHaveBeenLastCalledWith(
			owner,
			expect.objectContaining({ success: true, data: { status: "cancelled" } }),
		);
	});

	it("isolates public ids by connection and forwards only opaque worker ids", async () => {
		const ownerA = client("connection-a");
		const ownerB = client("connection-b");
		const attacker = client("connection-attacker");
		const worker = {
			descriptor: { lifecycle: "ready", rootActiveSessionId: "worker-session" },
		};
		const promptResponses = new Map<string, Deferred<DaemonResponse>>();
		const cancelResponses = new Map<string, Deferred<DaemonResponse>>();
		const forwarded: DaemonCommand[] = [];
		const supervisor = createHarness({
			findWorker: vi.fn(async () => ({
				worker,
				summary: { id: "worker-session", activeSessionId: "worker-session" },
			})),
			forwardToWorker: vi.fn(async (_worker, command) => {
				forwarded.push(command);
				const admissionId = "admissionId" in command ? command.admissionId : undefined;
				if (!admissionId) throw new Error("Expected an internal admission id");
				const pending = deferred<DaemonResponse>();
				if (command.type === "cancel_prompt_admission") cancelResponses.set(admissionId, pending);
				else promptResponses.set(admissionId, pending);
				return pending.promise;
			}),
		});
		const makePrompt = (id: string) =>
			({
				id,
				type: "prompt",
				activeSessionId: "public-session",
				admissionId: "shared-public-id",
				message: id,
			}) as const satisfies DaemonCommand;

		const pendingA = supervisor.handleLine(ownerA, commandLine(makePrompt("prompt-a")));
		const pendingB = supervisor.handleLine(ownerB, commandLine(makePrompt("prompt-b")));
		await waitFor(() => promptResponses.size === 2);
		const admissionA = admissionFor(supervisor, ownerA)!;
		const admissionB = admissionFor(supervisor, ownerB)!;
		expect(admissionA.workerAdmissionId).not.toBe(admissionB.workerAdmissionId);
		expect([...promptResponses.keys()].sort()).toEqual(
			[admissionA.workerAdmissionId, admissionB.workerAdmissionId].sort(),
		);
		expect(forwarded.filter((command) => command.type === "prompt")).toEqual([
			expect.objectContaining({ admissionId: admissionA.workerAdmissionId }),
			expect.objectContaining({ admissionId: admissionB.workerAdmissionId }),
		]);

		const spoofedCancel = {
			id: "spoofed-cancel",
			type: "cancel_prompt_admission",
			activeSessionId: "public-session",
			admissionId: "shared-public-id",
		} as const satisfies DaemonCommand;
		await supervisor.handleLine(
			attacker,
			JSON.stringify(createDaemonCommandEnvelope(spoofedCancel, spoofedCancel.id, ownerA.logicalClientId)),
		);
		expect(cancelResponses.size).toBe(0);
		expect(admissionFor(supervisor, ownerA)).toBe(admissionA);
		expect(admissionFor(supervisor, ownerB)).toBe(admissionB);

		const pendingCancelA = supervisor.handleLine(ownerA, commandLine({ ...spoofedCancel, id: "cancel-a" }));
		await waitFor(() => cancelResponses.has(admissionA.workerAdmissionId));
		expect(cancelResponses.has(admissionB.workerAdmissionId)).toBe(false);
		expect(admissionFor(supervisor, ownerA)).toBe(admissionA);

		cancelResponses.get(admissionA.workerAdmissionId)!.resolve({
			id: "worker-cancel",
			type: "response",
			command: "cancel_prompt_admission",
			success: true,
			data: { status: "cancelled" },
		});
		await pendingCancelA;
		// The cancel response must not discard the record while the original forward is unsettled.
		expect(admissionFor(supervisor, ownerA)).toBe(admissionA);
		expect(admissionA.status).toBe("cancelled");

		promptResponses.get(admissionA.workerAdmissionId)!.resolve({
			id: "worker-prompt-a",
			type: "response",
			command: "prompt",
			success: false,
			error: "Prompt admission was cancelled.",
		});
		await pendingA;
		expect(admissionFor(supervisor, ownerA)).toBeUndefined();
		expect(admissionFor(supervisor, ownerB)).toBe(admissionB);

		promptResponses.get(admissionB.workerAdmissionId)!.resolve({
			id: "worker-prompt-b",
			type: "response",
			command: "prompt",
			success: true,
		});
		await pendingB;
		expect(admissionFor(supervisor, ownerB)).toBeUndefined();
	});

	it("cancels a mapped waiting admission when its originating socket closes", async () => {
		const worker = {
			descriptor: { lifecycle: "ready", rootActiveSessionId: "worker-session" },
		};
		const promptResponse = deferred<DaemonResponse>();
		const cancelResponse = deferred<DaemonResponse>();
		const deliveredPrompt = vi.fn();
		const forwarded: DaemonCommand[] = [];
		const supervisor = createHarness({
			findWorker: vi.fn(async () => ({
				worker,
				summary: { id: "worker-session", activeSessionId: "worker-session" },
			})),
			forwardToWorker: vi.fn(async (_worker, command) => {
				forwarded.push(command);
				if (command.type === "cancel_prompt_admission") {
					const response = await cancelResponse.promise;
					promptResponse.resolve({
						type: "response",
						command: "prompt",
						success: false,
						error: "Prompt admission was cancelled.",
					});
					return response;
				}
				return promptResponse.promise.then((response) => {
					if (response.success) deliveredPrompt();
					return response;
				});
			}),
		});
		const socket = new PassThrough() as unknown as Socket;
		Object.assign(socket, { destroyed: false });
		supervisor.handleConnection(socket);
		const owner = [...supervisor.clients][0]!;
		const pendingPrompt = supervisor.handleLine(
			owner,
			commandLine({
				id: "prompt-1",
				type: "prompt",
				activeSessionId: "public-session",
				admissionId: "public-admission",
				message: "must not arrive",
			} satisfies DaemonCommand),
		);
		await waitFor(() => forwarded.some((command) => command.type === "prompt"));
		const admission = admissionFor(supervisor, owner)!;

		socket.emit("close");
		await waitFor(() => forwarded.some((command) => command.type === "cancel_prompt_admission"));
		expect(forwarded.at(-1)).toEqual({
			type: "cancel_prompt_admission",
			activeSessionId: "worker-session",
			admissionId: admission.workerAdmissionId,
		});
		expect(admissionFor(supervisor, owner)).toBe(admission);

		cancelResponse.resolve({
			type: "response",
			command: "cancel_prompt_admission",
			success: true,
			data: { status: "cancelled" },
		});
		await pendingPrompt;
		expect(admission.status).toBe("cancelled");
		expect(deliveredPrompt).not.toHaveBeenCalled();
		expect(admissionFor(supervisor, owner)).toBeUndefined();
		expect(forwarded.filter((command) => command.type === "prompt")).toHaveLength(1);
	});

	it("leaves an admission delivered when ownership wins before socket close", async () => {
		const worker = {
			descriptor: { lifecycle: "ready", rootActiveSessionId: "worker-session" },
		};
		const promptResponse = deferred<DaemonResponse>();
		const deliveredPrompt = vi.fn();
		let workerOwnsAdmission = false;
		const forwarded: DaemonCommand[] = [];
		const supervisor = createHarness({
			findWorker: vi.fn(async () => ({
				worker,
				summary: { id: "worker-session", activeSessionId: "worker-session" },
			})),
			forwardToWorker: vi.fn(async (_worker, command) => {
				forwarded.push(command);
				if (command.type === "cancel_prompt_admission") {
					return {
						type: "response",
						command: "cancel_prompt_admission",
						success: true,
						data: { status: workerOwnsAdmission ? "owned" : "cancelled" },
					} satisfies DaemonResponse;
				}
				return promptResponse.promise.then((response) => {
					if (response.success) deliveredPrompt();
					return response;
				});
			}),
		});
		const socket = new PassThrough() as unknown as Socket;
		Object.assign(socket, { destroyed: false });
		supervisor.handleConnection(socket);
		const owner = [...supervisor.clients][0]!;
		const pendingPrompt = supervisor.handleLine(
			owner,
			commandLine({
				id: "prompt-1",
				type: "prompt",
				activeSessionId: "public-session",
				admissionId: "public-admission",
				message: "delivered",
			} satisfies DaemonCommand),
		);
		await waitFor(() => forwarded.some((command) => command.type === "prompt"));
		const admission = admissionFor(supervisor, owner)!;

		workerOwnsAdmission = true;
		socket.emit("close");
		await waitFor(() => forwarded.some((command) => command.type === "cancel_prompt_admission"));
		await waitFor(() => admission.status === "owned");
		promptResponse.resolve({
			type: "response",
			command: "prompt",
			success: true,
		});
		await pendingPrompt;
		expect(admission.status).toBe("owned");
		expect(deliveredPrompt).toHaveBeenCalledOnce();
		expect(admissionFor(supervisor, owner)).toBeUndefined();
		expect(forwarded.filter((command) => command.type === "prompt")).toHaveLength(1);
	});
});

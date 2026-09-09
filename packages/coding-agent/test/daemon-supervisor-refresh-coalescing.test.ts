import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConnectionRlmChildAgentSnapshot } from "../src/modes/agent-connection/types.js";
import type { DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import { type DaemonOutbound, success } from "../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import type { DaemonWorkerFrameHeader } from "../src/modes/daemon/daemon-worker-protocol.js";
import type { PrivateFrame } from "../src/modes/session-worker/private-framing.js";

interface SupervisorInternals {
	clients: Set<DaemonSocketClient>;
	handleWorkerFrame(worker: WorkerFixture, frame: PrivateFrame<DaemonWorkerFrameHeader>): void;
	syncAgentPeers(): Promise<void>;
}

interface WorkerFixture {
	descriptor: {
		workerId: string;
		lifecycle: "ready";
		rootActiveSessionId: string;
		rootSessionId: string;
		pid: number;
		authenticationToken: string;
		createCommand: { config: { cwd: string } };
	};
	client?: { request: ReturnType<typeof vi.fn> };
	summaries: Map<string, never>;
	snapshotCache: Map<string, never>;
	transcriptCaches: Map<string, never>;
	snapshotGenerations: Map<string, never>;
	snapshotLoads: Map<string, never>;
	intentionalStop: boolean;
	summaryRefreshInFlight?: Promise<void>;
	summaryRefreshPending: boolean;
	rlmChildRefreshStates: Map<string, never>;
}

const tempDirs: string[] = [];

afterEach(() => {
	vi.useRealTimers();
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function childUpdateFrame(
	activeSessionId: string,
	child: AgentConnectionRlmChildAgentSnapshot,
): PrivateFrame<DaemonWorkerFrameHeader> {
	const outbound: DaemonOutbound = {
		type: "session_event",
		activeSessionId,
		event: { type: "rlm_child_update", child },
	};
	return {
		header: {
			kind: "outbound",
			outboundType: "session_event",
			activeSessionId,
			sessionEventType: "rlm_child_update",
			payloadEncoding: "jsonl",
		},
		payload: Buffer.from(JSON.stringify(outbound)),
	};
}

describe("daemon supervisor worker-summary refresh coalescing", () => {
	it.each(["list", "peer-sync"] as const)(
		"retries a failed terminal %s refresh at a bounded rate without another material event",
		async (failure) => {
			vi.useFakeTimers();
			const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-refresh-retry-"));
			tempDirs.push(directory);
			const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
				defaultSessionConfig: { agentDir: directory, cwd: directory },
				descriptorDir: join(directory, "workers"),
			}) as unknown as SupervisorInternals;
			const request = vi.fn(() => {
				if (failure === "list" && request.mock.calls.length <= 2) {
					return Promise.reject(new Error("list failed"));
				}
				return Promise.resolve(success(undefined, "list", { sessions: [] }));
			});
			const syncAgentPeers = vi.fn(() => {
				if (failure === "peer-sync" && syncAgentPeers.mock.calls.length <= 2) {
					return Promise.reject(new Error("peer sync failed"));
				}
				return Promise.resolve();
			});
			Object.assign(supervisor, { syncAgentPeers });
			const worker: WorkerFixture = {
				descriptor: {
					workerId: "worker",
					lifecycle: "ready",
					rootActiveSessionId: "root-active",
					rootSessionId: "root-session",
					pid: 1,
					authenticationToken: "token",
					createCommand: { config: { cwd: directory } },
				},
				client: { request },
				summaries: new Map<string, never>(),
				snapshotCache: new Map<string, never>(),
				transcriptCaches: new Map<string, never>(),
				snapshotGenerations: new Map<string, never>(),
				snapshotLoads: new Map<string, never>(),
				intentionalStop: false,
				summaryRefreshPending: false,
				rlmChildRefreshStates: new Map<string, never>(),
			};

			supervisor.handleWorkerFrame(
				worker,
				childUpdateFrame("root-active", {
					id: "child",
					activeSessionId: "child-active",
					label: "child task",
					status: "done",
					sessionDir: join(directory, "child"),
				}),
			);

			await vi.advanceTimersByTimeAsync(0);
			expect(request).toHaveBeenCalledOnce();
			await vi.advanceTimersByTimeAsync(1000);
			expect(request).toHaveBeenCalledTimes(2);
			await vi.advanceTimersByTimeAsync(1000);
			expect(request).toHaveBeenCalledTimes(3);
			expect(syncAgentPeers).toHaveBeenCalledTimes(failure === "list" ? 1 : 3);
		},
	);

	it.each(["disconnect", "stopping"] as const)("stops a delayed refresh retry after worker %s", async (end) => {
		vi.useFakeTimers();
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-refresh-stop-"));
		tempDirs.push(directory);
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		const request = vi.fn(() => Promise.reject(new Error("list unavailable")));
		Object.assign(supervisor, { syncAgentPeers: vi.fn(async () => {}) });
		const worker: WorkerFixture = {
			descriptor: {
				workerId: "worker",
				lifecycle: "ready",
				rootActiveSessionId: "root-active",
				rootSessionId: "root-session",
				pid: 1,
				authenticationToken: "token",
				createCommand: { config: { cwd: directory } },
			},
			client: { request },
			summaries: new Map<string, never>(),
			snapshotCache: new Map<string, never>(),
			transcriptCaches: new Map<string, never>(),
			snapshotGenerations: new Map<string, never>(),
			snapshotLoads: new Map<string, never>(),
			intentionalStop: false,
			summaryRefreshPending: false,
			rlmChildRefreshStates: new Map<string, never>(),
		};

		supervisor.handleWorkerFrame(
			worker,
			childUpdateFrame("root-active", {
				id: "child",
				activeSessionId: "child-active",
				label: "child task",
				status: "error",
				sessionDir: join(directory, "child"),
			}),
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(request).toHaveBeenCalledOnce();
		expect(worker.summaryRefreshPending).toBe(true);
		expect(worker.summaryRefreshInFlight).toBeDefined();

		if (end === "disconnect") {
			worker.client = undefined;
		} else {
			worker.intentionalStop = true;
		}
		await vi.advanceTimersByTimeAsync(1000);
		expect(request).toHaveBeenCalledOnce();
		expect(worker.summaryRefreshPending).toBe(false);
	});

	it("forwards every child update but refreshes once per material lifecycle state", async () => {
		vi.useFakeTimers();
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-refresh-coalescing-"));
		tempDirs.push(directory);
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;

		let rejectFirstList: (error: Error) => void = () => {};
		const firstList = new Promise<never>((_resolve, reject) => {
			rejectFirstList = reject;
		});
		const request = vi.fn((command: { type: string }) => {
			if (command.type !== "list") throw new Error(`Unexpected worker command: ${command.type}`);
			if (request.mock.calls.length === 1) return firstList;
			return Promise.resolve(success(undefined, "list", { sessions: [] }));
		});
		const worker: WorkerFixture = {
			descriptor: {
				workerId: "worker",
				lifecycle: "ready",
				rootActiveSessionId: "root-active",
				rootSessionId: "root-session",
				pid: 1,
				authenticationToken: "token",
				createCommand: { config: { cwd: directory } },
			},
			client: { request },
			summaries: new Map<string, never>(),
			snapshotCache: new Map<string, never>(),
			transcriptCaches: new Map<string, never>(),
			snapshotGenerations: new Map<string, never>(),
			snapshotLoads: new Map<string, never>(),
			intentionalStop: false,
			summaryRefreshPending: false,
			rlmChildRefreshStates: new Map<string, never>(),
		};
		const write = vi.fn(() => true);
		const uiClient = {
			socket: { destroyed: false, write },
			attachedActiveSessionIds: new Set(["root-active"]),
			capabilities: new Set(),
			supportsExtensionUi: false,
		} as unknown as DaemonSocketClient;
		supervisor.clients.add(uiClient);
		const syncAgentPeers = vi.fn(async () => {});
		Object.assign(supervisor, { syncAgentPeers });

		const frames: Array<PrivateFrame<DaemonWorkerFrameHeader>> = [];
		const send = (child: AgentConnectionRlmChildAgentSnapshot) => {
			const frame = childUpdateFrame("root-active", child);
			frames.push(frame);
			supervisor.handleWorkerFrame(worker, frame);
		};
		const queued: AgentConnectionRlmChildAgentSnapshot = {
			id: "child",
			parentId: "root-node",
			activeSessionId: "child-active",
			sessionName: "child-agent",
			label: "child task",
			status: "queued",
			sessionDir: join(directory, "child"),
		};

		send(queued);
		for (let index = 0; index < 20; index++) {
			send({ ...queued, answerPreview: `token ${index}`, tokenCount: index + 1 });
		}
		expect(request).toHaveBeenCalledOnce();

		const running = { ...queued, status: "running" as const, activity: { kind: "writing" as const } };
		send(running);
		for (let index = 0; index < 20; index++) {
			send({ ...running, answerPreview: `stream ${index}`, tokenCount: index + 100 });
		}
		expect(request).toHaveBeenCalledOnce();

		rejectFirstList(new Error("worker disconnected during list"));
		await vi.advanceTimersByTimeAsync(1000);
		expect(request).toHaveBeenCalledTimes(2);
		expect(syncAgentPeers).toHaveBeenCalledOnce();

		send({ ...running, status: "done", activity: undefined, answerPreview: "finished" });
		await vi.advanceTimersByTimeAsync(0);
		expect(request).toHaveBeenCalledTimes(3);
		for (let index = 0; index < 20; index++) {
			send({ ...running, status: "done", activity: undefined, answerPreview: `finished ${index}` });
		}
		await Promise.resolve();
		expect(request).toHaveBeenCalledTimes(3);

		const deleted = { ...running, status: "cancelled" as const, activity: undefined };
		send(deleted);
		await vi.advanceTimersByTimeAsync(0);
		expect(request).toHaveBeenCalledTimes(4);
		send({ ...deleted, error: "Deleted by parent orchestrator" });
		await Promise.resolve();
		expect(request).toHaveBeenCalledTimes(4);

		expect(write).toHaveBeenCalledTimes(frames.length);
		for (const [index, frame] of frames.entries()) {
			expect(write).toHaveBeenNthCalledWith(index + 1, frame.payload);
		}
	});
});

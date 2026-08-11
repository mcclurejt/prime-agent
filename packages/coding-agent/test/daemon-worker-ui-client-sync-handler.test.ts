import type { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import { isQuestionnaireClientPresentable } from "../src/modes/daemon/daemon-supervisor.js";
import type { DaemonWorkerCommand } from "../src/modes/daemon/daemon-worker-protocol.js";
import type { WorkerUiClientsMirror } from "../src/modes/daemon/daemon-worker-ui-clients.js";

function workerClient(): DaemonSocketClient {
	return {
		connectionId: "private-connection",
		logicalClientId: "supervisor",
		socket: { destroyed: false, write: vi.fn(() => true) } as unknown as Socket,
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

describe("daemon worker UI client synchronization", () => {
	it("accepts the full barrier before deltas and ignores stale private updates", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-worker-ui-sync.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-worker-ui-sync", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
			worker: { authenticationToken: "worker-token" },
		});
		const internals = daemon as unknown as {
			workerUiClients: WorkerUiClientsMirror;
			handleWorkerCommand(client: DaemonSocketClient, command: DaemonWorkerCommand): Promise<void>;
		};
		const client = workerClient();
		const mirrored = {
			logicalClientId: "logical-a",
			connectionId: "connection-a",
			activeSessionId: "session-a",
			capabilities: ["extension_ui", "questionnaire_v1"] as const,
			presentable: false,
		};

		await internals.handleWorkerCommand(client, {
			type: "worker_ui_client_delta",
			supervisorGeneration: "generation-a",
			syncRevision: 2,
			change: { type: "upsert", client: mirrored },
		});
		expect(internals.workerUiClients.ready).toBe(false);

		await internals.handleWorkerCommand(client, {
			type: "worker_ui_clients_sync",
			supervisorGeneration: "generation-a",
			syncRevision: 1,
			clients: [mirrored],
			complete: true,
		});
		expect(internals.workerUiClients.clients()).toEqual([mirrored]);

		await internals.handleWorkerCommand(client, {
			type: "worker_ui_client_delta",
			supervisorGeneration: "generation-old",
			syncRevision: 2,
			change: { type: "detach", connectionId: "connection-a", activeSessionId: "session-a" },
		});
		expect(internals.workerUiClients.clients()).toEqual([mirrored]);
	});
	it("does not infer questionnaire presentability from attachment or capabilities", () => {
		const client = workerClient();
		client.capabilities = new Set(["extension_ui", "questionnaire_v1"]);
		client.attachedActiveSessionIds.add("session-a");

		expect(isQuestionnaireClientPresentable(client, "session-a")).toBe(false);
	});
});

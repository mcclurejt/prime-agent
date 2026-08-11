import { describe, expect, it } from "vitest";
import type { WorkerUiClientDelta, WorkerUiClientsSync } from "../src/modes/daemon/daemon-worker-protocol.js";
import { SupervisorWorkerUiClientsSync, WorkerUiClientsMirror } from "../src/modes/daemon/daemon-worker-ui-clients.js";

const richClient = {
	logicalClientId: "logical-a",
	connectionId: "connection-a",
	activeSessionId: "session-a",
	capabilities: ["attach_snapshot", "extension_ui", "questionnaire_v1"] as const,
	presentable: false,
};

function fullSync(
	supervisorGeneration: string,
	syncRevision: number,
	clients: WorkerUiClientsSync["clients"] = [richClient],
): WorkerUiClientsSync {
	return { supervisorGeneration, syncRevision, clients, complete: true };
}

function delta(
	syncRevision: number,
	change: WorkerUiClientDelta["change"],
	supervisorGeneration = "generation-a",
): WorkerUiClientDelta {
	return { supervisorGeneration, syncRevision, change };
}

describe("WorkerUiClientsMirror", () => {
	it("refuses deltas until a complete synchronization barrier is accepted", () => {
		const mirror = new WorkerUiClientsMirror();

		expect(mirror.applyDelta(delta(2, { type: "upsert", client: richClient }))).toBe(false);
		expect(mirror.ready).toBe(false);
		expect(mirror.clients()).toEqual([]);

		expect(mirror.applySync(fullSync("generation-a", 1))).toBe(true);
		expect(mirror.ready).toBe(true);
		expect(mirror.clients()).toEqual([richClient]);
	});

	it("applies contiguous current-generation deltas and ignores duplicate, gapped, and wrong-generation data", () => {
		const mirror = new WorkerUiClientsMirror();
		mirror.applySync(fullSync("generation-a", 10));
		const updated = { ...richClient, presentable: true };

		expect(mirror.applyDelta(delta(11, { type: "upsert", client: updated }))).toBe(true);
		expect(
			mirror.applyDelta(delta(11, { type: "detach", connectionId: "connection-a", activeSessionId: "session-a" })),
		).toBe(false);
		expect(
			mirror.applyDelta(delta(13, { type: "detach", connectionId: "connection-a", activeSessionId: "session-a" })),
		).toBe(false);
		expect(
			mirror.applyDelta(
				delta(12, { type: "detach", connectionId: "connection-a", activeSessionId: "session-a" }, "generation-b"),
			),
		).toBe(false);
		expect(mirror.clients()).toEqual([updated]);

		expect(
			mirror.applyDelta(delta(12, { type: "detach", connectionId: "connection-a", activeSessionId: "session-a" })),
		).toBe(true);
		expect(mirror.clients()).toEqual([]);
	});

	it("atomically replaces prior connection incarnations on a new full synchronization", () => {
		const mirror = new WorkerUiClientsMirror();
		mirror.applySync(fullSync("generation-a", 4));
		const replacement = {
			...richClient,
			connectionId: "connection-b",
			capabilities: ["attach_snapshot"] as const,
		};

		expect(mirror.applySync(fullSync("generation-b", 1, [replacement]))).toBe(true);
		expect(mirror.supervisorGeneration).toBe("generation-b");
		expect(mirror.syncRevision).toBe(1);
		expect(mirror.clients()).toEqual([replacement]);
	});

	it("keeps synchronization payloads content-free", () => {
		const serialized = JSON.stringify(fullSync("generation-a", 1));

		expect(serialized).not.toMatch(/prompt|draft|answer|response/i);
		expect(serialized).not.toContain("secret questionnaire content");
	});
});

describe("SupervisorWorkerUiClientsSync", () => {
	it("emits a generation-numbered full barrier before monotonic deltas", () => {
		const sync = new SupervisorWorkerUiClientsSync("generation-a");

		expect(sync.full([richClient])).toEqual(fullSync("generation-a", 1));
		const updated = { ...richClient, presentable: true };
		expect(sync.reconcile([updated])).toEqual([delta(2, { type: "upsert", client: updated })]);
		expect(sync.reconcile([])).toEqual([
			delta(3, { type: "detach", connectionId: "connection-a", activeSessionId: "session-a" }),
		]);
		expect(sync.reconcile([])).toEqual([]);
	});

	it("keeps duplicate logical identities distinct by socket incarnation", () => {
		const sync = new SupervisorWorkerUiClientsSync("generation-a");
		const second = { ...richClient, connectionId: "connection-b" };
		sync.full([richClient]);

		expect(sync.reconcile([richClient, second])).toEqual([delta(2, { type: "upsert", client: second })]);
	});
});

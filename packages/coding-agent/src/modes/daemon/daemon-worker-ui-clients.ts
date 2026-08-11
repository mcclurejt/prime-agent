import type { WorkerUiClient, WorkerUiClientDelta, WorkerUiClientsSync } from "./daemon-worker-protocol.js";

function clientKey(connectionId: string, activeSessionId: string): string {
	return `${connectionId}\0${activeSessionId}`;
}

function cloneClient(client: WorkerUiClient): WorkerUiClient {
	return { ...client, capabilities: [...client.capabilities] };
}

export class WorkerUiClientsMirror {
	private generation?: string;
	private revision?: number;
	private mirroredClients = new Map<string, WorkerUiClient>();

	get ready(): boolean {
		return this.generation !== undefined;
	}

	get supervisorGeneration(): string | undefined {
		return this.generation;
	}

	get syncRevision(): number | undefined {
		return this.revision;
	}

	clients(): WorkerUiClient[] {
		return [...this.mirroredClients.values()].map(cloneClient);
	}

	applySync(sync: WorkerUiClientsSync): boolean {
		const next = new Map<string, WorkerUiClient>();
		for (const client of sync.clients) {
			next.set(clientKey(client.connectionId, client.activeSessionId), cloneClient(client));
		}
		this.generation = sync.supervisorGeneration;
		this.revision = sync.syncRevision;
		this.mirroredClients = next;
		return true;
	}

	applyDelta(delta: WorkerUiClientDelta): boolean {
		if (
			this.generation === undefined ||
			this.revision === undefined ||
			delta.supervisorGeneration !== this.generation ||
			delta.syncRevision !== this.revision + 1
		) {
			return false;
		}
		if (delta.change.type === "upsert") {
			const client = cloneClient(delta.change.client);
			this.mirroredClients.set(clientKey(client.connectionId, client.activeSessionId), client);
		} else {
			this.mirroredClients.delete(clientKey(delta.change.connectionId, delta.change.activeSessionId));
		}
		this.revision = delta.syncRevision;
		return true;
	}
}

function clientsEqual(left: WorkerUiClient, right: WorkerUiClient): boolean {
	return (
		left.logicalClientId === right.logicalClientId &&
		left.connectionId === right.connectionId &&
		left.activeSessionId === right.activeSessionId &&
		left.presentable === right.presentable &&
		left.capabilities.length === right.capabilities.length &&
		left.capabilities.every((capability, index) => capability === right.capabilities[index])
	);
}

export class SupervisorWorkerUiClientsSync {
	private revision = 0;
	private mirroredClients = new Map<string, WorkerUiClient>();

	constructor(private readonly generation: string) {}

	full(clients: readonly WorkerUiClient[]): WorkerUiClientsSync {
		const next = new Map<string, WorkerUiClient>();
		for (const client of clients) {
			next.set(clientKey(client.connectionId, client.activeSessionId), cloneClient(client));
		}
		this.mirroredClients = next;
		this.revision++;
		return {
			supervisorGeneration: this.generation,
			syncRevision: this.revision,
			clients: [...next.values()].map(cloneClient),
			complete: true,
		};
	}

	reconcile(clients: readonly WorkerUiClient[]): WorkerUiClientDelta[] {
		const next = new Map<string, WorkerUiClient>();
		for (const client of clients) {
			next.set(clientKey(client.connectionId, client.activeSessionId), cloneClient(client));
		}
		const deltas: WorkerUiClientDelta[] = [];
		for (const [key, previous] of this.mirroredClients) {
			if (next.has(key)) continue;
			this.revision++;
			deltas.push({
				supervisorGeneration: this.generation,
				syncRevision: this.revision,
				change: {
					type: "detach",
					connectionId: previous.connectionId,
					activeSessionId: previous.activeSessionId,
				},
			});
		}
		for (const [key, client] of next) {
			const previous = this.mirroredClients.get(key);
			if (previous && clientsEqual(previous, client)) continue;
			this.revision++;
			deltas.push({
				supervisorGeneration: this.generation,
				syncRevision: this.revision,
				change: { type: "upsert", client: cloneClient(client) },
			});
		}
		this.mirroredClients = next;
		return deltas;
	}
}

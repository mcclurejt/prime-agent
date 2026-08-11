import { closeSync, readFileSync } from "node:fs";
import type {
	AgentSessionMessageAgentSummary,
	AgentSessionMessageDeliveryMode,
	AgentSessionMessageSender,
} from "../../core/agent-messages.js";
import type { IdleEvictionMinutes } from "../../core/session-action-store.js";

export { SESSION_LEASE_OWNER_ID_ENV, SESSION_LEASES_ENABLED_ENV } from "../../core/session-lease.js";

import type { DaemonClientCapability, DaemonCommand, DaemonOutbound } from "./daemon-protocol.js";
import type {
	QuestionnaireLease,
	QuestionnaireOfferResult,
	QuestionnaireWorkerOfferNeed,
} from "./questionnaire-broker.js";
import type {
	QuestionnairePresentationSnapshot,
	QuestionnaireWorkerMutation,
} from "./questionnaire-worker-authority.js";

export const DAEMON_WORKER_ROLE_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER";
export const DAEMON_WORKER_TOKEN_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN";
export const DAEMON_WORKER_ACTIVE_SESSION_ID_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID";
export const DAEMON_WORKER_SUPERVISOR_SOCKET_ENV = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET";
export const DAEMON_WORKER_RECOVERY_JOURNAL_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL";
export const DAEMON_WORKER_STARTUP_GATE_FD_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_STARTUP_GATE_FD";
export const DAEMON_WORKER_STARTUP_GATE_COMMIT = "start\n";
export type DaemonWorkerLifecycle = "starting" | "ready" | "recovering" | "failed";

export type WorkerQuestionnaireBrokerMessage =
	| { type: "presenter_needed"; need: Omit<QuestionnaireWorkerOfferNeed, "workerId"> }
	| { type: "withdraw"; lease: QuestionnaireLease };

export interface WorkerQuestionnairePresentationMessage {
	activeSessionId: string;
	snapshot: QuestionnairePresentationSnapshot;
}

export type DaemonWorkerFrameHeader =
	| {
			kind: "command";
			requestId: string;
			commandType: string;
	  }
	| {
			kind: "questionnaire_broker";
			messageType: WorkerQuestionnaireBrokerMessage["type"];
	  }
	| {
			kind: "questionnaire_presentation";
			supervisorGeneration: string;
			activeSessionId: string;
			connectionId: string;
			logicalRequestId: string;
			offerId: string;
			leaseEpoch: number;
			authoritativeRevision: number;
	  }
	| {
			kind: "outbound";
			requestId?: string;
			outboundType: DaemonOutbound["type"];
			activeSessionId?: string;
			snapshotId?: string;
			sessionEventType?: string;
			payloadEncoding?: "jsonl" | "assistant-delta";
			snapshotPurpose?: "attach" | "replacement" | "catchup";
	  };

export type DaemonCreateCommand = Extract<DaemonCommand, { type: "create" }>;

export interface WorkerUiClient {
	logicalClientId: string;
	connectionId: string;
	activeSessionId: string;
	capabilities: readonly DaemonClientCapability[];
	presentable: boolean;
}

export interface WorkerUiClientsSync {
	supervisorGeneration: string;
	syncRevision: number;
	clients: readonly WorkerUiClient[];
	complete: true;
}

export interface WorkerUiClientDelta {
	supervisorGeneration: string;
	syncRevision: number;
	change:
		| { type: "upsert"; client: WorkerUiClient }
		| { type: "detach"; connectionId: string; activeSessionId: string };
}

export type DaemonWorkerCommand =
	| {
			id?: string;
			type: "worker_auth";
			token: string;
			supervisorGeneration: string;
			supervisorPid: number;
			supervisorProcessStartId?: string;
			supervisorSocketPath: string;
	  }
	| {
			id?: string;
			type: "worker_subscribe";
			activeSessionId: string;
			capabilities?: readonly DaemonClientCapability[];
			supportsExtensionUi?: boolean;
	  }
	| { id?: string; type: "worker_unsubscribe"; activeSessionId: string }
	| ({ id?: string; type: "worker_ui_clients_sync" } & WorkerUiClientsSync)
	| ({ id?: string; type: "worker_ui_client_delta" } & WorkerUiClientDelta)
	| { id?: string; type: "worker_questionnaire_offer_result"; result: QuestionnaireOfferResult }
	| {
			id?: string;
			type: "worker_questionnaire_lease_revoked";
			lease: QuestionnaireLease;
			reason: "client_lost" | "presentability_lost";
	  }
	| ({
			id?: string;
			type: "worker_questionnaire_checkpoint" | "worker_questionnaire_submit";
	  } & QuestionnaireWorkerMutation)
	| { id?: string; type: "worker_questionnaire_terminal_ack"; logicalRequestId: string }
	| { id?: string; type: "worker_sync_agent_peers"; peers: AgentSessionMessageAgentSummary[] }
	| { id?: string; type: "worker_archive_and_shutdown" }
	| {
			id?: string;
			type: "worker_passivate_idle_children";
			idleEvictionMinutes: IdleEvictionMinutes;
			now: number;
			limit: number;
	  }
	| {
			id?: string;
			type: "worker_deliver_message";
			targetActiveSessionId: string;
			message: string;
			sender: AgentSessionMessageSender;
			deliveryMode?: AgentSessionMessageDeliveryMode;
	  }
	| { id?: string; type: "worker_prepare_update" }
	| { id?: string; type: "worker_commit_update" }
	| { id?: string; type: "worker_cancel_update" };

export type DaemonWorkerCommandBody = DaemonWorkerCommand extends infer TCommand
	? TCommand extends { id?: string }
		? Omit<TCommand, "id">
		: never
	: never;

export interface DaemonWorkerDescriptor {
	version: 1;
	workerId: string;
	pid: number;
	processStartId?: string;
	socketPath: string;
	recoveryJournalPath: string;
	orphanProcessJournalPath?: string;
	supervisorSocketPath: string;
	authenticationToken: string;
	rootActiveSessionId: string;
	/** Stable protocol client that owns this worker. Omitted for resident sessions. */
	ownerClientId?: string;
	rootSessionId?: string;
	sessionFile?: string;
	createdAt: string;
	updatedAt: string;
	lifecycle: DaemonWorkerLifecycle;
	createCommand: DaemonCreateCommand;
	consecutiveFailures: number;
	/** Durable intent written before root termination so replacement supervisors never recover it. */
	stopRequestedAt?: string;
	/** Complete the root's archived lifecycle state after its process has stopped. */
	archiveOnStop?: boolean;
	lastFailureAt?: string;
	lastError?: string;
}

export function isDaemonWorkerProcess(environment: NodeJS.ProcessEnv = process.env): boolean {
	return environment[DAEMON_WORKER_ROLE_ENV] === "1";
}

export function waitForDaemonWorkerStartupGate(environment: NodeJS.ProcessEnv = process.env): void {
	const rawFd = environment[DAEMON_WORKER_STARTUP_GATE_FD_ENV];
	if (rawFd === undefined) {
		return;
	}
	delete environment[DAEMON_WORKER_STARTUP_GATE_FD_ENV];
	const fd = Number(rawFd);
	if (!Number.isInteger(fd) || fd < 3) {
		throw new Error("Daemon session worker has an invalid startup gate");
	}
	let marker: string;
	try {
		marker = readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
	if (marker !== DAEMON_WORKER_STARTUP_GATE_COMMIT) {
		throw new Error("Daemon session worker startup was cancelled");
	}
}

export function requireDaemonWorkerAuthenticationToken(environment: NodeJS.ProcessEnv = process.env): string {
	const token = environment[DAEMON_WORKER_TOKEN_ENV];
	if (!token) {
		throw new Error("Daemon session worker is missing its authentication token");
	}
	return token;
}

export function isDaemonWorkerFrameHeader(value: unknown): value is DaemonWorkerFrameHeader {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	if (candidate.kind === "command") {
		return typeof candidate.requestId === "string" && typeof candidate.commandType === "string";
	}
	if (candidate.kind === "questionnaire_broker") {
		return candidate.messageType === "presenter_needed" || candidate.messageType === "withdraw";
	}
	if (candidate.kind === "questionnaire_presentation") {
		return (
			typeof candidate.supervisorGeneration === "string" &&
			typeof candidate.activeSessionId === "string" &&
			typeof candidate.connectionId === "string" &&
			typeof candidate.logicalRequestId === "string" &&
			typeof candidate.offerId === "string" &&
			Number.isInteger(candidate.leaseEpoch) &&
			Number.isInteger(candidate.authoritativeRevision)
		);
	}
	return (
		candidate.kind === "outbound" &&
		typeof candidate.outboundType === "string" &&
		(candidate.requestId === undefined || typeof candidate.requestId === "string") &&
		(candidate.activeSessionId === undefined || typeof candidate.activeSessionId === "string") &&
		(candidate.snapshotId === undefined || typeof candidate.snapshotId === "string") &&
		(candidate.sessionEventType === undefined || typeof candidate.sessionEventType === "string") &&
		(candidate.snapshotPurpose === undefined ||
			candidate.snapshotPurpose === "attach" ||
			candidate.snapshotPurpose === "replacement" ||
			candidate.snapshotPurpose === "catchup") &&
		(candidate.payloadEncoding === undefined ||
			candidate.payloadEncoding === "jsonl" ||
			candidate.payloadEncoding === "assistant-delta")
	);
}

function hasExactKeys(candidate: Record<string, unknown>, expected: readonly string[]): boolean {
	const actual = Object.keys(candidate).sort();
	const sortedExpected = [...expected].sort();
	return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function isQuestionnaireLease(value: unknown): value is QuestionnaireLease {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	return (
		hasExactKeys(candidate, [
			"supervisorGeneration",
			"logicalRequestId",
			"offerId",
			"leaseEpoch",
			"logicalClientId",
			"connectionId",
			"mode",
		]) &&
		typeof candidate.supervisorGeneration === "string" &&
		typeof candidate.logicalRequestId === "string" &&
		typeof candidate.offerId === "string" &&
		Number.isInteger(candidate.leaseEpoch) &&
		(candidate.leaseEpoch as number) >= 0 &&
		typeof candidate.logicalClientId === "string" &&
		typeof candidate.connectionId === "string" &&
		(candidate.mode === "rich" || candidate.mode === "legacy")
	);
}

export function isWorkerQuestionnaireBrokerMessage(value: unknown): value is WorkerQuestionnaireBrokerMessage {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	if (candidate.type === "withdraw") {
		return hasExactKeys(candidate, ["type", "lease"]) && isQuestionnaireLease(candidate.lease);
	}
	if (
		candidate.type !== "presenter_needed" ||
		!hasExactKeys(candidate, ["type", "need"]) ||
		!candidate.need ||
		typeof candidate.need !== "object"
	) {
		return false;
	}
	const need = candidate.need as Record<string, unknown>;
	return (
		hasExactKeys(need, [
			"supervisorGeneration",
			"activeSessionId",
			"logicalRequestId",
			"offerId",
			"leaseEpoch",
			"createdAt",
			"mode",
		]) &&
		typeof need.supervisorGeneration === "string" &&
		typeof need.activeSessionId === "string" &&
		typeof need.logicalRequestId === "string" &&
		typeof need.offerId === "string" &&
		Number.isInteger(need.leaseEpoch) &&
		(need.leaseEpoch as number) >= 0 &&
		typeof need.createdAt === "number" &&
		Number.isFinite(need.createdAt) &&
		(need.mode === "undecided" || need.mode === "rich" || need.mode === "legacy")
	);
}

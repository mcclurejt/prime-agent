import { createHash } from "node:crypto";
import {
	assertQuestionnaireEnvelopeBudget,
	canonicalQuestionnaireJsonBytes,
	normalizeExtensionQuestionnaireDraftForValidatedRequest,
	normalizeExtensionQuestionnaireRequest,
} from "../../core/extensions/questionnaire.js";
import type {
	ExtensionQuestionnaireDraftQuestionState,
	ExtensionQuestionnaireDraftV1,
	ExtensionQuestionnaireOptions,
	ExtensionQuestionnaireOutcome,
	ExtensionQuestionnaireQuestion,
	ExtensionQuestionnaireRequestV1,
	ExtensionQuestionnaireResponse,
} from "../../core/extensions/types.js";
import type { WorkerQuestionnaireBrokerMessage } from "./daemon-worker-protocol.js";
import type { WorkerUiClientsMirror } from "./daemon-worker-ui-clients.js";
import type { QuestionnaireLease, QuestionnaireOfferResult, QuestionnaireRequestMode } from "./questionnaire-broker.js";

export interface QuestionnaireWorkerStatus {
	state: "waiting" | "offered" | "presenting" | undefined;
	queueDepth: number;
}

export interface QuestionnaireWorkerAuthorityHost {
	uiClients: WorkerUiClientsMirror;
	sendBrokerMessage(message: WorkerQuestionnaireBrokerMessage): boolean;
	onStatusChanged(activeSessionId: string, status: QuestionnaireWorkerStatus): void;
	createId(): string;
	now(): number;
}

export interface QuestionnaireWorkerRequestHandle {
	logicalRequestId: string;
	request: ExtensionQuestionnaireRequestV1;
	outcome: Promise<ExtensionQuestionnaireOutcome>;
}

export interface QuestionnaireWorkerMutation {
	lease: QuestionnaireLease;
	baseRevision: number;
	clientMutationId: string;
	completeDraft: ExtensionQuestionnaireDraftV1;
}

export interface QuestionnaireMutationAck {
	clientMutationId: string;
	authoritativeRevision: number;
	draftHash: string;
}

export interface QuestionnairePresentationSnapshot {
	lease: QuestionnaireLease;
	authoritativeRevision: number;
	request: ExtensionQuestionnaireRequestV1;
	draft: ExtensionQuestionnaireDraftV1;
}

export type QuestionnaireWorkerMutationResult =
	| { status: "ack"; ack: QuestionnaireMutationAck }
	| { status: "terminal"; outcome: ExtensionQuestionnaireOutcome }
	| {
			status: "conflict";
			authoritativeRevision: number;
			draftHash: string;
			snapshot?: QuestionnairePresentationSnapshot;
	  }
	| { status: "mutation-id-collision" }
	| { status: "stale-lease" };

type RequestState =
	| "waiting-for-broker-sync"
	| "waiting-for-presenter"
	| "offer-pending"
	| "presenting-rich"
	| "presenting-legacy";

interface MutationLedgerEntry {
	operationKind: "checkpoint" | "submit";
	baseRevision: number;
	canonicalPayloadHash: string;
	priorResult: QuestionnaireWorkerMutationResult;
}

interface PendingOffer {
	supervisorGeneration: string;
	logicalRequestId: string;
	offerId: string;
	leaseEpoch: number;
}

interface RequestRecord {
	activeSessionId: string;
	logicalRequestId: string;
	request: ExtensionQuestionnaireRequestV1;
	draft: ExtensionQuestionnaireDraftV1;
	authoritativeRevision: number;
	draftHash: string;
	mode: QuestionnaireRequestMode;
	state: RequestState;
	createdAt: number;
	leaseEpoch: number;
	pendingOffer?: PendingOffer;
	lease?: QuestionnaireLease;
	ledger: Map<string, MutationLedgerEntry>;
	resolveOutcome(outcome: ExtensionQuestionnaireOutcome): void;
	signal?: AbortSignal;
	abortHandler?: () => void;
}

interface TerminalTombstone {
	request: ExtensionQuestionnaireRequestV1;
	ledger: Map<string, MutationLedgerEntry>;
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function hashCanonical(value: unknown): string {
	return createHash("sha256").update(canonicalQuestionnaireJsonBytes(value)).digest("hex");
}

function initialState(question: ExtensionQuestionnaireQuestion): ExtensionQuestionnaireDraftQuestionState {
	switch (question.kind) {
		case "confirm":
			return {
				questionId: question.id,
				kind: question.kind,
				selection: null,
				otherEditorOpen: false,
				otherText: "",
			};
		case "single-select":
			return {
				questionId: question.id,
				kind: question.kind,
				selection: null,
				otherEditorOpen: false,
				otherText: "",
			};
		case "multi-select":
			return {
				questionId: question.id,
				kind: question.kind,
				choiceIds: [],
				otherSelected: false,
				otherEditorOpen: false,
				otherText: "",
			};
		case "short-text":
		case "multiline-text":
			return {
				questionId: question.id,
				kind: question.kind,
				value: question.initialValue ?? "",
			};
	}
}

export function createInitialQuestionnaireDraft(
	request: ExtensionQuestionnaireRequestV1,
): ExtensionQuestionnaireDraftV1 {
	return {
		version: 1,
		currentStep: { kind: "question", questionId: request.questions[0]!.id },
		states: request.questions.map(initialState),
	};
}

function responseFor(
	question: ExtensionQuestionnaireQuestion,
	state: ExtensionQuestionnaireDraftQuestionState,
): ExtensionQuestionnaireResponse {
	if (question.id !== state.questionId || question.kind !== state.kind) {
		throw new TypeError("Questionnaire draft state does not match request");
	}
	switch (state.kind) {
		case "confirm":
			if (state.selection === "yes" || state.selection === "no") {
				return {
					questionId: question.id,
					status: "answered",
					kind: "confirm",
					value: state.selection === "yes",
				};
			}
			return state.selection === "other" && state.otherText.trim()
				? { questionId: question.id, status: "answered", kind: "confirm", otherText: state.otherText }
				: { questionId: question.id, status: "unanswered" };
		case "single-select":
			if (state.selection?.kind === "choice") {
				return {
					questionId: question.id,
					status: "answered",
					kind: "single-select",
					choiceId: state.selection.choiceId,
				};
			}
			return state.selection?.kind === "other" && state.otherText.trim()
				? { questionId: question.id, status: "answered", kind: "single-select", otherText: state.otherText }
				: { questionId: question.id, status: "unanswered" };
		case "multi-select": {
			const otherText = state.otherSelected && state.otherText.trim() ? state.otherText : undefined;
			return state.choiceIds.length === 0 && otherText === undefined
				? { questionId: question.id, status: "unanswered" }
				: {
						questionId: question.id,
						status: "answered",
						kind: "multi-select",
						choiceIds: [...state.choiceIds],
						...(otherText === undefined ? {} : { otherText }),
					};
		}
		case "short-text":
		case "multiline-text":
			return state.value.trim()
				? { questionId: question.id, status: "answered", kind: state.kind, value: state.value }
				: { questionId: question.id, status: "unanswered" };
	}
}

export function deriveQuestionnaireResponses(
	request: ExtensionQuestionnaireRequestV1,
	draft: ExtensionQuestionnaireDraftV1,
): ExtensionQuestionnaireResponse[] {
	return request.questions.map((question, index) => responseFor(question, draft.states[index]!));
}

function sameLease(left: QuestionnaireLease, right: QuestionnaireLease): boolean {
	return (
		left.supervisorGeneration === right.supervisorGeneration &&
		left.logicalRequestId === right.logicalRequestId &&
		left.offerId === right.offerId &&
		left.leaseEpoch === right.leaseEpoch &&
		left.logicalClientId === right.logicalClientId &&
		left.connectionId === right.connectionId &&
		left.mode === right.mode
	);
}

function offerMatches(
	offer: PendingOffer,
	stamp: Pick<QuestionnaireLease, "supervisorGeneration" | "logicalRequestId" | "offerId" | "leaseEpoch">,
): boolean {
	return (
		offer.supervisorGeneration === stamp.supervisorGeneration &&
		offer.logicalRequestId === stamp.logicalRequestId &&
		offer.offerId === stamp.offerId &&
		offer.leaseEpoch === stamp.leaseEpoch
	);
}

export class QuestionnaireWorkerAuthority {
	private readonly queues = new Map<string, RequestRecord[]>();
	private readonly requests = new Map<string, RequestRecord>();
	private readonly tombstones = new Map<string, TerminalTombstone>();
	private readonly publishedStatuses = new Map<string, QuestionnaireWorkerStatus>();

	constructor(private readonly host: QuestionnaireWorkerAuthorityHost) {}

	request(
		activeSessionId: string,
		requestValue: ExtensionQuestionnaireRequestV1,
		options?: ExtensionQuestionnaireOptions,
	): QuestionnaireWorkerRequestHandle {
		const request = normalizeExtensionQuestionnaireRequest(requestValue);
		const draft = createInitialQuestionnaireDraft(request);
		assertQuestionnaireEnvelopeBudget(draft);
		const logicalRequestId = this.host.createId();
		let resolveOutcome: (outcome: ExtensionQuestionnaireOutcome) => void = () => {};
		const outcome = new Promise<ExtensionQuestionnaireOutcome>((resolve) => {
			resolveOutcome = resolve;
		});
		const record: RequestRecord = {
			activeSessionId,
			logicalRequestId,
			request,
			draft,
			authoritativeRevision: 0,
			draftHash: hashCanonical(draft),
			mode: "undecided",
			state: "waiting-for-broker-sync",
			createdAt: this.host.now(),
			leaseEpoch: 0,
			ledger: new Map(),
			resolveOutcome,
			...(options?.signal ? { signal: options.signal } : {}),
		};
		this.requests.set(logicalRequestId, record);
		const queue = this.queues.get(activeSessionId) ?? [];
		queue.push(record);
		this.queues.set(activeSessionId, queue);
		if (options?.signal) {
			const abortHandler = () => this.abort(record);
			record.abortHandler = abortHandler;
			if (options.signal.aborted) abortHandler();
			else options.signal.addEventListener("abort", abortHandler, { once: true });
		}
		this.pump(activeSessionId);
		return { logicalRequestId, request: clone(request), outcome };
	}

	status(activeSessionId: string): QuestionnaireWorkerStatus {
		const queue = this.queues.get(activeSessionId) ?? [];
		const state = queue[0]?.state;
		return {
			state:
				state === undefined
					? undefined
					: state === "offer-pending"
						? "offered"
						: state === "presenting-rich" || state === "presenting-legacy"
							? "presenting"
							: "waiting",
			queueDepth: queue.length,
		};
	}

	handleUiClientsChanged(): void {
		const generation = this.host.uiClients.supervisorGeneration;
		for (const queue of this.queues.values()) {
			const head = queue[0];
			if (!head) continue;
			if (head.lease && head.lease.supervisorGeneration !== generation) head.lease = undefined;
			if (head.pendingOffer && head.pendingOffer.supervisorGeneration !== generation) {
				head.pendingOffer = undefined;
			}
			this.pump(head.activeSessionId);
		}
	}

	handleOfferResult(result: QuestionnaireOfferResult): void {
		const offer = result.status === "accepted" ? result.lease : result.offer;
		const record = this.requests.get(offer.logicalRequestId);
		if (!record?.pendingOffer || !offerMatches(record.pendingOffer, offer)) return;
		record.pendingOffer = undefined;
		if (result.status === "accepted") {
			if (record.mode !== "undecided" && record.mode !== result.lease.mode) {
				record.state = "waiting-for-presenter";
				this.host.sendBrokerMessage({ type: "withdraw", lease: result.lease });
				this.pump(record.activeSessionId);
				return;
			}
			record.mode = result.lease.mode;
			record.lease = clone(result.lease);
			record.state = result.lease.mode === "rich" ? "presenting-rich" : "presenting-legacy";
			this.publishStatus(record.activeSessionId);
			return;
		}
		record.state = "waiting-for-presenter";
		this.pump(record.activeSessionId);
	}

	handleLeaseRevoked(lease: QuestionnaireLease): void {
		const record = this.requests.get(lease.logicalRequestId);
		if (!record?.lease || !sameLease(record.lease, lease)) return;
		record.lease = undefined;
		record.state = "waiting-for-presenter";
		this.pump(record.activeSessionId);
	}

	checkpoint(mutation: QuestionnaireWorkerMutation): QuestionnaireWorkerMutationResult {
		return this.applyMutation("checkpoint", mutation);
	}

	submit(mutation: QuestionnaireWorkerMutation): QuestionnaireWorkerMutationResult {
		return this.applyMutation("submit", mutation);
	}

	presentationSnapshot(logicalRequestId: string): QuestionnairePresentationSnapshot | undefined {
		const record = this.requests.get(logicalRequestId);
		if (!record?.lease || record.lease.mode !== "rich") return undefined;
		return this.snapshot(record);
	}

	presentationForLease(
		lease: QuestionnaireLease,
	): { activeSessionId: string; snapshot: QuestionnairePresentationSnapshot } | undefined {
		const record = this.requests.get(lease.logicalRequestId);
		if (!record?.lease || record.lease.mode !== "rich" || !sameLease(record.lease, lease)) return undefined;
		return { activeSessionId: record.activeSessionId, snapshot: this.snapshot(record) };
	}

	acknowledgeTerminalDelivery(logicalRequestId: string): void {
		this.tombstones.delete(logicalRequestId);
	}

	private applyMutation(
		operationKind: "checkpoint" | "submit",
		mutation: QuestionnaireWorkerMutation,
	): QuestionnaireWorkerMutationResult {
		const record = this.requests.get(mutation.lease.logicalRequestId);
		const tombstone = this.tombstones.get(mutation.lease.logicalRequestId);
		const request = record?.request ?? tombstone?.request;
		if (!request) return { status: "stale-lease" };
		const draft = normalizeExtensionQuestionnaireDraftForValidatedRequest(request, mutation.completeDraft);
		assertQuestionnaireEnvelopeBudget(draft);
		const payloadHash = hashCanonical(draft);
		const ledger = record?.ledger ?? tombstone!.ledger;
		const previous = ledger.get(mutation.clientMutationId);
		if (previous) {
			return previous.operationKind === operationKind &&
				previous.baseRevision === mutation.baseRevision &&
				previous.canonicalPayloadHash === payloadHash
				? clone(previous.priorResult)
				: { status: "mutation-id-collision" };
		}
		if (!record?.lease || !sameLease(record.lease, mutation.lease)) return { status: "stale-lease" };
		if (mutation.baseRevision !== record.authoritativeRevision) {
			return {
				status: "conflict",
				authoritativeRevision: record.authoritativeRevision,
				draftHash: record.draftHash,
				snapshot: this.snapshot(record),
			};
		}
		if (operationKind === "checkpoint") {
			record.draft = draft;
			record.authoritativeRevision++;
			record.draftHash = payloadHash;
			const result: QuestionnaireWorkerMutationResult = {
				status: "ack",
				ack: {
					clientMutationId: mutation.clientMutationId,
					authoritativeRevision: record.authoritativeRevision,
					draftHash: record.draftHash,
				},
			};
			record.ledger.set(mutation.clientMutationId, {
				operationKind,
				baseRevision: mutation.baseRevision,
				canonicalPayloadHash: payloadHash,
				priorResult: clone(result),
			});
			return result;
		}
		const outcome: ExtensionQuestionnaireOutcome = {
			status: "submitted",
			responses: deriveQuestionnaireResponses(request, draft),
		};
		const result: QuestionnaireWorkerMutationResult = { status: "terminal", outcome };
		record.ledger.set(mutation.clientMutationId, {
			operationKind,
			baseRevision: mutation.baseRevision,
			canonicalPayloadHash: payloadHash,
			priorResult: clone(result),
		});
		this.finish(record, outcome, true);
		return result;
	}

	private snapshot(record: RequestRecord): QuestionnairePresentationSnapshot {
		return {
			lease: clone(record.lease!),
			authoritativeRevision: record.authoritativeRevision,
			request: clone(record.request),
			draft: clone(record.draft),
		};
	}

	private pump(activeSessionId: string): void {
		const head = this.queues.get(activeSessionId)?.[0];
		if (!head || head.lease || head.pendingOffer) {
			this.publishStatus(activeSessionId);
			return;
		}
		const generation = this.host.uiClients.supervisorGeneration;
		if (!this.host.uiClients.ready || !generation) {
			head.state = "waiting-for-broker-sync";
			this.publishStatus(activeSessionId);
			return;
		}
		const eligible = this.host.uiClients.clients().some((client) => {
			if (client.activeSessionId !== activeSessionId || !client.presentable) return false;
			if (!client.capabilities.includes("extension_ui")) return false;
			return head.mode !== "rich" || client.capabilities.includes("questionnaire_v1");
		});
		if (!eligible) {
			head.state = "waiting-for-presenter";
			this.publishStatus(activeSessionId);
			return;
		}
		head.leaseEpoch++;
		const pendingOffer: PendingOffer = {
			supervisorGeneration: generation,
			logicalRequestId: head.logicalRequestId,
			offerId: this.host.createId(),
			leaseEpoch: head.leaseEpoch,
		};
		head.pendingOffer = pendingOffer;
		head.state = "offer-pending";
		const sent = this.host.sendBrokerMessage({
			type: "presenter_needed",
			need: {
				...pendingOffer,
				activeSessionId,
				createdAt: head.createdAt,
				mode: head.mode,
			},
		});
		if (!sent) {
			head.pendingOffer = undefined;
			head.state = "waiting-for-broker-sync";
		}
		this.publishStatus(activeSessionId);
	}

	private publishStatus(activeSessionId: string): void {
		const status = this.status(activeSessionId);
		const previous = this.publishedStatuses.get(activeSessionId);
		if (previous && previous.state === status.state && previous.queueDepth === status.queueDepth) return;
		if (status.state === undefined && status.queueDepth === 0) this.publishedStatuses.delete(activeSessionId);
		else this.publishedStatuses.set(activeSessionId, status);
		this.host.onStatusChanged(activeSessionId, status);
	}

	private abort(record: RequestRecord): void {
		if (!this.requests.has(record.logicalRequestId)) return;
		this.finish(record, { status: "aborted", reason: "signal" }, false);
	}

	private finish(record: RequestRecord, outcome: ExtensionQuestionnaireOutcome, retainTombstone: boolean): void {
		if (!this.requests.delete(record.logicalRequestId)) return;
		record.signal?.removeEventListener("abort", record.abortHandler!);
		if (retainTombstone) {
			this.tombstones.set(record.logicalRequestId, { request: record.request, ledger: record.ledger });
		}
		if (record.lease) this.host.sendBrokerMessage({ type: "withdraw", lease: record.lease });
		record.resolveOutcome(clone(outcome));
		const queue = this.queues.get(record.activeSessionId);
		if (queue) {
			const index = queue.indexOf(record);
			if (index >= 0) queue.splice(index, 1);
			if (queue.length === 0) this.queues.delete(record.activeSessionId);
		}
		record.request = { version: 1, questions: [] };
		record.draft = { version: 1, currentStep: { kind: "review" }, states: [] };
		this.pump(record.activeSessionId);
	}
}

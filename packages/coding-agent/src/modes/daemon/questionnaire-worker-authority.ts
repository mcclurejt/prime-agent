import { createHash } from "node:crypto";
import {
	assertQuestionnaireEnvelopeBudget,
	canonicalQuestionnaireJsonBytes,
	normalizeExtensionQuestionnaireDraftForValidatedRequest,
	normalizeExtensionQuestionnaireDraftV2,
	normalizeExtensionQuestionnaireRequest,
	normalizeExtensionQuestionnaireRequestV2,
	projectExtensionQuestionnaireRequestV2ToV1,
} from "../../core/extensions/questionnaire.js";
import type {
	ExtensionQuestionnaireDraftQuestionState,
	ExtensionQuestionnaireDraftV1,
	ExtensionQuestionnaireDraftV2,
	ExtensionQuestionnaireOptions,
	ExtensionQuestionnaireOutcome,
	ExtensionQuestionnaireOutcomeV2,
	ExtensionQuestionnaireQuestion,
	ExtensionQuestionnaireQuestionV2,
	ExtensionQuestionnaireRequestV1,
	ExtensionQuestionnaireRequestV2,
	ExtensionQuestionnaireResponse,
	ExtensionQuestionnaireResponseV2,
} from "../../core/extensions/types.js";
import type { DaemonExtensionUIResponse } from "./daemon-protocol.js";
import type { WorkerQuestionnaireBrokerMessage } from "./daemon-worker-protocol.js";
import type { WorkerUiClientsMirror } from "./daemon-worker-ui-clients.js";
import type { QuestionnaireLease, QuestionnaireOfferResult, QuestionnaireRequestMode } from "./questionnaire-broker.js";
import { QuestionnaireLegacyAdapter, type QuestionnaireLegacyAdapterAction } from "./questionnaire-legacy-adapter.js";

type QuestionnaireRequest = ExtensionQuestionnaireRequestV1 | ExtensionQuestionnaireRequestV2;
type QuestionnaireDraft = ExtensionQuestionnaireDraftV1 | ExtensionQuestionnaireDraftV2;
type QuestionnaireOutcome = ExtensionQuestionnaireOutcome | ExtensionQuestionnaireOutcomeV2;

export interface QuestionnairePresentationLimitation {
	mode: "v1-projection";
	unavailableFeatures: readonly ["notes", "previews"];
}

export type QuestionnaireWorkerOutcome = QuestionnaireOutcome extends infer TOutcome
	? TOutcome extends QuestionnaireOutcome
		? TOutcome & { presentation?: QuestionnairePresentationLimitation }
		: never
	: never;

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
	request: QuestionnaireRequest;
	outcome: Promise<QuestionnaireWorkerOutcome>;
}

export type QuestionnaireTerminationReason = Extract<ExtensionQuestionnaireOutcome, { status: "terminated" }>["reason"];

export interface QuestionnaireWorkerMutation {
	lease: QuestionnaireLease;
	baseRevision: number;
	clientMutationId: string;
	completeDraft: QuestionnaireDraft;
}

export interface QuestionnaireMutationAck {
	clientMutationId: string;
	authoritativeRevision: number;
	draftHash: string;
}

export interface QuestionnairePresentationSnapshot {
	lease: QuestionnaireLease;
	authoritativeRevision: number;
	request: QuestionnaireRequest;
	draft: QuestionnaireDraft;
}

export type QuestionnaireWorkerMutationResult =
	| { status: "ack"; ack: QuestionnaireMutationAck }
	| { status: "terminal"; outcome: QuestionnaireWorkerOutcome }
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
	request: QuestionnaireRequest;
	draft: QuestionnaireDraft;
	authoritativeRevision: number;
	draftHash: string;
	mode: QuestionnaireRequestMode;
	state: RequestState;
	createdAt: number;
	leaseEpoch: number;
	pendingOffer?: PendingOffer;
	lease?: QuestionnaireLease;
	ledger: Map<string, MutationLedgerEntry>;
	presentationLimitation?: QuestionnairePresentationLimitation;
	resolveOutcome(outcome: QuestionnaireWorkerOutcome): void;
	signal?: AbortSignal;
	abortHandler?: () => void;
	legacyAdapter?: QuestionnaireLegacyAdapter;
	legacyRequestId?: string;
}

interface TerminalTombstone {
	request: QuestionnaireRequest;
	ledger: Map<string, MutationLedgerEntry>;
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function hashCanonical(value: unknown): string {
	return createHash("sha256").update(canonicalQuestionnaireJsonBytes(value)).digest("hex");
}

function initialState(
	question: ExtensionQuestionnaireQuestion | ExtensionQuestionnaireQuestionV2,
): ExtensionQuestionnaireDraftQuestionState {
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
): ExtensionQuestionnaireDraftV1;
export function createInitialQuestionnaireDraft(
	request: ExtensionQuestionnaireRequestV2,
): ExtensionQuestionnaireDraftV2;
export function createInitialQuestionnaireDraft(request: QuestionnaireRequest): QuestionnaireDraft;
export function createInitialQuestionnaireDraft(request: QuestionnaireRequest): QuestionnaireDraft {
	return {
		version: request.version,
		currentStep: { kind: "question", questionId: request.questions[0]!.id },
		states: request.questions.map((question) => initialState(question)),
	} as QuestionnaireDraft;
}

function responseFor(
	question: ExtensionQuestionnaireQuestion | ExtensionQuestionnaireQuestionV2,
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
): ExtensionQuestionnaireResponse[];
export function deriveQuestionnaireResponses(
	request: ExtensionQuestionnaireRequestV2,
	draft: ExtensionQuestionnaireDraftV2,
): ExtensionQuestionnaireResponseV2[];
export function deriveQuestionnaireResponses(
	request: QuestionnaireRequest,
	draft: QuestionnaireDraft,
): ExtensionQuestionnaireResponse[] | ExtensionQuestionnaireResponseV2[] {
	return request.questions.map((question, index) => {
		const state = draft.states[index]!;
		const response = responseFor(question, state);
		return request.version === 2 && "note" in state && state.note !== undefined
			? { ...response, note: state.note }
			: response;
	});
}

function sameLease(left: QuestionnaireLease, right: QuestionnaireLease): boolean {
	return (
		left.supervisorGeneration === right.supervisorGeneration &&
		left.logicalRequestId === right.logicalRequestId &&
		left.offerId === right.offerId &&
		left.leaseEpoch === right.leaseEpoch &&
		left.logicalClientId === right.logicalClientId &&
		left.connectionId === right.connectionId &&
		left.mode === right.mode &&
		left.questionnaireVersion === right.questionnaireVersion
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
		requestValue: QuestionnaireRequest,
		options?: ExtensionQuestionnaireOptions,
	): QuestionnaireWorkerRequestHandle {
		const request =
			requestValue.version === 2
				? normalizeExtensionQuestionnaireRequestV2(requestValue)
				: normalizeExtensionQuestionnaireRequest(requestValue);
		const draft = createInitialQuestionnaireDraft(request);
		assertQuestionnaireEnvelopeBudget(draft);
		const logicalRequestId = this.host.createId();
		let resolveOutcome: (outcome: QuestionnaireWorkerOutcome) => void = () => {};
		const outcome = new Promise<QuestionnaireWorkerOutcome>((resolve) => {
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

	terminateSession(activeSessionId: string, reason: QuestionnaireTerminationReason): number {
		const records = [...(this.queues.get(activeSessionId) ?? [])];
		for (const record of records.reverse()) {
			this.finish(record, { status: "terminated", reason }, false);
		}
		return records.length;
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
			if (head.lease && head.lease.supervisorGeneration !== generation) {
				if (head.lease.mode === "legacy") {
					head.legacyRequestId = undefined;
					head.legacyAdapter?.resetPresentation();
				}
				head.lease = undefined;
			}
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
			const expectedVersion = record.request.version;
			if (
				(result.lease.questionnaireVersion ?? 1) !== expectedVersion ||
				(expectedVersion === 2 && result.lease.mode !== "rich") ||
				(record.mode !== "undecided" && record.mode !== result.lease.mode)
			) {
				record.state = "waiting-for-presenter";
				this.host.sendBrokerMessage({ type: "withdraw", lease: result.lease });
				this.pump(record.activeSessionId);
				return;
			}
			record.mode = result.lease.mode;
			record.lease = clone(result.lease);
			record.state = result.lease.mode === "rich" ? "presenting-rich" : "presenting-legacy";
			this.publishStatus(record.activeSessionId);
			if (result.lease.mode === "legacy") {
				if (record.request.version !== 1 || record.draft.version !== 1) {
					throw new Error("Questionnaire v2 cannot use a legacy presenter");
				}
				record.legacyAdapter ??= new QuestionnaireLegacyAdapter(record.request, record.draft);
				this.advanceLegacy(record, record.legacyAdapter.start());
			}
			return;
		}
		record.state = "waiting-for-presenter";
		this.pump(record.activeSessionId);
	}

	handleLeaseRevoked(lease: QuestionnaireLease): void {
		const record = this.requests.get(lease.logicalRequestId);
		if (!record?.lease || !sameLease(record.lease, lease)) return;
		if (record.lease.mode === "legacy") {
			record.legacyRequestId = undefined;
			record.legacyAdapter?.resetPresentation();
		}
		record.lease = undefined;
		record.state = "waiting-for-presenter";
		this.pump(record.activeSessionId);
	}

	dismiss(lease: QuestionnaireLease): QuestionnaireWorkerMutationResult {
		const record = this.requests.get(lease.logicalRequestId);
		if (!record?.lease || record.lease.mode !== "rich" || !sameLease(record.lease, lease)) {
			return { status: "stale-lease" };
		}
		const outcome = this.effectiveOutcome(record, { status: "dismissed" });
		this.finish(record, outcome, false);
		return { status: "terminal", outcome };
	}

	handleLegacyResponse(input: {
		lease: QuestionnaireLease;
		requestId: string;
		connectionId: string;
		response: DaemonExtensionUIResponse;
	}): "accepted" | "stale" {
		const record = this.requests.get(input.lease.logicalRequestId);
		if (
			!record?.lease ||
			record.lease.mode !== "legacy" ||
			!sameLease(record.lease, input.lease) ||
			input.connectionId !== record.lease.connectionId ||
			record.legacyRequestId !== input.requestId ||
			!record.legacyAdapter
		) {
			return "stale";
		}
		record.legacyRequestId = undefined;
		this.advanceLegacy(record, record.legacyAdapter.respond(input.response));
		return "accepted";
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

	private advanceLegacy(record: RequestRecord, action: QuestionnaireLegacyAdapterAction): void {
		const adapter = record.legacyAdapter;
		if (
			!adapter ||
			!record.lease ||
			record.lease.mode !== "legacy" ||
			record.request.version !== 1 ||
			record.draft.version !== 1
		)
			return;
		const request = record.request;
		const draft = normalizeExtensionQuestionnaireDraftForValidatedRequest(request, adapter.draft);
		assertQuestionnaireEnvelopeBudget(draft);
		const draftHash = hashCanonical(draft);
		if (draftHash !== record.draftHash) {
			record.draft = draft;
			record.draftHash = draftHash;
			record.authoritativeRevision++;
		}
		if (action.status === "submitted") {
			this.finish(record, { status: "submitted", responses: deriveQuestionnaireResponses(request, draft) }, false);
			return;
		}
		if (action.status === "indeterminate") {
			this.finish(record, action, false);
			return;
		}
		const requestId = this.host.createId();
		record.legacyRequestId = requestId;
		const sent = this.host.sendBrokerMessage({
			type: "legacy_request",
			activeSessionId: record.activeSessionId,
			lease: record.lease,
			requestId,
			request: action.request,
		});
		if (!sent) record.legacyRequestId = undefined;
	}

	private applyMutation(
		operationKind: "checkpoint" | "submit",
		mutation: QuestionnaireWorkerMutation,
	): QuestionnaireWorkerMutationResult {
		const record = this.requests.get(mutation.lease.logicalRequestId);
		const tombstone = this.tombstones.get(mutation.lease.logicalRequestId);
		const request = record?.request ?? tombstone?.request;
		if (!request) return { status: "stale-lease" };
		if (request.version !== mutation.completeDraft.version) return { status: "stale-lease" };
		const draft =
			request.version === 2 && mutation.completeDraft.version === 2
				? normalizeExtensionQuestionnaireDraftV2(request, mutation.completeDraft)
				: normalizeExtensionQuestionnaireDraftForValidatedRequest(
						request as ExtensionQuestionnaireRequestV1,
						mutation.completeDraft as ExtensionQuestionnaireDraftV1,
					);
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
		const responses =
			request.version === 2 && draft.version === 2
				? deriveQuestionnaireResponses(request, draft)
				: deriveQuestionnaireResponses(
						request as ExtensionQuestionnaireRequestV1,
						draft as ExtensionQuestionnaireDraftV1,
					);
		const outcome = this.effectiveOutcome(record, { status: "submitted", responses });
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
		const clients = this.host.uiClients.clients();
		const attached = clients.filter(
			(client) => client.activeSessionId === activeSessionId && client.capabilities.includes("extension_ui"),
		);
		const available = attached.filter((client) => client.presentable);
		const hasV2Attached = attached.some((client) => client.capabilities.includes("questionnaire_v2"));
		if (head.request.version === 2 && head.authoritativeRevision === 0 && !hasV2Attached && available.length > 0) {
			const projected = projectExtensionQuestionnaireRequestV2ToV1(head.request);
			head.request = projected;
			head.draft = createInitialQuestionnaireDraft(projected);
			head.draftHash = hashCanonical(head.draft);
			head.presentationLimitation = {
				mode: "v1-projection",
				unavailableFeatures: ["notes", "previews"],
			};
		}
		const eligible = available.some((client) => {
			if (head.request.version === 2) return client.capabilities.includes("questionnaire_v2");
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
				...(head.request.version === 2 ? { questionnaireVersion: 2 as const } : {}),
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

	private effectiveOutcome(record: RequestRecord, outcome: QuestionnaireOutcome): QuestionnaireWorkerOutcome {
		return record.presentationLimitation ? { ...outcome, presentation: record.presentationLimitation } : outcome;
	}

	private finish(record: RequestRecord, outcome: QuestionnaireOutcome, retainTombstone: boolean): void {
		if (!this.requests.delete(record.logicalRequestId)) return;
		record.signal?.removeEventListener("abort", record.abortHandler!);
		if (retainTombstone) {
			this.tombstones.set(record.logicalRequestId, { request: record.request, ledger: record.ledger });
		}
		if (record.lease) this.host.sendBrokerMessage({ type: "withdraw", lease: record.lease });
		record.resolveOutcome(clone(this.effectiveOutcome(record, outcome)));
		const queue = this.queues.get(record.activeSessionId);
		if (queue) {
			const index = queue.indexOf(record);
			if (index >= 0) queue.splice(index, 1);
			if (queue.length === 0) this.queues.delete(record.activeSessionId);
		}
		record.request = { version: 1, questions: [] };
		record.draft = { version: 1, currentStep: { kind: "review" }, states: [] };
		record.pendingOffer = undefined;
		record.lease = undefined;
		record.legacyRequestId = undefined;
		record.legacyAdapter?.dispose();
		record.legacyAdapter = undefined;
		if (!retainTombstone) record.ledger.clear();
		record.resolveOutcome = () => {};
		this.pump(record.activeSessionId);
	}
}

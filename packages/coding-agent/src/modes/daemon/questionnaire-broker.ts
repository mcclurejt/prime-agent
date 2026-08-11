import type {
	DaemonClientCapability,
	DaemonQuestionnaireLease,
	DaemonQuestionnairePresentationMode,
} from "./daemon-protocol.js";

export type QuestionnaireLease = DaemonQuestionnaireLease;
export type QuestionnairePresentationMode = DaemonQuestionnairePresentationMode;
export type QuestionnaireRequestMode = "undecided" | QuestionnairePresentationMode;

export interface QuestionnaireLeaseStamp {
	supervisorGeneration: string;
	logicalRequestId: string;
	offerId: string;
	leaseEpoch: number;
}

export interface QuestionnairePresenter {
	logicalClientId: string;
	connectionId: string;
	activeSessionId: string;
	capabilities: readonly DaemonClientCapability[];
	presentable: boolean;
}

export interface QuestionnaireWorkerOfferNeed extends QuestionnaireLeaseStamp {
	workerId: string;
	activeSessionId: string;
	createdAt: number;
	mode: QuestionnaireRequestMode;
}

export type QuestionnaireOfferResponse = "accepted" | "busy" | "rejected" | "presentation_error";
export type QuestionnaireOfferFailureReason =
	| Exclude<QuestionnaireOfferResponse, "accepted">
	| "timeout"
	| "client_lost"
	| "stale_generation"
	| "invalid_session"
	| "superseded";

export type QuestionnaireOfferResult =
	| { status: "accepted"; lease: QuestionnaireLease }
	| {
			status: "rejected";
			reason: QuestionnaireOfferFailureReason;
			offer: QuestionnaireLease | QuestionnaireWorkerOfferNeed;
	  };

export type QuestionnaireLeaseRevocationReason = "client_lost" | "presentability_lost" | "presentation_error";

export interface QuestionnaireBrokerCallbacks {
	deliverOffer(connectionId: string, activeSessionId: string, lease: QuestionnaireLease): void;
	deliverWithdraw(connectionId: string, activeSessionId: string, lease: QuestionnaireLease): void;
	onOfferResult(workerId: string, result: QuestionnaireOfferResult): void;
	onLeaseRevoked(workerId: string, lease: QuestionnaireLease, reason: QuestionnaireLeaseRevocationReason): void;
	onWithdrawn(workerId: string, lease: QuestionnaireLease): void;
}

interface QueuedNeed {
	need: QuestionnaireWorkerOfferNeed;
	sequence: number;
}

interface PendingOffer {
	workerId: string;
	activeSessionId: string;
	lease: QuestionnaireLease;
	timer: ReturnType<typeof setTimeout>;
}

interface ActiveLease {
	workerId: string;
	activeSessionId: string;
	lease: QuestionnaireLease;
	withdrawing: boolean;
}

const OFFER_ACK_TIMEOUT_MS = 5_000;

function requestKey(workerId: string, logicalRequestId: string): string {
	return `${workerId}\0${logicalRequestId}`;
}

function presenterKey(presenter: QuestionnairePresenter): string {
	return `${presenter.connectionId}\0${presenter.activeSessionId}`;
}

function hasCapability(presenter: QuestionnairePresenter, capability: DaemonClientCapability): boolean {
	return presenter.capabilities.includes(capability);
}

function isRichPresenter(presenter: QuestionnairePresenter): boolean {
	return hasCapability(presenter, "extension_ui") && hasCapability(presenter, "questionnaire_v1");
}

function sameStamp(left: QuestionnaireLeaseStamp, right: QuestionnaireLeaseStamp): boolean {
	return (
		left.supervisorGeneration === right.supervisorGeneration &&
		left.logicalRequestId === right.logicalRequestId &&
		left.offerId === right.offerId &&
		left.leaseEpoch === right.leaseEpoch
	);
}

function sameNeedOffer(left: QuestionnaireWorkerOfferNeed, right: QuestionnaireWorkerOfferNeed): boolean {
	return left.activeSessionId === right.activeSessionId && sameStamp(left, right);
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
	if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
}

export class QuestionnaireBroker {
	private presenters = new Map<string, QuestionnairePresenter>();
	private readonly queuedNeeds = new Map<string, QueuedNeed>();
	private readonly pendingOffersByConnection = new Map<string, PendingOffer>();
	private readonly activeLeasesByConnection = new Map<string, ActiveLease>();
	private readonly suppressedPresenterKeys = new Set<string>();
	private sequence = 0;
	private arbitrating = false;

	constructor(
		private readonly supervisorGeneration: string,
		private readonly callbacks: QuestionnaireBrokerCallbacks,
	) {}

	synchronizePresenters(presenters: readonly QuestionnairePresenter[]): void {
		this.suppressedPresenterKeys.clear();
		const next = new Map<string, QuestionnairePresenter>();
		for (const presenter of presenters) next.set(presenterKey(presenter), { ...presenter });
		this.presenters = next;
		for (const [connectionId, pending] of [...this.pendingOffersByConnection]) {
			if (this.isPresenterEligibleForLease(connectionId, pending.activeSessionId, pending.lease)) continue;
			this.rejectPending(connectionId, "client_lost");
		}
		for (const [connectionId, active] of [...this.activeLeasesByConnection]) {
			if (this.isPresenterEligibleForLease(connectionId, active.activeSessionId, active.lease)) continue;
			this.activeLeasesByConnection.delete(connectionId);
			this.callbacks.onLeaseRevoked(active.workerId, active.lease, "presentability_lost");
		}
		this.arbitrate();
	}

	offer(need: QuestionnaireWorkerOfferNeed): void {
		if (need.supervisorGeneration !== this.supervisorGeneration) {
			this.callbacks.onOfferResult(need.workerId, {
				status: "rejected",
				reason: "stale_generation",
				offer: need,
			});
			return;
		}
		const key = requestKey(need.workerId, need.logicalRequestId);
		const active = [...this.activeLeasesByConnection.values()].find(
			(candidate) => requestKey(candidate.workerId, candidate.lease.logicalRequestId) === key,
		);
		if (active) {
			this.callbacks.onOfferResult(
				need.workerId,
				active.activeSessionId === need.activeSessionId && sameStamp(active.lease, need)
					? { status: "accepted", lease: active.lease }
					: { status: "rejected", reason: "superseded", offer: need },
			);
			return;
		}
		for (const [connectionId, pending] of this.pendingOffersByConnection) {
			if (requestKey(pending.workerId, pending.lease.logicalRequestId) !== key) continue;
			if (pending.activeSessionId === need.activeSessionId && sameStamp(pending.lease, need)) return;
			this.rejectPending(connectionId, "superseded");
			break;
		}
		const previous = this.queuedNeeds.get(key);
		if (previous) {
			if (sameNeedOffer(previous.need, need)) return;
			this.queuedNeeds.delete(key);
			this.callbacks.onOfferResult(previous.need.workerId, {
				status: "rejected",
				reason: "superseded",
				offer: previous.need,
			});
		}
		this.queuedNeeds.set(key, { need: { ...need }, sequence: this.sequence++ });
		this.arbitrate();
	}

	respondToOffer(
		connectionId: string,
		activeSessionId: string,
		stamp: QuestionnaireLeaseStamp,
		response: QuestionnaireOfferResponse,
	): "accepted" | "stale" {
		const pending = this.pendingOffersByConnection.get(connectionId);
		if (!pending || pending.activeSessionId !== activeSessionId || !sameStamp(pending.lease, stamp)) return "stale";
		clearTimeout(pending.timer);
		this.pendingOffersByConnection.delete(connectionId);
		if (response === "accepted") {
			this.activeLeasesByConnection.set(connectionId, {
				workerId: pending.workerId,
				activeSessionId: pending.activeSessionId,
				lease: pending.lease,
				withdrawing: false,
			});
			this.callbacks.onOfferResult(pending.workerId, { status: "accepted", lease: pending.lease });
			return "accepted";
		}
		this.suppressedPresenterKeys.add(`${connectionId}\0${activeSessionId}`);
		this.callbacks.onOfferResult(pending.workerId, {
			status: "rejected",
			reason: response,
			offer: pending.lease,
		});
		this.arbitrate();
		return "accepted";
	}

	disconnect(connectionId: string): void {
		this.presenters = new Map(
			[...this.presenters].filter(([, presenter]) => presenter.connectionId !== connectionId),
		);
		if (this.pendingOffersByConnection.has(connectionId)) this.rejectPending(connectionId, "client_lost");
		const active = this.activeLeasesByConnection.get(connectionId);
		if (active) {
			this.activeLeasesByConnection.delete(connectionId);
			this.callbacks.onLeaseRevoked(active.workerId, active.lease, "client_lost");
		}
		this.arbitrate();
	}

	presentationError(
		connectionId: string,
		activeSessionId: string,
		stamp: QuestionnaireLeaseStamp,
	): "accepted" | "stale" {
		const active = this.activeLeasesByConnection.get(connectionId);
		if (!active || active.activeSessionId !== activeSessionId || !sameStamp(active.lease, stamp)) return "stale";
		this.activeLeasesByConnection.delete(connectionId);
		this.callbacks.onLeaseRevoked(active.workerId, active.lease, "presentation_error");
		this.arbitrate();
		return "accepted";
	}

	validateLeaseMessage(connectionId: string, activeSessionId: string, stamp: QuestionnaireLeaseStamp): boolean {
		return this.leaseForMessage(connectionId, activeSessionId, stamp) !== undefined;
	}

	leaseForMessage(
		connectionId: string,
		activeSessionId: string,
		stamp: QuestionnaireLeaseStamp,
		allowWithdrawing = false,
	): QuestionnaireLease | undefined {
		const active = this.activeLeasesByConnection.get(connectionId);
		return active &&
			active.activeSessionId === activeSessionId &&
			(allowWithdrawing || !active.withdrawing) &&
			sameStamp(active.lease, stamp)
			? { ...active.lease }
			: undefined;
	}

	routeToLease(
		workerId: string,
		activeSessionId: string,
		stamp: QuestionnaireLeaseStamp,
		deliver: (connectionId: string) => void,
	): boolean {
		const active = [...this.activeLeasesByConnection.values()].find(
			(candidate) =>
				candidate.workerId === workerId &&
				candidate.activeSessionId === activeSessionId &&
				!candidate.withdrawing &&
				sameStamp(candidate.lease, stamp),
		);
		if (!active) return false;
		deliver(active.lease.connectionId);
		return true;
	}

	withdraw(workerId: string, stamp: QuestionnaireLeaseStamp): boolean {
		const active = [...this.activeLeasesByConnection.values()].find(
			(candidate) => candidate.workerId === workerId && sameStamp(candidate.lease, stamp),
		);
		if (!active) return false;
		if (!active.withdrawing) {
			active.withdrawing = true;
			this.callbacks.deliverWithdraw(active.lease.connectionId, active.activeSessionId, active.lease);
		}
		return true;
	}

	acknowledgeWithdraw(
		connectionId: string,
		activeSessionId: string,
		stamp: QuestionnaireLeaseStamp,
	): "accepted" | "stale" {
		const active = this.activeLeasesByConnection.get(connectionId);
		if (!active?.withdrawing || active.activeSessionId !== activeSessionId || !sameStamp(active.lease, stamp)) {
			return "stale";
		}
		this.activeLeasesByConnection.delete(connectionId);
		this.callbacks.onWithdrawn(active.workerId, active.lease);
		this.arbitrate();
		return "accepted";
	}

	debugContentFreeState(): {
		generation: string;
		queued: number;
		pendingConnections: string[];
		leasedConnections: string[];
	} {
		return {
			generation: this.supervisorGeneration,
			queued: this.queuedNeeds.size,
			pendingConnections: [...this.pendingOffersByConnection.keys()],
			leasedConnections: [...this.activeLeasesByConnection.keys()],
		};
	}

	private arbitrate(): void {
		if (this.arbitrating) return;
		this.arbitrating = true;
		try {
			const ordered = [...this.queuedNeeds.entries()].sort(
				([, left], [, right]) => left.need.createdAt - right.need.createdAt || left.sequence - right.sequence,
			);
			for (const [key, queued] of ordered) {
				if (!this.queuedNeeds.has(key)) continue;
				const selection = this.selectPresenter(queued.need);
				if (!selection) continue;
				this.queuedNeeds.delete(key);
				const lease: QuestionnaireLease = {
					supervisorGeneration: this.supervisorGeneration,
					logicalRequestId: queued.need.logicalRequestId,
					offerId: queued.need.offerId,
					leaseEpoch: queued.need.leaseEpoch,
					logicalClientId: selection.presenter.logicalClientId,
					connectionId: selection.presenter.connectionId,
					mode: selection.mode,
				};
				const timer = setTimeout(
					() => this.rejectPending(selection.presenter.connectionId, "timeout"),
					OFFER_ACK_TIMEOUT_MS,
				);
				unrefTimer(timer);
				this.pendingOffersByConnection.set(selection.presenter.connectionId, {
					workerId: queued.need.workerId,
					activeSessionId: queued.need.activeSessionId,
					lease,
					timer,
				});
				try {
					this.callbacks.deliverOffer(selection.presenter.connectionId, queued.need.activeSessionId, lease);
				} catch {
					this.rejectPending(selection.presenter.connectionId, "presentation_error");
				}
			}
		} finally {
			this.arbitrating = false;
		}
	}

	private selectPresenter(
		need: QuestionnaireWorkerOfferNeed,
	): { presenter: QuestionnairePresenter; mode: QuestionnairePresentationMode } | undefined {
		const available = [...this.presenters.values()].filter(
			(presenter) =>
				presenter.activeSessionId === need.activeSessionId &&
				presenter.presentable &&
				!this.suppressedPresenterKeys.has(presenterKey(presenter)) &&
				!this.pendingOffersByConnection.has(presenter.connectionId) &&
				!this.activeLeasesByConnection.has(presenter.connectionId),
		);
		if (need.mode !== "legacy") {
			const rich = available.find(isRichPresenter);
			if (rich) return { presenter: rich, mode: "rich" };
			if (need.mode === "rich") return undefined;
			const richPresenterAttached = [...this.presenters.values()].some(
				(presenter) =>
					presenter.activeSessionId === need.activeSessionId &&
					isRichPresenter(presenter) &&
					!this.suppressedPresenterKeys.has(presenterKey(presenter)) &&
					!this.pendingOffersByConnection.has(presenter.connectionId) &&
					!this.activeLeasesByConnection.has(presenter.connectionId),
			);
			if (richPresenterAttached) return undefined;
		}
		const legacy = available.find((presenter) => hasCapability(presenter, "extension_ui"));
		return legacy ? { presenter: legacy, mode: "legacy" } : undefined;
	}

	private presenterForLease(activeSessionId: string, lease: QuestionnaireLease): QuestionnairePresenter | undefined {
		return this.presenters.get(`${lease.connectionId}\0${activeSessionId}`);
	}

	private isPresenterEligibleForLease(
		connectionId: string,
		activeSessionId: string,
		lease: QuestionnaireLease,
	): boolean {
		const presenter = this.presenterForLease(activeSessionId, lease);
		if (!presenter || presenter.connectionId !== connectionId || !presenter.presentable) return false;
		return lease.mode === "rich" ? isRichPresenter(presenter) : hasCapability(presenter, "extension_ui");
	}

	private rejectPending(connectionId: string, reason: QuestionnaireOfferFailureReason): void {
		const pending = this.pendingOffersByConnection.get(connectionId);
		if (!pending) return;
		clearTimeout(pending.timer);
		this.pendingOffersByConnection.delete(connectionId);
		if (reason === "presentation_error") {
			this.suppressedPresenterKeys.add(`${connectionId}\0${pending.activeSessionId}`);
		}
		this.callbacks.onOfferResult(pending.workerId, {
			status: "rejected",
			reason,
			offer: pending.lease,
		});
		this.arbitrate();
	}
}

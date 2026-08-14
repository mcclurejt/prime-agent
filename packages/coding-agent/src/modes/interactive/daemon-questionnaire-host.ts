import { randomUUID } from "node:crypto";
import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import type { ExtensionQuestionnaireDraftV1, ExtensionQuestionnaireDraftV2 } from "../../core/extensions/types.js";
import type { KeybindingsManager } from "../../core/keybindings.js";
import type {
	AgentConnectionQuestionnaireLease,
	AgentConnectionQuestionnaireMutationResult,
	AgentConnectionQuestionnairePresentation,
	AgentConnectionQuestionnaireTransport,
} from "../agent-connection/types.js";
import { showFullPaneOverlay } from "./components/centered-overlay.js";
import { QuestionnaireComponent } from "./components/questionnaire.js";

type QuestionnaireDraft = ExtensionQuestionnaireDraftV1 | ExtensionQuestionnaireDraftV2;

export const QUESTIONNAIRE_TEXT_CHECKPOINT_DEBOUNCE_MS = 150;

interface AcceptedOffer {
	activeSessionId: string;
	lease: AgentConnectionQuestionnaireLease;
}

interface ActivePresentation extends AcceptedOffer {
	component: QuestionnaireComponent;
	handle: OverlayHandle;
	authoritativeRevision: number;
	mutationEpoch: number;
	latestDraft: QuestionnaireDraft;
	checkpointTail: Promise<void>;
	textCheckpointTimer?: ReturnType<typeof setTimeout>;
	closed: boolean;
	remotePresented: boolean;
}

export interface DaemonQuestionnaireRemoteSnapshot {
	activeSessionId: string;
	lease: AgentConnectionQuestionnaireLease;
	authoritativeRevision: number;
	request: AgentConnectionQuestionnairePresentation["request"];
	draft: QuestionnaireDraft;
}

export type DaemonQuestionnaireRemoteSubmitResult =
	| { status: "ack"; authoritativeRevision: number }
	| {
			status: "conflict";
			authoritativeRevision: number;
			snapshot: DaemonQuestionnaireRemoteSnapshot;
			draft: QuestionnaireDraft;
			changedQuestionIds: string[];
	  }
	| { status: "submitted" }
	| { status: "terminal" }
	| { status: "stale-lease" }
	| { status: "unavailable" };

/**
 * The remote manager receives data and an explicitly scoped submit callback only.
 * It cannot obtain the daemon transport or local overlay controls from this boundary.
 */
export interface DaemonQuestionnaireRemoteRegistration {
	present(
		snapshot: DaemonQuestionnaireRemoteSnapshot,
		submit: (
			base: DaemonQuestionnaireRemoteSnapshot,
			completedDraft: QuestionnaireDraft,
		) => Promise<DaemonQuestionnaireRemoteSubmitResult>,
	): void | Promise<void>;
	suspend?(): void | Promise<void>;
	rebind?(
		snapshot: DaemonQuestionnaireRemoteSnapshot,
		submit: (
			base: DaemonQuestionnaireRemoteSnapshot,
			completedDraft: QuestionnaireDraft,
		) => Promise<DaemonQuestionnaireRemoteSubmitResult>,
	): void | Promise<void>;
	terminal?(): void | Promise<void>;
	revoke?(): void | Promise<void>;
}

export interface DaemonQuestionnaireHostOptions {
	ui: TUI;
	keybindings: KeybindingsManager;
	transport: AgentConnectionQuestionnaireTransport;
	remoteRegistration?: DaemonQuestionnaireRemoteRegistration;
	createMutationId?: () => string;
	setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
	clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

function sameLease(left: AgentConnectionQuestionnaireLease, right: AgentConnectionQuestionnaireLease): boolean {
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

function cloneDraft<TDraft extends QuestionnaireDraft>(draft: TDraft): TDraft {
	return structuredClone(draft);
}

function semanticDraftProjection(draft: QuestionnaireDraft): QuestionnaireDraft {
	return {
		version: draft.version,
		currentStep: { ...draft.currentStep },
		states: draft.states.map((state) => {
			const note = "note" in state ? { note: "" } : {};
			switch (state.kind) {
				case "confirm":
				case "single-select":
					return { ...state, ...note, otherText: "" };
				case "multi-select":
					return { ...state, ...note, choiceIds: [...state.choiceIds], otherText: "" };
				case "short-text":
				case "multiline-text":
					return { ...state, ...note, value: "" };
			}
			return state;
		}),
	} as QuestionnaireDraft;
}

function isTextOnlyChange(previous: QuestionnaireDraft, next: QuestionnaireDraft): boolean {
	return JSON.stringify(semanticDraftProjection(previous)) === JSON.stringify(semanticDraftProjection(next));
}

/** Owns the exact leased daemon-backed rich questionnaire overlay and its worker CAS stream. */
export class DaemonQuestionnaireHost {
	private readonly createMutationId: () => string;
	private readonly setTimer: NonNullable<DaemonQuestionnaireHostOptions["setTimer"]>;
	private readonly clearTimer: NonNullable<DaemonQuestionnaireHostOptions["clearTimer"]>;
	private acceptedOffer: AcceptedOffer | undefined;
	private active: ActivePresentation | undefined;
	private suspendedLogicalRequestId: string | undefined;
	private disposed = false;

	constructor(private readonly options: DaemonQuestionnaireHostOptions) {
		this.createMutationId = options.createMutationId ?? randomUUID;
		this.setTimer = options.setTimer ?? setTimeout;
		this.clearTimer = options.clearTimer ?? clearTimeout;
	}

	async offer(activeSessionId: string, lease: AgentConnectionQuestionnaireLease): Promise<void> {
		if (this.suspendedLogicalRequestId !== undefined && this.suspendedLogicalRequestId !== lease.logicalRequestId) {
			this.suspendedLogicalRequestId = undefined;
			await Promise.resolve(this.options.remoteRegistration?.revoke?.()).catch(() => undefined);
		}
		if (this.disposed || lease.mode !== "rich" || this.acceptedOffer || this.active) {
			await this.options.transport.respondToOffer(lease, "busy");
			return;
		}
		this.acceptedOffer = { activeSessionId, lease: structuredClone(lease) };
		try {
			const status = await this.options.transport.respondToOffer(lease, "accepted");
			if (status !== "accepted" && this.acceptedOffer?.lease && sameLease(this.acceptedOffer.lease, lease)) {
				this.acceptedOffer = undefined;
			}
		} catch {
			if (this.acceptedOffer?.lease && sameLease(this.acceptedOffer.lease, lease)) this.acceptedOffer = undefined;
		}
	}

	async present(presentation: AgentConnectionQuestionnairePresentation): Promise<void> {
		if (this.disposed) return;
		if (
			this.active?.activeSessionId === presentation.activeSessionId &&
			sameLease(this.active.lease, presentation.lease)
		) {
			return;
		}
		const accepted = this.acceptedOffer;
		if (
			!accepted ||
			accepted.activeSessionId !== presentation.activeSessionId ||
			!sameLease(accepted.lease, presentation.lease)
		) {
			const status = await this.options.transport.reportPresentationError(presentation.lease).catch(() => undefined);
			if (status === "accepted") {
				this.acceptedOffer = undefined;
				if (this.active) this.closeActive(this.active);
			}
			return;
		}
		this.acceptedOffer = undefined;
		let component: QuestionnaireComponent | undefined;
		let handle: OverlayHandle | undefined;
		try {
			const active = {} as ActivePresentation;
			component = new QuestionnaireComponent({
				tui: this.options.ui,
				keybindings: this.options.keybindings,
				request: presentation.request,
				initialDraft: presentation.draft,
				getRows: () => this.options.ui.terminal.rows,
				requestRender: () => this.options.ui.requestRender(),
				onDraftChange: (draft) => this.draftChanged(active, draft),
				onSubmit: () => void this.submit(active),
				onDismiss: () => void this.dismiss(active),
			});
			handle = showFullPaneOverlay(this.options.ui, component, {
				fullWidth: true,
				suspendFullscreenMouse: true,
			});
			Object.assign(active, {
				activeSessionId: presentation.activeSessionId,
				lease: structuredClone(presentation.lease),
				component,
				handle,
				authoritativeRevision: presentation.authoritativeRevision,
				mutationEpoch: 0,
				latestDraft: cloneDraft(presentation.draft),
				checkpointTail: Promise.resolve(),
				closed: false,
				remotePresented: false,
			} satisfies ActivePresentation);
			this.active = active;
			if (this.suspendedLogicalRequestId === active.lease.logicalRequestId) {
				this.suspendedLogicalRequestId = undefined;
				active.remotePresented = true;
				void Promise.resolve(
					this.options.remoteRegistration?.rebind?.(this.remoteSnapshot(active), (base, completedDraft) =>
						this.submitRemote(active, base, completedDraft),
					),
				).catch(() => undefined);
			} else this.presentRemote(active);
		} catch {
			handle?.hide();
			component?.dispose();
			await this.options.transport.reportPresentationError(presentation.lease).catch(() => undefined);
		}
	}

	async withdraw(activeSessionId: string, lease: AgentConnectionQuestionnaireLease): Promise<void> {
		if (this.acceptedOffer?.activeSessionId === activeSessionId && sameLease(this.acceptedOffer.lease, lease)) {
			this.acceptedOffer = undefined;
		}
		if (this.active?.activeSessionId === activeSessionId && sameLease(this.active.lease, lease)) {
			this.closeActive(this.active);
		}
		if (this.suspendedLogicalRequestId === lease.logicalRequestId) {
			this.suspendedLogicalRequestId = undefined;
			await Promise.resolve(this.options.remoteRegistration?.revoke?.()).catch(() => undefined);
		}
		await this.options.transport.acknowledgeWithdraw(lease).catch(() => undefined);
	}

	/** Suspends only remote mutation during a transient reconnect; a matching offer may rebind it. */
	suspend(): void {
		// A disconnect can arrive after offer acceptance but before presentation.
		this.acceptedOffer = undefined;
		if (!this.active) return;
		this.suspendedLogicalRequestId = this.active.lease.logicalRequestId;
		void Promise.resolve(this.options.remoteRegistration?.suspend?.()).catch(() => undefined);
		this.closeActive(this.active, "suspend");
	}

	conceal(): void {
		this.acceptedOffer = undefined;
		this.revokeSuspended();
		if (this.active) this.closeActive(this.active);
	}

	private revokeSuspended(): void {
		if (this.suspendedLogicalRequestId === undefined) return;
		this.suspendedLogicalRequestId = undefined;
		void Promise.resolve(this.options.remoteRegistration?.revoke?.()).catch(() => undefined);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.conceal();
	}

	private remoteSnapshot(active: ActivePresentation): DaemonQuestionnaireRemoteSnapshot {
		return {
			activeSessionId: active.activeSessionId,
			lease: structuredClone(active.lease),
			authoritativeRevision: active.authoritativeRevision,
			request: structuredClone(active.component.model.request),
			draft: cloneDraft(active.latestDraft),
		};
	}

	private presentRemote(active: ActivePresentation): void {
		const registration = this.options.remoteRegistration;
		if (!registration || !this.isCurrent(active) || active.remotePresented) return;
		active.remotePresented = true;
		void Promise.resolve(
			registration.present(this.remoteSnapshot(active), (base, completedDraft) =>
				this.submitRemote(active, base, completedDraft),
			),
		).catch(() => undefined);
	}

	private draftChanged(active: ActivePresentation, draftValue: QuestionnaireDraft): void {
		if (!this.isCurrent(active)) return;
		const draft = cloneDraft(draftValue);
		const textOnly = isTextOnlyChange(active.latestDraft, draft);
		active.latestDraft = draft;
		if (active.textCheckpointTimer) {
			this.clearTimer(active.textCheckpointTimer);
			active.textCheckpointTimer = undefined;
		}
		if (textOnly) {
			active.textCheckpointTimer = this.setTimer(() => {
				active.textCheckpointTimer = undefined;
				this.enqueueCheckpoint(active, active.latestDraft);
			}, QUESTIONNAIRE_TEXT_CHECKPOINT_DEBOUNCE_MS);
			return;
		}
		this.enqueueCheckpoint(active, draft);
	}

	private enqueueCheckpoint(active: ActivePresentation, draftValue: QuestionnaireDraft): void {
		const draft = cloneDraft(draftValue);
		const mutationEpoch = active.mutationEpoch;
		void this.enqueueMutation(active, false, async () => {
			if (mutationEpoch !== active.mutationEpoch) return;
			const clientMutationId = this.createMutationId();
			const result = await this.options.transport.checkpoint(
				active.lease,
				active.authoritativeRevision,
				clientMutationId,
				draft,
			);
			this.applyMutationResult(active, result, clientMutationId);
		});
	}

	private enqueueMutation<T>(
		active: ActivePresentation,
		remote: boolean,
		mutation: () => Promise<T>,
	): Promise<T | undefined> {
		const run = active.checkpointTail.then(async () => {
			if (!this.isCurrent(active)) return undefined;
			return await mutation();
		});
		active.checkpointTail = run
			.then(() => undefined)
			.catch(async () => {
				if (!remote) await this.failPresentation(active);
			});
		return run.catch(() => undefined);
	}

	private applyMutationResult(
		active: ActivePresentation,
		result: AgentConnectionQuestionnaireMutationResult,
		clientMutationId: string,
	): void {
		if (!this.isCurrent(active)) return;
		switch (result.status) {
			case "ack":
				if (result.ack.clientMutationId !== clientMutationId) {
					void this.failPresentation(active);
					return;
				}
				active.authoritativeRevision = result.ack.authoritativeRevision;
				return;
			case "conflict":
				if (!result.snapshot || !sameLease(result.snapshot.lease, active.lease)) {
					void this.failPresentation(active);
					return;
				}
				active.authoritativeRevision = result.authoritativeRevision;
				active.mutationEpoch++;
				active.latestDraft = cloneDraft(result.snapshot.draft);
				active.component.applyDraft(result.snapshot.draft);
				return;
			case "terminal":
				this.closeActive(active, "terminal");
				return;
			case "mutation-id-collision":
				void this.failPresentation(active);
				return;
			case "stale-lease":
				this.closeActive(active, "revoke");
		}
	}

	private async submit(active: ActivePresentation): Promise<void> {
		if (!this.isCurrent(active)) return;
		this.cancelTextCheckpoint(active);
		const mutationEpoch = active.mutationEpoch;
		const draft = cloneDraft(active.component.model.draft);
		active.latestDraft = draft;
		await this.enqueueMutation(active, false, async () => {
			if (mutationEpoch !== active.mutationEpoch) return;
			const clientMutationId = this.createMutationId();
			const result = await this.options.transport.submit(
				active.lease,
				active.authoritativeRevision,
				clientMutationId,
				draft,
			);
			this.applyMutationResult(active, result, clientMutationId);
		});
	}

	private async submitRemote(
		active: ActivePresentation,
		base: DaemonQuestionnaireRemoteSnapshot,
		completedDraft: QuestionnaireDraft,
	): Promise<DaemonQuestionnaireRemoteSubmitResult> {
		const frozenBase = cloneDraft(base.draft);
		const completed = cloneDraft(completedDraft);
		const result = await this.enqueueMutation(active, true, async () => {
			if (!sameLease(base.lease, active.lease)) return { status: "stale-lease" } as const;
			const changedQuestionIds = frozenBase.states.flatMap((state, index) =>
				JSON.stringify(state) === JSON.stringify(active.latestDraft.states[index]) ? [] : [state.questionId],
			);
			if (changedQuestionIds.length > 0)
				return {
					status: "conflict",
					authoritativeRevision: active.authoritativeRevision,
					snapshot: this.remoteSnapshot(active),
					draft: cloneDraft(active.latestDraft),
					changedQuestionIds,
				} as const;
			const clientMutationId = this.createMutationId();
			const mutation = await this.options.transport.submit(
				active.lease,
				active.authoritativeRevision,
				clientMutationId,
				completed,
			);
			switch (mutation.status) {
				case "ack":
					return { status: "unavailable" } as const;
				case "conflict":
					if (!mutation.snapshot || !sameLease(mutation.snapshot.lease, active.lease))
						return { status: "unavailable" } as const;
					active.authoritativeRevision = mutation.authoritativeRevision;
					active.mutationEpoch++;
					active.latestDraft = cloneDraft(mutation.snapshot.draft);
					active.component.applyDraft(mutation.snapshot.draft);
					return {
						status: "conflict",
						authoritativeRevision: mutation.authoritativeRevision,
						snapshot: this.remoteSnapshot(active),
						draft: cloneDraft(mutation.snapshot.draft),
						changedQuestionIds: frozenBase.states.flatMap((state, index) =>
							JSON.stringify(state) === JSON.stringify(mutation.snapshot!.draft.states[index])
								? []
								: [state.questionId],
						),
					} as const;
				case "terminal":
					// A submit reaching terminal is the phone's remote success, never a local preemption.
					this.closeActive(active, "suspend");
					return { status: "submitted" } as const;
				case "stale-lease":
					this.closeActive(active, "revoke");
					return { status: "stale-lease" } as const;
				case "mutation-id-collision":
					return { status: "unavailable" } as const;
			}
		});
		return result ?? { status: "unavailable" };
	}

	private async dismiss(active: ActivePresentation): Promise<void> {
		if (!this.isCurrent(active)) return;
		this.cancelTextCheckpoint(active);
		await active.checkpointTail;
		if (!this.isCurrent(active)) return;
		try {
			const result = await this.options.transport.dismiss(active.lease);
			this.applyMutationResult(active, result, "dismiss");
		} catch {
			await this.failPresentation(active);
		}
	}

	private async failPresentation(active: ActivePresentation): Promise<void> {
		if (!this.isCurrent(active)) return;
		this.closeActive(active);
		await this.options.transport.reportPresentationError(active.lease).catch(() => undefined);
	}

	private cancelTextCheckpoint(active: ActivePresentation): void {
		if (!active.textCheckpointTimer) return;
		this.clearTimer(active.textCheckpointTimer);
		active.textCheckpointTimer = undefined;
	}

	private isCurrent(active: ActivePresentation): boolean {
		return !active.closed && this.active === active && !this.disposed;
	}

	private closeActive(
		active: ActivePresentation,
		remoteDisposition: "terminal" | "revoke" | "suspend" = "revoke",
	): void {
		if (active.closed) return;
		active.closed = true;
		this.cancelTextCheckpoint(active);
		if (this.active === active) this.active = undefined;
		active.handle.hide();
		active.component.dispose();
		active.latestDraft = { version: 1, currentStep: { kind: "review" }, states: [] };
		const registration = this.options.remoteRegistration;
		if (registration && active.remotePresented && remoteDisposition !== "suspend") {
			const operation = remoteDisposition === "terminal" ? registration.terminal : registration.revoke;
			void Promise.resolve(operation?.call(registration)).catch(() => undefined);
		}
	}
}

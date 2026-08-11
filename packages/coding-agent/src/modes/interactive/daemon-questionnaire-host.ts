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
}

export interface DaemonQuestionnaireHostOptions {
	ui: TUI;
	keybindings: KeybindingsManager;
	transport: AgentConnectionQuestionnaireTransport;
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
	private disposed = false;

	constructor(private readonly options: DaemonQuestionnaireHostOptions) {
		this.createMutationId = options.createMutationId ?? randomUUID;
		this.setTimer = options.setTimer ?? setTimeout;
		this.clearTimer = options.clearTimer ?? clearTimeout;
	}

	async offer(activeSessionId: string, lease: AgentConnectionQuestionnaireLease): Promise<void> {
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
				maxContentWidth: 96,
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
			} satisfies ActivePresentation);
			this.active = active;
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
		await this.options.transport.acknowledgeWithdraw(lease).catch(() => undefined);
	}

	conceal(): void {
		this.acceptedOffer = undefined;
		if (this.active) this.closeActive(this.active);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.conceal();
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
		active.checkpointTail = active.checkpointTail
			.then(async () => {
				if (!this.isCurrent(active) || mutationEpoch !== active.mutationEpoch) return;
				const clientMutationId = this.createMutationId();
				const result = await this.options.transport.checkpoint(
					active.lease,
					active.authoritativeRevision,
					clientMutationId,
					draft,
				);
				this.applyMutationResult(active, result, clientMutationId);
			})
			.catch(() => void this.failPresentation(active));
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
				this.closeActive(active);
				return;
			case "mutation-id-collision":
				void this.failPresentation(active);
				return;
			case "stale-lease":
				this.closeActive(active);
		}
	}

	private async submit(active: ActivePresentation): Promise<void> {
		if (!this.isCurrent(active)) return;
		this.cancelTextCheckpoint(active);
		const mutationEpoch = active.mutationEpoch;
		const draft = cloneDraft(active.component.model.draft);
		active.latestDraft = draft;
		await active.checkpointTail;
		if (!this.isCurrent(active) || mutationEpoch !== active.mutationEpoch) return;
		const clientMutationId = this.createMutationId();
		try {
			const result = await this.options.transport.submit(
				active.lease,
				active.authoritativeRevision,
				clientMutationId,
				draft,
			);
			this.applyMutationResult(active, result, clientMutationId);
		} catch {
			await this.failPresentation(active);
		}
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

	private closeActive(active: ActivePresentation): void {
		if (active.closed) return;
		active.closed = true;
		this.cancelTextCheckpoint(active);
		if (this.active === active) this.active = undefined;
		active.handle.hide();
		active.component.dispose();
		active.latestDraft = { version: 1, currentStep: { kind: "review" }, states: [] };
	}
}

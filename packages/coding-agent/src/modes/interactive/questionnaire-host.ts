import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import type {
	ExtensionQuestionnaireOptions,
	ExtensionQuestionnaireOutcome,
	ExtensionQuestionnaireOutcomeV2,
	ExtensionQuestionnaireRequestV1,
	ExtensionQuestionnaireRequestV2,
	ExtensionUIContext,
} from "../../core/extensions/types.js";
import type { KeybindingsManager } from "../../core/keybindings.js";
import { showFullPaneOverlay } from "./components/centered-overlay.js";
import { QuestionnaireComponent } from "./components/questionnaire.js";

type QuestionnaireRequest = ExtensionQuestionnaireRequestV1 | ExtensionQuestionnaireRequestV2;
type QuestionnaireOutcome = ExtensionQuestionnaireOutcome | ExtensionQuestionnaireOutcomeV2;

interface PendingQuestionnaire {
	request: QuestionnaireRequest;
	signal: AbortSignal | undefined;
	resolve: (outcome: QuestionnaireOutcome) => void;
	reject: (error: unknown) => void;
	onAbort: () => void;
	settled: boolean;
}

interface ActiveQuestionnaire {
	pending: PendingQuestionnaire;
	component: QuestionnaireComponent;
	handle: OverlayHandle;
}

/** Owns a strict FIFO of client-local in-process questionnaire overlays. */
export class InteractiveQuestionnaireHost {
	private active: ActiveQuestionnaire | undefined;
	private readonly queue: PendingQuestionnaire[] = [];

	readonly questionnaire: NonNullable<ExtensionUIContext["questionnaire"]> = (request, options) =>
		this.request(request, options);

	constructor(
		private readonly ui: TUI,
		private readonly keybindings: KeybindingsManager,
	) {}

	request(request: QuestionnaireRequest, options?: ExtensionQuestionnaireOptions): Promise<QuestionnaireOutcome> {
		if (options?.signal?.aborted) return Promise.resolve({ status: "aborted", reason: "signal" });
		return new Promise((resolve, reject) => {
			const pending: PendingQuestionnaire = {
				request,
				signal: options?.signal,
				resolve,
				reject,
				onAbort: () => this.abortPending(pending),
				settled: false,
			};
			pending.signal?.addEventListener("abort", pending.onAbort, { once: true });
			this.queue.push(pending);
			this.presentNext();
		});
	}

	terminate(reason: Extract<QuestionnaireOutcome, { status: "terminated" }>["reason"]): void {
		const outcome: QuestionnaireOutcome = { status: "terminated", reason };
		const active = this.active;
		this.active = undefined;
		if (active) {
			active.handle.hide();
			active.component.dispose();
			this.settlePending(active.pending, outcome);
		}
		for (const pending of this.queue.splice(0)) this.settlePending(pending, outcome);
	}

	private presentNext(): void {
		if (this.active) return;
		const pending = this.queue.shift();
		if (!pending) return;
		if (pending.settled) {
			this.presentNext();
			return;
		}
		let component: QuestionnaireComponent | undefined;
		let handle: OverlayHandle | undefined;
		try {
			const finish = (outcome: QuestionnaireOutcome) => this.finishActive(pending, outcome);
			component = new QuestionnaireComponent({
				tui: this.ui,
				keybindings: this.keybindings,
				request: pending.request,
				getRows: () => this.ui.terminal.rows,
				requestRender: () => this.ui.requestRender(),
				onSubmit: finish,
				onDismiss: () => finish({ status: "dismissed" }),
			});
			handle = showFullPaneOverlay(this.ui, component, { maxContentWidth: 144, suspendFullscreenMouse: true });
			this.active = { pending, component, handle };
		} catch (error) {
			handle?.hide();
			component?.dispose();
			this.rejectPending(pending, error);
			this.presentNext();
		}
	}

	private finishActive(pending: PendingQuestionnaire, outcome: QuestionnaireOutcome): void {
		const active = this.active;
		if (!active || active.pending !== pending || pending.settled) return;
		this.active = undefined;
		active.handle.hide();
		active.component.dispose();
		this.settlePending(pending, outcome);
		this.presentNext();
	}

	private abortPending(pending: PendingQuestionnaire): void {
		if (pending.settled) return;
		if (this.active?.pending === pending) {
			this.finishActive(pending, { status: "aborted", reason: "signal" });
			return;
		}
		const index = this.queue.indexOf(pending);
		if (index >= 0) this.queue.splice(index, 1);
		this.settlePending(pending, { status: "aborted", reason: "signal" });
	}

	private settlePending(pending: PendingQuestionnaire, outcome: QuestionnaireOutcome): void {
		if (pending.settled) return;
		pending.settled = true;
		pending.signal?.removeEventListener("abort", pending.onAbort);
		pending.request = { version: 1, questions: [] };
		pending.resolve(outcome);
	}

	private rejectPending(pending: PendingQuestionnaire, error: unknown): void {
		if (pending.settled) return;
		pending.settled = true;
		pending.signal?.removeEventListener("abort", pending.onAbort);
		pending.request = { version: 1, questions: [] };
		pending.reject(error);
	}
}

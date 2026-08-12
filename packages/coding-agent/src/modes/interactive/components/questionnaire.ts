import {
	type Component,
	CURSOR_MARKER,
	Editor,
	type Focusable,
	Input,
	type Keybinding,
	Markdown,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import {
	canonicalQuestionnaireJsonBytes,
	normalizeExtensionQuestionnaireDraftForValidatedRequest,
	normalizeExtensionQuestionnaireDraftV2,
	normalizeExtensionQuestionnaireRequest,
	normalizeExtensionQuestionnaireRequestV2,
	QUESTIONNAIRE_ENVELOPE_MAX_BYTES,
} from "../../../core/extensions/questionnaire.js";
import type {
	ExtensionQuestionnaireDraftQuestionState,
	ExtensionQuestionnaireDraftQuestionStateV2,
	ExtensionQuestionnaireDraftStep,
	ExtensionQuestionnaireDraftV1,
	ExtensionQuestionnaireDraftV2,
	ExtensionQuestionnaireOutcome,
	ExtensionQuestionnaireOutcomeV2,
	ExtensionQuestionnairePreview,
	ExtensionQuestionnaireQuestion,
	ExtensionQuestionnaireQuestionV2,
	ExtensionQuestionnaireRequestV1,
	ExtensionQuestionnaireRequestV2,
	ExtensionQuestionnaireResponse,
	ExtensionQuestionnaireResponseV2,
} from "../../../core/extensions/types.js";
import type { KeybindingsManager } from "../../../core/keybindings.js";
import { getEditorTheme, getMarkdownTheme, theme } from "../theme/theme.js";
import { formatKeyText } from "./keybinding-hints.js";
import { getMenuScrollWindow } from "./menu-panel.js";

const WIDE_LAYOUT_MIN_WIDTH = 64;
const PREVIEW_LAYOUT_MIN_WIDTH = 120;
const PREVIEW_LAYOUT_MIN_BODY_ROWS = 12;
const DECISION_CONTENT_WIDTH = 56;
const PREVIEW_GUTTER_WIDTH = 2;
const PREVIEW_MIN_WIDTH = 40;
const PANEL_PADDING_X = 2;
const MIN_USEFUL_BODY_ROWS = 3;
const REVIEW_PREVIEW_MAX_CHARS = 512;
const PROGRESS_WINDOW_MAX_QUESTIONS = 5;
const ACTIVE_LABEL_MIN_ROWS = 12;

type QuestionnaireQuestion = ExtensionQuestionnaireQuestion | ExtensionQuestionnaireQuestionV2;
type QuestionnaireRequest = ExtensionQuestionnaireRequestV1 | ExtensionQuestionnaireRequestV2;
type QuestionnaireDraft = ExtensionQuestionnaireDraftV1 | ExtensionQuestionnaireDraftV2;
type QuestionnaireState = ExtensionQuestionnaireDraftQuestionState | ExtensionQuestionnaireDraftQuestionStateV2;
type QuestionnaireResponse = ExtensionQuestionnaireResponse | ExtensionQuestionnaireResponseV2;

interface RenderedBody {
	lines: string[];
	anchor: number;
	previewLines?: string[];
	previewWidth?: number;
	decisionWidth?: number;
}

export interface QuestionnaireMutationResult {
	accepted: boolean;
	remainingBytes: number;
	message?: string;
}

function normalizeLineEndings(value: string): string {
	return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function draftStepKey(step: ExtensionQuestionnaireDraftStep): string {
	return step.kind === "review" ? "review" : `question:${step.questionId}`;
}

function cloneState(state: QuestionnaireState): QuestionnaireState {
	switch (state.kind) {
		case "confirm":
			return { ...state };
		case "single-select":
			return { ...state, selection: state.selection === null ? null : { ...state.selection } };
		case "multi-select":
			return { ...state, choiceIds: [...state.choiceIds] };
		case "short-text":
		case "multiline-text":
			return { ...state };
	}
}

function stateForQuestion(question: QuestionnaireQuestion): ExtensionQuestionnaireDraftQuestionState {
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
				value: normalizeLineEndings(question.initialValue ?? ""),
			};
	}
}

/** Pure request-bound draft and page-navigation model used by local and remote presenters. */
export class QuestionnaireDraftModel {
	private requestValue: QuestionnaireRequest;
	private value: QuestionnaireDraft;
	private readonly currentStepBytes: Map<string, number>;
	private maximumCurrentStepBytes: number;
	private reservedEnvelopeBytes = 0;
	private lastValidationMessage: string | undefined;
	private disposed = false;

	constructor(request: QuestionnaireRequest, initialDraft?: QuestionnaireDraft) {
		this.requestValue =
			request.version === 2
				? normalizeExtensionQuestionnaireRequestV2(request)
				: normalizeExtensionQuestionnaireRequest(request);
		const steps: ExtensionQuestionnaireDraftStep[] = [
			{ kind: "review" },
			...this.requestValue.questions.map((question) => ({ kind: "question" as const, questionId: question.id })),
		];
		this.currentStepBytes = new Map(
			steps.map((step) => [draftStepKey(step), canonicalQuestionnaireJsonBytes(step).byteLength]),
		);
		this.maximumCurrentStepBytes = Math.max(...this.currentStepBytes.values());
		const draft =
			initialDraft ??
			({
				version: this.requestValue.version,
				currentStep: { kind: "question", questionId: this.requestValue.questions[0]!.id },
				states: this.requestValue.questions.map(stateForQuestion),
			} as QuestionnaireDraft);
		const accepted = this.normalizeWithReservedStepBudget(draft);
		this.value = accepted.draft;
		this.reservedEnvelopeBytes = accepted.bytes;
	}

	get request(): QuestionnaireRequest {
		this.assertActive();
		return this.requestValue;
	}

	get draft(): QuestionnaireDraft {
		this.assertActive();
		return this.cloneDraft(this.value);
	}

	get currentStep(): ExtensionQuestionnaireDraftStep {
		this.assertActive();
		return { ...this.value.currentStep };
	}

	get validationMessage(): string | undefined {
		this.assertActive();
		return this.lastValidationMessage;
	}

	get remainingBytes(): number {
		this.assertActive();
		return QUESTIONNAIRE_ENVELOPE_MAX_BYTES - this.reservedEnvelopeBytes;
	}

	get currentQuestionIndex(): number | undefined {
		this.assertActive();
		const step = this.value.currentStep;
		if (step.kind === "review") return undefined;
		const index = this.requestValue.questions.findIndex((question) => question.id === step.questionId);
		return index < 0 ? undefined : index;
	}

	getState(questionId: string): QuestionnaireState {
		this.assertActive();
		const state = this.value.states.find((candidate) => candidate.questionId === questionId);
		if (!state) throw new TypeError(`Unknown questionnaire question ${JSON.stringify(questionId)}`);
		return cloneState(state);
	}

	getText(questionId: string): string {
		const state = this.getState(questionId);
		if (state.kind !== "short-text" && state.kind !== "multiline-text") {
			throw new TypeError(`Question ${JSON.stringify(questionId)} is not a text question`);
		}
		return state.value;
	}

	getOtherText(questionId: string): string {
		const state = this.getState(questionId);
		switch (state.kind) {
			case "confirm":
			case "single-select":
			case "multi-select":
				return state.otherText;
			case "short-text":
			case "multiline-text":
				throw new TypeError(`Question ${JSON.stringify(questionId)} does not support Other`);
		}
	}

	getNote(questionId: string): string {
		const state = this.getState(questionId);
		return "note" in state ? (state.note ?? "") : "";
	}

	updateNote(questionId: string, note: string): QuestionnaireMutationResult {
		if (this.requestValue.version !== 2) throw new TypeError("Questionnaire v1 does not support notes");
		const normalized = normalizeLineEndings(note);
		return this.mutate(questionId, (state) => ({
			...state,
			...(normalized ? { note: normalized } : { note: undefined }),
		}));
	}

	/**
	 * Apply an authoritative checkpoint. Protocol callers must catch validation errors and invoke this outside TUI input dispatch.
	 */
	applyDraft(draft: QuestionnaireDraft): void {
		this.assertActive();
		const accepted = this.normalizeWithReservedStepBudget(draft);
		this.value = accepted.draft;
		this.reservedEnvelopeBytes = accepted.bytes;
		this.lastValidationMessage = undefined;
	}

	next(): QuestionnaireMutationResult {
		const index = this.currentQuestionIndex;
		if (index === undefined) return this.success();
		const nextQuestion = this.requestValue.questions[index + 1];
		return this.setStep(nextQuestion ? { kind: "question", questionId: nextQuestion.id } : { kind: "review" });
	}

	previous(): QuestionnaireMutationResult {
		this.assertActive();
		if (this.value.currentStep.kind === "review") return this.goToQuestion(this.requestValue.questions.at(-1)!.id);
		const index = this.currentQuestionIndex ?? 0;
		return this.goToQuestion(this.requestValue.questions[Math.max(0, index - 1)]!.id);
	}

	goToQuestion(questionId: string): QuestionnaireMutationResult {
		this.assertActive();
		if (!this.requestValue.questions.some((question) => question.id === questionId)) {
			throw new TypeError(`Unknown questionnaire question ${JSON.stringify(questionId)}`);
		}
		return this.setStep({ kind: "question", questionId });
	}

	goToReview(): QuestionnaireMutationResult {
		return this.setStep({ kind: "review" });
	}

	answerConfirm(questionId: string, selection: "yes" | "no" | "other"): QuestionnaireMutationResult {
		return this.mutate(questionId, (state) => {
			if (state.kind !== "confirm") throw new TypeError("Question kind does not match confirm answer");
			return { ...state, selection };
		});
	}

	answerSingle(
		questionId: string,
		selection: { kind: "choice"; choiceId: string } | { kind: "other" },
	): QuestionnaireMutationResult {
		return this.mutate(questionId, (state) => {
			if (state.kind !== "single-select") throw new TypeError("Question kind does not match single-select answer");
			return { ...state, selection };
		});
	}

	toggleMultiChoice(questionId: string, choiceId: string): QuestionnaireMutationResult {
		return this.mutate(questionId, (state) => {
			if (state.kind !== "multi-select") throw new TypeError("Question kind does not match multi-select answer");
			const selected = new Set(state.choiceIds);
			if (selected.has(choiceId)) selected.delete(choiceId);
			else selected.add(choiceId);
			return { ...state, choiceIds: [...selected] };
		});
	}

	setMultiOtherSelected(questionId: string, selected: boolean): QuestionnaireMutationResult {
		return this.mutate(questionId, (state) => {
			if (state.kind !== "multi-select") throw new TypeError("Question kind does not match multi-select answer");
			return { ...state, otherSelected: selected, otherEditorOpen: selected && state.otherEditorOpen };
		});
	}

	setOther(questionId: string, text: string): QuestionnaireMutationResult {
		const normalized = normalizeLineEndings(text);
		return this.mutate(questionId, (state) => {
			switch (state.kind) {
				case "confirm":
					return { ...state, selection: "other", otherText: normalized };
				case "single-select":
					return { ...state, selection: { kind: "other" }, otherText: normalized };
				case "multi-select":
					return { ...state, otherSelected: true, otherText: normalized };
				case "short-text":
				case "multiline-text":
					throw new TypeError("Text questions do not support Other");
			}
		});
	}

	setOtherEditorOpen(questionId: string, open: boolean): QuestionnaireMutationResult {
		return this.mutate(questionId, (state) => {
			if (state.kind === "short-text" || state.kind === "multiline-text") {
				throw new TypeError("Text questions do not support Other");
			}
			return { ...state, otherEditorOpen: open };
		});
	}

	updateText(questionId: string, text: string): QuestionnaireMutationResult {
		const normalized = normalizeLineEndings(text);
		return this.mutate(questionId, (state) => {
			if (state.kind !== "short-text" && state.kind !== "multiline-text") {
				throw new TypeError("Question kind does not match text answer");
			}
			return { ...state, value: normalized };
		});
	}

	responses(): QuestionnaireResponse[] {
		this.assertActive();
		return this.requestValue.questions.map((question, index) =>
			this.responseFor(question, this.value.states[index]!),
		);
	}

	isEmpty(): boolean {
		return this.responses().every(
			(response) => response.status === "unanswered" && !("note" in response && response.note),
		);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.requestValue = { version: 1, questions: [] };
		this.value = { version: 1, currentStep: { kind: "review" }, states: [] };
		this.currentStepBytes.clear();
		this.maximumCurrentStepBytes = 0;
		this.reservedEnvelopeBytes = 0;
		this.lastValidationMessage = undefined;
	}

	private setStep(step: ExtensionQuestionnaireDraftStep): QuestionnaireMutationResult {
		this.assertActive();
		return this.acceptCandidate({ ...this.value, currentStep: step });
	}

	private mutate(
		questionId: string,
		update: (state: ExtensionQuestionnaireDraftQuestionState) => ExtensionQuestionnaireDraftQuestionState,
	): QuestionnaireMutationResult {
		this.assertActive();
		const index = this.value.states.findIndex((state) => state.questionId === questionId);
		if (index < 0) throw new TypeError(`Unknown questionnaire question ${JSON.stringify(questionId)}`);
		const states = this.value.states.map(cloneState);
		states[index] = update(states[index]!);
		return this.acceptCandidate({ ...this.value, states });
	}

	private acceptCandidate(candidate: QuestionnaireDraft): QuestionnaireMutationResult {
		try {
			const accepted = this.normalizeWithReservedStepBudget(candidate);
			this.value = accepted.draft;
			this.reservedEnvelopeBytes = accepted.bytes;
			this.lastValidationMessage = undefined;
			return this.success();
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			const concise = detail.replace(/^Invalid questionnaire [^:]+:\s*/u, "");
			this.lastValidationMessage = /envelope|512 KiB|aggregate questionnaire draft/iu.test(detail)
				? `${concise}. ${this.remainingBytes.toLocaleString()} aggregate bytes remain.`
				: /128 KiB/iu.test(detail)
					? "Edit rejected: 128 KiB limit"
					: `Edit rejected: ${concise}`;
			return { accepted: false, remainingBytes: this.remainingBytes, message: this.lastValidationMessage };
		}
	}

	private normalizeWithReservedStepBudget(draft: QuestionnaireDraft): {
		draft: QuestionnaireDraft;
		bytes: number;
	} {
		let normalized: QuestionnaireDraft;
		if (this.requestValue.version === 2) {
			if (draft.version !== 2)
				throw new TypeError("Invalid questionnaire draft.version: must match request version");
			normalized = normalizeExtensionQuestionnaireDraftV2(this.requestValue, draft);
		} else {
			if (draft.version !== 1)
				throw new TypeError("Invalid questionnaire draft.version: must match request version");
			normalized = normalizeExtensionQuestionnaireDraftForValidatedRequest(this.requestValue, draft);
		}
		const currentStepBytes = this.currentStepBytes.get(draftStepKey(normalized.currentStep));
		if (currentStepBytes === undefined) {
			throw new TypeError("Invalid questionnaire draft currentStep: does not belong to this request");
		}
		const candidateBytes = canonicalQuestionnaireJsonBytes(normalized).byteLength;
		const bytes = candidateBytes + this.maximumCurrentStepBytes - currentStepBytes;
		if (bytes > QUESTIONNAIRE_ENVELOPE_MAX_BYTES) {
			throw new TypeError(
				`Invalid questionnaire aggregate draft: worst-case navigation envelope exceeds the 512 KiB canonical UTF-8 budget (${bytes} bytes)`,
			);
		}
		return { draft: normalized, bytes };
	}

	private success(): QuestionnaireMutationResult {
		return { accepted: true, remainingBytes: this.remainingBytes };
	}

	private cloneDraft(draft: QuestionnaireDraft): QuestionnaireDraft {
		return { version: draft.version, currentStep: { ...draft.currentStep }, states: draft.states.map(cloneState) };
	}

	private assertActive(): void {
		if (this.disposed) throw new Error("Questionnaire draft model has been disposed");
	}

	private responseFor(question: QuestionnaireQuestion, state: QuestionnaireState): QuestionnaireResponse {
		const response = this.answerResponseFor(question, state);
		return "note" in state && state.note !== undefined ? { ...response, note: state.note } : response;
	}

	private answerResponseFor(
		question: QuestionnaireQuestion,
		state: QuestionnaireState,
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
				if (state.selection === "other" && state.otherText.trim()) {
					return { questionId: question.id, status: "answered", kind: "confirm", otherText: state.otherText };
				}
				return { questionId: question.id, status: "unanswered" };
			case "single-select":
				if (state.selection?.kind === "choice") {
					return {
						questionId: question.id,
						status: "answered",
						kind: "single-select",
						choiceId: state.selection.choiceId,
					};
				}
				if (state.selection?.kind === "other" && state.otherText.trim()) {
					return {
						questionId: question.id,
						status: "answered",
						kind: "single-select",
						otherText: state.otherText,
					};
				}
				return { questionId: question.id, status: "unanswered" };
			case "multi-select": {
				const otherText = state.otherSelected && state.otherText.trim() ? state.otherText : undefined;
				if (state.choiceIds.length === 0 && otherText === undefined) {
					return { questionId: question.id, status: "unanswered" };
				}
				return {
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
}

export interface QuestionnaireComponentOptions {
	tui: TUI;
	keybindings: KeybindingsManager;
	request: QuestionnaireRequest;
	initialDraft?: QuestionnaireDraft;
	onDraftChange?: (draft: QuestionnaireDraft) => void;
	getRows: () => number;
	requestRender: () => void;
	onSubmit: (
		outcome: Extract<ExtensionQuestionnaireOutcome | ExtensionQuestionnaireOutcomeV2, { status: "submitted" }>,
	) => void;
	onDismiss: () => void;
}

/** Responsive focus-capturing questionnaire surface. */
export class QuestionnaireComponent implements Component, Focusable {
	readonly model: QuestionnaireDraftModel;
	private readonly shortInputs = new Map<string, Input>();
	private readonly multilineEditors = new Map<string, Editor>();
	private readonly otherInputs = new Map<string, Input>();
	private readonly noteEditors = new Map<string, Editor>();
	private readonly choiceCursors = new Map<string, number>();
	private noteEditorQuestionId: string | undefined;
	private readonly expandedPreviews = new Set<string>();
	private reviewQuestionIndex = 0;
	private reviewAction: "edit" | "submit" = "edit";
	private discardConfirmation = false;
	private discardSelection: "keep" | "discard" = "keep";
	private manualScrollOffset: number | undefined;
	private lastScrollStart = 0;
	private lastScrollContentRows = 1;
	private scrollingAvailable = false;
	private widePreviewVisible = false;
	private _focused = false;
	private disposed = false;

	constructor(private options: QuestionnaireComponentOptions) {
		this.model = new QuestionnaireDraftModel(options.request, options.initialDraft);
		for (const question of this.model.request.questions) {
			if (question.kind === "short-text") {
				const input = new Input();
				input.setValue(this.model.getText(question.id), { cursor: "end" });
				this.shortInputs.set(question.id, input);
			} else if (question.kind === "multiline-text") {
				const editor = new Editor(options.tui, getEditorTheme(), { paddingX: 0 });
				editor.disableSubmit = true;
				editor.setText(this.model.getText(question.id));
				this.multilineEditors.set(question.id, editor);
			}
			if ("other" in question && question.other !== undefined) {
				const input = new Input();
				this.otherInputs.set(question.id, input);
			}
			if (this.model.request.version === 2) {
				const note = new Editor(options.tui, getEditorTheme(), { paddingX: 0 });
				note.disableSubmit = true;
				note.setText(this.model.getNote(question.id));
				this.noteEditors.set(question.id, note);
			}
			this.choiceCursors.set(question.id, 0);
		}
		this.syncControlsFromDraft();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.syncChildFocus();
	}

	/**
	 * Apply an authoritative checkpoint. Protocol callers must catch validation errors and invoke this outside TUI input dispatch.
	 */
	applyDraft(draft: QuestionnaireDraft): void {
		if (this.disposed) throw new Error("Questionnaire component has been disposed");
		this.model.applyDraft(draft);
		this.syncControlsFromDraft();
		this.manualScrollOffset = undefined;
		this.syncChildFocus();
		this.renderRequested();
	}

	get isOtherEditorOpen(): boolean {
		const current = this.currentQuestion();
		if (!current) return false;
		const state = this.model.getState(current.id);
		return "otherEditorOpen" in state && state.otherEditorOpen;
	}

	get isNoteEditorOpen(): boolean {
		return this.noteEditorQuestionId !== undefined;
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		const kb = this.options.keybindings;
		if (this.isNoteEditorOpen) {
			this.handleNoteInput(data);
			return;
		}
		if (this.discardConfirmation) {
			this.handleDiscardInput(data);
			return;
		}
		if (this.isOtherEditorOpen) {
			this.handleOtherInput(data);
			return;
		}
		const currentQuestion = this.currentQuestion();
		const textEditorOwnsInput = currentQuestion?.kind === "short-text" || currentQuestion?.kind === "multiline-text";
		if (
			currentQuestion &&
			this.model.request.version === 2 &&
			((!textEditorOwnsInput && kb.matches(data, "app.questionnaire.notes")) ||
				(textEditorOwnsInput && kb.matches(data, "app.questionnaire.focusNotes")))
		) {
			this.openNoteEditor(currentQuestion.id);
			return;
		}
		if (!textEditorOwnsInput && kb.matches(data, "app.questionnaire.togglePreview")) {
			this.toggleActivePreview();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			if (this.model.isEmpty()) this.options.onDismiss();
			else {
				this.discardConfirmation = true;
				this.discardSelection = "keep";
				this.manualScrollOffset = undefined;
				this.syncChildFocus();
			}
			this.renderRequested();
			return;
		}
		if (this.model.currentStep.kind === "review") {
			this.handleReviewInput(data);
			return;
		}
		const question = this.currentQuestion();
		if (!question) return;
		const textEditorOwnsHorizontalArrow =
			(question.kind === "short-text" || question.kind === "multiline-text") &&
			(kb.matches(data, "tui.editor.cursorLeft") || kb.matches(data, "tui.editor.cursorRight"));
		if (!textEditorOwnsHorizontalArrow && kb.matches(data, "app.questionnaire.next")) {
			this.pageChanged(this.model.next());
			return;
		}
		if (!textEditorOwnsHorizontalArrow && kb.matches(data, "app.questionnaire.previous")) {
			this.pageChanged(this.model.previous());
			return;
		}
		if (kb.matches(data, "tui.select.pageUp")) {
			this.scrollPage(-1);
			return;
		}
		if (kb.matches(data, "tui.select.pageDown")) {
			this.scrollPage(1);
			return;
		}
		if (question.kind === "short-text") {
			if (kb.matches(data, "tui.select.confirm")) {
				this.pageChanged(this.model.next());
				return;
			}
			this.updateShortText(question, data);
			return;
		}
		if (question.kind === "multiline-text") {
			this.updateMultilineText(question, data);
			return;
		}
		this.handleChoiceInput(question, data);
	}

	render(width: number): string[] {
		if (this.disposed) return [];
		const safeWidth = Math.max(1, Math.floor(width));
		const innerWidth = Math.max(1, safeWidth - PANEL_PADDING_X * 2);
		const maxRows = this.viewportRows();
		const widePreviewCandidate =
			!this.discardConfirmation &&
			this.model.currentStep.kind !== "review" &&
			safeWidth >= PREVIEW_LAYOUT_MIN_WIDTH &&
			this.currentQuestionHasAnyPreview();
		this.scrollingAvailable = true;
		this.widePreviewVisible = widePreviewCandidate;
		const previewFooterRows = this.renderFooter(innerWidth, "full").length;
		this.scrollingAvailable = false;
		const previewUsableRows = Math.max(0, maxRows - this.renderHeader(innerWidth).length - previewFooterRows - 2);
		this.widePreviewVisible = widePreviewCandidate && previewUsableRows >= PREVIEW_LAYOUT_MIN_BODY_ROWS;
		const body: RenderedBody = this.discardConfirmation
			? this.renderDiscardConfirmation(innerWidth)
			: this.model.currentStep.kind === "review"
				? this.renderReview(innerWidth)
				: this.renderQuestion(innerWidth, this.widePreviewVisible);
		let footer = this.renderFooter(innerWidth, "full");
		let header = this.renderHeader(innerWidth);
		const maximumSeparators = () => Number(header.length > 0) + Number(footer.length > 0);
		const availableBodyRows = () => maxRows - header.length - footer.length - maximumSeparators();
		if (body.lines.length > Math.max(0, availableBodyRows())) {
			this.scrollingAvailable = true;
			footer = this.renderFooter(innerWidth, "full");
		}
		if (availableBodyRows() < MIN_USEFUL_BODY_ROWS) footer = this.renderFooter(innerWidth, "compact");
		if (availableBodyRows() < MIN_USEFUL_BODY_ROWS) header = this.renderCompactHeader(innerWidth);
		if (availableBodyRows() < MIN_USEFUL_BODY_ROWS) footer = this.renderFooter(innerWidth, "essential");
		if (availableBodyRows() < MIN_USEFUL_BODY_ROWS) header = [];

		footer = footer.slice(0, maxRows);
		if (footer.length === maxRows) return this.finishRenderLines(footer, safeWidth);
		if (header.length + footer.length > maxRows) header = [];
		let remainingRows = maxRows - header.length - footer.length;
		const headerSeparatorRows = header.length > 0 && remainingRows >= 2 ? 1 : 0;
		remainingRows -= headerSeparatorRows;
		const footerSeparatorRows = footer.length > 0 && remainingRows >= 2 ? 1 : 0;
		const bodyCapacity = Math.max(0, remainingRows - footerSeparatorRows);
		let visibleBody = bodyCapacity > 0 ? this.sliceBody(body.lines, bodyCapacity, body.anchor) : [];
		if (body.previewLines && body.previewWidth !== undefined && body.decisionWidth !== undefined) {
			visibleBody = this.composeWidePreview(
				visibleBody,
				body.previewLines,
				body.decisionWidth,
				body.previewWidth,
				bodyCapacity,
			);
		}
		const lines = [
			...header,
			...(headerSeparatorRows > 0 && visibleBody.length > 0 ? [""] : []),
			...visibleBody,
			...(footerSeparatorRows > 0 && visibleBody.length > 0 ? [""] : []),
			...footer,
		];
		return this.finishRenderLines(lines.slice(0, maxRows), safeWidth);
	}

	invalidate(): void {
		for (const input of this.shortInputs.values()) input.invalidate();
		for (const editor of this.multilineEditors.values()) editor.invalidate();
		for (const input of this.otherInputs.values()) input.invalidate();
		for (const editor of this.noteEditors.values()) editor.invalidate();
	}

	dispose(): void {
		if (this.disposed) return;
		this._focused = false;
		this.syncChildFocus();
		for (const input of this.shortInputs.values()) input.setValue("", { cursor: "start" });
		for (const editor of this.multilineEditors.values()) editor.setText("");
		for (const input of this.otherInputs.values()) input.setValue("", { cursor: "start" });
		for (const editor of this.noteEditors.values()) editor.setText("");
		this.shortInputs.clear();
		this.multilineEditors.clear();
		this.otherInputs.clear();
		this.noteEditors.clear();
		this.expandedPreviews.clear();
		this.noteEditorQuestionId = undefined;
		this.choiceCursors.clear();
		this.model.dispose();
		this.options = {
			...this.options,
			request: { version: 1, questions: [] },
			initialDraft: undefined,
			onDraftChange: undefined,
			onSubmit: () => {},
			onDismiss: () => {},
		};
		this.disposed = true;
	}

	private currentQuestion(): QuestionnaireQuestion | undefined {
		const index = this.model.currentQuestionIndex;
		return index === undefined ? undefined : this.model.request.questions[index];
	}

	private handleChoiceInput(question: QuestionnaireQuestion, data: string): void {
		const kb = this.options.keybindings;
		const count = this.choiceCount(question);
		let cursor = this.choiceCursors.get(question.id) ?? 0;
		if (kb.matches(data, "tui.select.up")) {
			cursor = cursor === 0 ? count - 1 : cursor - 1;
			this.choiceCursors.set(question.id, cursor);
			this.manualScrollOffset = undefined;
		} else if (kb.matches(data, "tui.select.down")) {
			cursor = cursor === count - 1 ? 0 : cursor + 1;
			this.choiceCursors.set(question.id, cursor);
			this.manualScrollOffset = undefined;
		} else if (kb.matches(data, "tui.select.pageUp")) {
			this.scrollPage(-1);
		} else if (kb.matches(data, "tui.select.pageDown")) {
			this.scrollPage(1);
		} else if (
			(question.kind === "multi-select" && kb.matches(data, "app.questionnaire.toggle")) ||
			kb.matches(data, "tui.select.confirm")
		) {
			this.activateChoice(question, cursor);
		}
		this.renderRequested();
	}

	private activateChoice(question: QuestionnaireQuestion, cursor: number): void {
		switch (question.kind) {
			case "confirm":
				if (cursor === 0) this.recordLocalMutation(this.model.answerConfirm(question.id, "yes"));
				else if (cursor === 1) this.recordLocalMutation(this.model.answerConfirm(question.id, "no"));
				else this.openOther(question.id);
				break;
			case "single-select": {
				const choice = question.choices[cursor];
				if (choice)
					this.recordLocalMutation(this.model.answerSingle(question.id, { kind: "choice", choiceId: choice.id }));
				else this.openOther(question.id);
				break;
			}
			case "multi-select": {
				const choice = question.choices[cursor];
				if (choice) {
					this.recordLocalMutation(this.model.toggleMultiChoice(question.id, choice.id));
				} else {
					const state = this.model.getState(question.id);
					if (state.kind === "multi-select" && state.otherSelected)
						this.recordLocalMutation(this.model.setMultiOtherSelected(question.id, false));
					else this.openOther(question.id);
				}
				break;
			}
			case "short-text":
			case "multiline-text":
				break;
		}
	}

	private openOther(questionId: string): void {
		this.recordLocalMutation(this.model.setOther(questionId, this.model.getOtherText(questionId)));
		this.recordLocalMutation(this.model.setOtherEditorOpen(questionId, true));
		const input = this.otherInputs.get(questionId);
		input?.setValue(this.model.getOtherText(questionId), { cursor: "end" });
		this.manualScrollOffset = undefined;
		this.syncChildFocus();
	}

	private handleOtherInput(data: string): void {
		const question = this.currentQuestion();
		if (!question) return;
		const input = this.otherInputs.get(question.id);
		if (!input) return;
		const kb = this.options.keybindings;
		if (this.model.request.version === 2 && kb.matches(data, "app.questionnaire.focusNotes")) {
			this.recordLocalMutation(this.model.setOtherEditorOpen(question.id, false));
			this.openNoteEditor(question.id);
			return;
		}
		if (kb.matches(data, "tui.select.pageUp")) {
			this.scrollPage(-1);
			return;
		}
		if (kb.matches(data, "tui.select.pageDown")) {
			this.scrollPage(1);
			return;
		}
		if (kb.matches(data, "tui.select.cancel") || kb.matches(data, "tui.select.confirm")) {
			this.recordLocalMutation(this.model.setOtherEditorOpen(question.id, false));
			this.syncChildFocus();
			this.renderRequested();
			return;
		}
		const previous = input.getValue();
		input.handleInput(data);
		const result = this.model.setOther(question.id, input.getValue());
		if (!result.accepted) input.setValue(previous, { cursor: "end" });
		else this.recordLocalMutation(result);
		this.renderRequested();
	}

	private openNoteEditor(questionId: string): void {
		const editor = this.noteEditors.get(questionId);
		if (!editor) return;
		this.noteEditorQuestionId = questionId;
		editor.setText(this.model.getNote(questionId));
		this.manualScrollOffset = undefined;
		this.syncChildFocus();
		this.renderRequested();
	}

	private handleNoteInput(data: string): void {
		const questionId = this.noteEditorQuestionId;
		if (!questionId) return;
		const editor = this.noteEditors.get(questionId)!;
		const kb = this.options.keybindings;
		if (kb.matches(data, "tui.select.cancel")) {
			this.noteEditorQuestionId = undefined;
			this.syncChildFocus();
			this.renderRequested();
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			this.noteEditorQuestionId = undefined;
			this.pageChanged(this.model.next());
			return;
		}
		const previous = this.model.getNote(questionId);
		editor.handleInput(data);
		const result = this.model.updateNote(questionId, editor.getExpandedText());
		if (!result.accepted) editor.setText(previous);
		else this.recordLocalMutation(result);
		this.renderRequested();
	}

	private toggleActivePreview(): void {
		if (this.model.request.version !== 2 || this.widePreviewVisible) return;
		const question = this.currentQuestion();
		if (!question || (question.kind !== "single-select" && question.kind !== "multi-select")) return;
		const choice = question.choices[this.choiceCursors.get(question.id) ?? 0];
		if (!choice || !("preview" in choice) || !this.isQuestionnairePreview(choice.preview)) return;
		const key = `${question.id}:${choice.id}`;
		if (this.expandedPreviews.has(key)) this.expandedPreviews.delete(key);
		else this.expandedPreviews.add(key);
		this.manualScrollOffset = undefined;
		this.renderRequested();
	}

	private updateShortText(
		question: Extract<ExtensionQuestionnaireQuestion, { kind: "short-text" }>,
		data: string,
	): void {
		const input = this.shortInputs.get(question.id)!;
		const previous = input.getValue();
		input.handleInput(data);
		const result = this.model.updateText(question.id, input.getValue());
		if (!result.accepted) input.setValue(previous, { cursor: "end" });
		else this.recordLocalMutation(result);
		this.renderRequested();
	}

	private updateMultilineText(
		question: Extract<ExtensionQuestionnaireQuestion, { kind: "multiline-text" }>,
		data: string,
	): void {
		const editor = this.multilineEditors.get(question.id)!;
		const previous = this.model.getText(question.id);
		editor.handleInput(data);
		const result = this.model.updateText(question.id, editor.getExpandedText());
		if (!result.accepted) editor.setText(previous);
		else this.recordLocalMutation(result);
		this.renderRequested();
	}

	private handleReviewInput(data: string): void {
		const kb = this.options.keybindings;
		if (kb.matches(data, "app.questionnaire.next")) {
			this.reviewAction = "submit";
		} else if (kb.matches(data, "app.questionnaire.previous")) {
			this.reviewAction = "edit";
		} else if (kb.matches(data, "tui.select.up")) {
			this.reviewQuestionIndex =
				(this.reviewQuestionIndex - 1 + this.model.request.questions.length) % this.model.request.questions.length;
			this.manualScrollOffset = undefined;
		} else if (kb.matches(data, "tui.select.down")) {
			this.reviewQuestionIndex = (this.reviewQuestionIndex + 1) % this.model.request.questions.length;
			this.manualScrollOffset = undefined;
		} else if (kb.matches(data, "tui.select.pageUp")) {
			this.scrollPage(-1);
		} else if (kb.matches(data, "tui.select.pageDown")) {
			this.scrollPage(1);
		} else if (kb.matches(data, "tui.select.confirm")) {
			if (this.reviewAction === "submit") {
				this.options.onSubmit({ status: "submitted", responses: this.model.responses() });
			} else {
				this.pageChanged(this.model.goToQuestion(this.model.request.questions[this.reviewQuestionIndex]!.id));
				return;
			}
		}
		this.renderRequested();
	}

	private handleDiscardInput(data: string): void {
		const kb = this.options.keybindings;
		if (kb.matches(data, "tui.select.cancel")) {
			this.discardConfirmation = false;
		} else if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
			this.discardSelection = this.discardSelection === "keep" ? "discard" : "keep";
			this.manualScrollOffset = undefined;
		} else if (kb.matches(data, "tui.select.confirm")) {
			if (this.discardSelection === "discard") this.options.onDismiss();
			else this.discardConfirmation = false;
		}
		this.syncChildFocus();
		this.renderRequested();
	}

	private renderHeader(width: number): string[] {
		const title = theme.bold(theme.fg("text", this.model.request.title ?? "Questionnaire"));
		return [truncateToWidth(title, width, "…"), this.renderProgressRail(width)];
	}

	private renderProgressRail(width: number): string {
		const count = this.model.request.questions.length;
		const review = this.model.currentStep.kind === "review";
		if (width < WIDE_LAYOUT_MIN_WIDTH - PANEL_PADDING_X * 2) {
			if (review) return truncateToWidth(theme.bold(theme.fg("accent", "Review / Submit")), width, "…");
			const index = this.model.currentQuestionIndex ?? 0;
			const label = this.model.request.questions[index]?.label ?? `Q${index + 1}`;
			const position = `Question ${index + 1} of ${count}`;
			const text = width <= visibleWidth(position) + 2 ? position : `${position} · ${label}`;
			return truncateToWidth(theme.fg("muted", text), width, "…");
		}

		const responses = this.model.responses();
		const center = review ? this.reviewQuestionIndex : (this.model.currentQuestionIndex ?? 0);
		const questionToken = (index: number): string => {
			const current = !review && index === center;
			const answered = responses[index]?.status === "answered";
			const marker = current ? "▶" : answered ? "✓" : "·";
			const text = `[${marker} ${index + 1}]`;
			if (current) return theme.bold(theme.fg("accent", text));
			if (answered) return theme.fg("success", text);
			return theme.fg("dim", text);
		};
		const reviewToken = review ? theme.bold(theme.fg("accent", "[▶ Review]")) : theme.fg("dim", "[  Review]");
		for (let windowSize = Math.min(PROGRESS_WINDOW_MAX_QUESTIONS, count); windowSize >= 1; windowSize--) {
			let start = Math.max(0, center - Math.floor(windowSize / 2));
			const end = Math.min(count, start + windowSize);
			start = Math.max(0, end - windowSize);
			const tokens: string[] = [];
			if (start > 0) tokens.push(theme.fg("dim", `… ${start} more`));
			for (let index = start; index < end; index++) tokens.push(questionToken(index));
			if (end < count) tokens.push(theme.fg("dim", `… ${count - end} more`));
			tokens.push(reviewToken);
			const rail = tokens.join("  ");
			if (visibleWidth(rail) <= width) return rail;
		}
		const essentialRail = review ? reviewToken : `${questionToken(center)}  ${reviewToken}`;
		return truncateToWidth(essentialRail, width, "…");
	}

	private renderCompactHeader(width: number): string[] {
		if (this.model.currentStep.kind === "review")
			return wrapTextWithAnsi(theme.bold("Review / Submit"), width).slice(0, 1);
		const index = this.model.currentQuestionIndex ?? 0;
		const question = this.model.request.questions[index]!;
		const text = `Question ${index + 1} of ${this.model.request.questions.length} · ${question.label ?? `Q${index + 1}`}`;
		return [truncateToWidth(theme.fg("muted", text), width, "…")];
	}

	private currentQuestionHasAnyPreview(): boolean {
		const question = this.currentQuestion();
		return (
			this.model.request.version === 2 &&
			(question?.kind === "single-select" || question?.kind === "multi-select") &&
			question.choices.some((choice) => "preview" in choice && this.isQuestionnairePreview(choice.preview))
		);
	}

	private renderQuestion(width: number, widePreview: boolean): RenderedBody {
		const question = this.currentQuestion()!;
		const contentWidth = widePreview ? DECISION_CONTENT_WIDTH : width;
		const lines =
			question.label && this.viewportRows() >= ACTIVE_LABEL_MIN_ROWS
				? [
						...wrapTextWithAnsi(theme.bold(theme.fg("text", question.label)), contentWidth),
						...wrapTextWithAnsi(theme.fg("text", question.prompt), contentWidth),
						"",
					]
				: [...wrapTextWithAnsi(theme.bold(theme.fg("text", question.prompt)), contentWidth), ""];
		if ("context" in question && question.context) {
			lines.push(theme.bold(theme.fg("muted", "Why I’m asking")));
			lines.push(...this.renderRestrictedMarkdown(question.context, contentWidth), "");
		}
		if ("recommendation" in question && question.recommendation) {
			lines.push(theme.bold(theme.fg("accent", "Recommendation · Recommended")));
			lines.push(...this.renderRestrictedMarkdown(question.recommendation.rationale, contentWidth), "");
		}
		let anchor = lines.length;
		if (question.kind === "short-text") {
			if (this.model.request.version === 2) lines.push(theme.fg("muted", "Your answer"));
			if (!this.model.getText(question.id) && question.placeholder) {
				lines.push(...wrapTextWithAnsi(theme.fg("dim", question.placeholder), contentWidth));
			}
			anchor = lines.length;
			lines.push(...this.shortInputs.get(question.id)!.render(contentWidth));
		} else if (question.kind === "multiline-text") {
			if (this.model.request.version === 2) lines.push(theme.fg("muted", "Your answer"));
			if (!this.model.getText(question.id) && question.placeholder) {
				lines.push(...wrapTextWithAnsi(theme.fg("dim", question.placeholder), contentWidth));
			}
			const editorLines = this.multilineEditors.get(question.id)!.render(contentWidth);
			const cursorRow = editorLines.findIndex((line) => line.includes(CURSOR_MARKER));
			anchor = lines.length + Math.max(0, cursorRow);
			lines.push(...editorLines);
		} else {
			const rendered = this.renderChoices(question, contentWidth, !widePreview);
			anchor += rendered.anchor;
			lines.push(...rendered.lines);
		}
		if (this.model.request.version === 2) {
			lines.push("", theme.bold(theme.fg("muted", "Notes")));
			const note = this.model.getNote(question.id);
			if (this.noteEditorQuestionId === question.id) {
				lines.push(theme.fg("accent", "Editing note"), ...this.noteEditors.get(question.id)!.render(contentWidth));
				anchor = Math.max(anchor, lines.length - 1);
			} else {
				lines.push(
					...wrapTextWithAnsi(
						note || `Press ${this.keyText("app.questionnaire.notes")} to add a note`,
						contentWidth,
					),
				);
			}
		}
		if (!widePreview) return { lines, anchor };
		const previewWidth = Math.max(PREVIEW_MIN_WIDTH, width - DECISION_CONTENT_WIDTH - PREVIEW_GUTTER_WIDTH);
		const previewContentWidth = Math.max(1, previewWidth - 1);
		const preview = this.activePreview(question);
		const previewLines = preview
			? this.renderPreview(preview, previewContentWidth, false)
			: this.renderUnavailablePreview(question, previewContentWidth);
		return { lines, anchor, previewLines, previewWidth, decisionWidth: DECISION_CONTENT_WIDTH };
	}

	private composeWidePreview(
		decisionLines: string[],
		previewLines: string[],
		decisionWidth: number,
		previewWidth: number,
		capacity: number,
	): string[] {
		const rowCount = Math.min(capacity, Math.max(decisionLines.length, previewLines.length));
		const visiblePreview = previewLines.slice(0, rowCount);
		if (previewLines.length > rowCount && visiblePreview.length > 0) {
			visiblePreview[visiblePreview.length - 1] = theme.fg("muted", "… preview continues");
		}
		const background = theme.getPopupBackgroundColor();
		return Array.from({ length: rowCount }, (_, index) => {
			const line = decisionLines[index] ?? "";
			const left = visibleWidth(line) === decisionWidth ? line : truncateToWidth(line, decisionWidth, "…", true);
			const preview = truncateToWidth(visiblePreview[index] ?? "", Math.max(1, previewWidth - 1), "…", true);
			return `${left}${theme.fg("dim", " │")}${background(` ${preview}`)}`;
		});
	}

	private renderChoices(
		question: Exclude<ExtensionQuestionnaireQuestion, { kind: "short-text" | "multiline-text" }>,
		width: number,
		inlinePreview: boolean,
	): { lines: string[]; anchor: number } {
		const state = this.model.getState(question.id);
		const cursor = this.choiceCursors.get(question.id) ?? 0;
		const otherText = this.model.getOtherText(question.id);
		const otherLabel = (selected: boolean): string =>
			selected && otherText.trim().length > 0 ? otherText : question.other?.label || "Something else…";
		const rows: Array<{
			label: string;
			description?: string;
			detail?: string;
			preview?: ExtensionQuestionnairePreview;
			recommended?: boolean;
			checked: boolean;
		}> = [];
		if (question.kind === "confirm" && state.kind === "confirm") {
			rows.push(
				{ label: question.yesLabel ?? "Yes", checked: state.selection === "yes" },
				{ label: question.noLabel ?? "No", checked: state.selection === "no" },
			);
			if (question.other)
				rows.push({ label: otherLabel(state.selection === "other"), checked: state.selection === "other" });
		} else if (question.kind === "single-select" && state.kind === "single-select") {
			for (const choice of question.choices) {
				rows.push({
					label: choice.label,
					description: choice.description,
					...("detail" in choice && typeof choice.detail === "string" && choice.detail
						? { detail: choice.detail }
						: {}),
					...("preview" in choice && this.isQuestionnairePreview(choice.preview)
						? { preview: choice.preview }
						: {}),
					recommended: this.recommendationChoiceId(question) === choice.id,
					checked: state.selection?.kind === "choice" && state.selection.choiceId === choice.id,
				});
			}
			if (question.other)
				rows.push({
					label: otherLabel(state.selection?.kind === "other"),
					checked: state.selection?.kind === "other",
				});
		} else if (question.kind === "multi-select" && state.kind === "multi-select") {
			for (const choice of question.choices) {
				rows.push({
					label: choice.label,
					description: choice.description,
					...("detail" in choice && typeof choice.detail === "string" && choice.detail
						? { detail: choice.detail }
						: {}),
					...("preview" in choice && this.isQuestionnairePreview(choice.preview)
						? { preview: choice.preview }
						: {}),
					recommended: this.recommendationChoiceId(question) === choice.id,
					checked: state.choiceIds.includes(choice.id),
				});
			}
			if (question.other) rows.push({ label: otherLabel(state.otherSelected), checked: state.otherSelected });
		}
		const lines: string[] = [];
		let anchor = 0;
		for (const [index, row] of rows.entries()) {
			if (index === cursor) anchor = lines.length;
			const selected = index === cursor;
			const glyph = question.kind === "multi-select" ? (row.checked ? "☑" : "☐") : row.checked ? "●" : "○";
			lines.push(...this.renderChoiceRow(row.label, glyph, selected, row.checked, Boolean(row.recommended), width));
			if (row.description) lines.push(...this.wrapWithPrefix(row.description, "      ", width, "muted"));
			if (row.detail)
				lines.push(
					...this.renderRestrictedMarkdown(row.detail, Math.max(1, width - 6)).map((line) => `      ${line}`),
				);
			if (inlinePreview && selected && row.preview) {
				const key = `${question.id}:${"choices" in question ? (question.choices[index]?.id ?? "") : ""}`;
				const expanded = this.expandedPreviews.has(key);
				lines.push(
					theme.fg(
						"muted",
						`      Preview available · ${this.keyText("app.questionnaire.togglePreview")} ${expanded ? "collapse" : "expand"}`,
					),
				);
				if (!expanded) {
					lines.push(
						...wrapTextWithAnsi(theme.fg("muted", `      Diagram description: ${row.preview.alt}`), width),
					);
				}
				if (expanded)
					lines.push(
						...this.renderPreview(row.preview, Math.max(1, width - 6), true).map((line) => `      ${line}`),
					);
			}
		}
		if (this.isOtherEditorOpen) {
			const otherInput = this.otherInputs.get(question.id)!;
			lines.push("");
			if (!otherInput.getValue() && question.other?.placeholder) {
				lines.push(...wrapTextWithAnsi(theme.fg("dim", question.other.placeholder), width));
			}
			lines.push(...otherInput.render(width));
			anchor = Math.max(0, lines.length - 1);
		}
		return { lines, anchor };
	}

	private renderChoiceRow(
		label: string,
		glyph: string,
		focused: boolean,
		checked: boolean,
		recommended: boolean,
		width: number,
	): string[] {
		const marker = focused ? theme.bold(theme.fg("accent", "▶")) : " ";
		const styledGlyph = theme.fg(checked ? "success" : "dim", glyph);
		const badge = recommended ? theme.bold(theme.fg("accent", " [Recommended]")) : "";
		const labelWidth = Math.max(1, width - 4);
		const labelLines = wrapTextWithAnsi(`${theme.fg("text", label)}${badge}`, labelWidth);
		const selection = focused ? theme.getSelectionBackgroundColor() : undefined;
		return labelLines.map((labelLine, index) => {
			const prefix = index === 0 ? `${marker} ${styledGlyph} ` : "    ";
			const line = truncateToWidth(`${prefix}${labelLine}`, width, "…", focused);
			return selection ? selection(line) : line;
		});
	}

	private recommendationChoiceId(question: QuestionnaireQuestion): string | undefined {
		if (!("recommendation" in question) || typeof question.recommendation !== "object" || !question.recommendation)
			return undefined;
		return "choiceId" in question.recommendation && typeof question.recommendation.choiceId === "string"
			? question.recommendation.choiceId
			: undefined;
	}

	private isQuestionnairePreview(value: unknown): value is ExtensionQuestionnairePreview {
		return (
			typeof value === "object" &&
			value !== null &&
			"markdown" in value &&
			typeof value.markdown === "string" &&
			"alt" in value &&
			typeof value.alt === "string"
		);
	}

	private activePreview(question: QuestionnaireQuestion): ExtensionQuestionnairePreview | undefined {
		if (question.kind !== "single-select" && question.kind !== "multi-select") return undefined;
		const choice = question.choices[this.choiceCursors.get(question.id) ?? 0];
		return choice && "preview" in choice && this.isQuestionnairePreview(choice.preview) ? choice.preview : undefined;
	}

	private renderUnavailablePreview(question: QuestionnaireQuestion, width: number): string[] {
		const label = this.activeChoiceLabel(question);
		return [
			theme.bold(theme.fg("muted", "Preview")),
			...wrapTextWithAnsi(theme.fg("muted", `No visual preview for “${label}”.`), width),
			...wrapTextWithAnsi(
				theme.fg("muted", "See its option description and tradeoffs in the decision pane."),
				width,
			),
		];
	}

	private activeChoiceLabel(question: QuestionnaireQuestion): string {
		if (question.kind !== "single-select" && question.kind !== "multi-select") return "active choice";
		const cursor = this.choiceCursors.get(question.id) ?? 0;
		const choice = question.choices[cursor];
		if (choice) return choice.label;
		const state = this.model.getState(question.id);
		const otherText = "otherText" in state ? state.otherText.trim() : "";
		return otherText || question.other?.label || "Something else…";
	}

	private renderRestrictedMarkdown(markdown: string, width: number): string[] {
		const sanitized = markdown
			.replace(/!\[([^\]]*)\]\([^)]*\)/gu, "[image omitted: $1]")
			.replace(/\[([^\]]+)\]\(\s*(?:javascript|data|file):[^)]*\)/giu, "$1 [unsupported link]")
			.replace(/<(?=\/?[A-Za-z][^>]*>)/gu, "&lt;")
			.replace(/\t/gu, "   ")
			.split("\n")
			.map((line) => (/^\s*\|.*\|\s*$/u.test(line) ? line.replace(/\|/gu, "\\|") : line))
			.join("\n");
		const lines: string[] = [];
		let markdownBuffer: string[] = [];
		let inFence = false;
		const flushMarkdown = () => {
			if (markdownBuffer.length === 0) return;
			lines.push(...new Markdown(markdownBuffer.join("\n"), 0, 0, getMarkdownTheme()).render(Math.max(1, width)));
			markdownBuffer = [];
		};
		for (const line of sanitized.split("\n")) {
			if (/^\s*```/u.test(line)) {
				flushMarkdown();
				inFence = !inFence;
				continue;
			}
			if (inFence) lines.push(...this.renderClippedCodeLine(line, width));
			else markdownBuffer.push(line);
		}
		flushMarkdown();
		return lines;
	}

	private renderClippedCodeLine(rawLine: string, width: number): string[] {
		if (visibleWidth(rawLine) <= width) return [theme.fg("mdCodeBlock", rawLine)];
		const marker = "[horizontal content clipped]";
		const markerWithGap = ` ${marker}`;
		const available = Math.max(0, width - visibleWidth(markerWithGap));
		let prefix = "";
		for (const character of rawLine) {
			if (visibleWidth(prefix + character) > (available > 0 ? available : width)) break;
			prefix += character;
		}
		if (available > 0) return [theme.fg("mdCodeBlock", `${prefix}${markerWithGap}`)];
		return [theme.fg("mdCodeBlock", prefix), ...wrapTextWithAnsi(theme.fg("muted", marker), width)];
	}

	private renderPreview(preview: ExtensionQuestionnairePreview, width: number, constrained: boolean): string[] {
		const title = preview.title ? `Preview · ${preview.title}` : "Preview";
		const lines = [theme.bold(theme.fg("muted", title))];
		let markdownBuffer: string[] = [];
		let inFence = false;
		let clipped = false;
		const flushMarkdown = () => {
			if (markdownBuffer.length === 0) return;
			lines.push(...this.renderRestrictedMarkdown(markdownBuffer.join("\n"), width));
			markdownBuffer = [];
		};
		for (const rawLine of preview.markdown.replace(/\t/gu, "   ").split("\n")) {
			if (/^\s*```/u.test(rawLine)) {
				flushMarkdown();
				inFence = !inFence;
				continue;
			}
			if (!inFence) {
				markdownBuffer.push(rawLine);
				continue;
			}
			if (visibleWidth(rawLine) > width) clipped = true;
			lines.push(...this.renderClippedCodeLine(rawLine, width));
		}
		flushMarkdown();
		if (clipped || constrained) {
			lines.push(...wrapTextWithAnsi(theme.fg("muted", `Diagram description: ${preview.alt}`), width));
		}
		return lines;
	}

	private renderReview(width: number): { lines: string[]; anchor: number } {
		const responses = this.model.responses();
		const lines: string[] = [];
		let anchor = 0;
		for (const [index, question] of this.model.request.questions.entries()) {
			if (index === this.reviewQuestionIndex) anchor = lines.length;
			const marker = this.reviewAction === "edit" && index === this.reviewQuestionIndex ? "▶ " : "  ";
			lines.push(
				...this.wrapWithPrefix(
					question.label ?? `Q${index + 1}`,
					marker,
					width,
					index === this.reviewQuestionIndex ? "accent" : "text",
				),
			);
			const response = responses[index]!;
			if (response.status === "unanswered") {
				lines.push(...this.wrapWithPrefix("⚠ Unanswered", "    ", width, "warning"));
			} else {
				lines.push(...this.wrapWithPrefix(this.responseSummary(question, response), "    ", width, "muted"));
			}
			const note = "note" in responses[index]! ? responses[index]!.note : undefined;
			if (note) {
				const preview =
					note.length <= REVIEW_PREVIEW_MAX_CHARS
						? note
						: `${note.slice(0, REVIEW_PREVIEW_MAX_CHARS)}… Edit to view full`;
				lines.push(...this.wrapWithPrefix(`Note: ${preview}`, "    ", width, "muted"));
			}
			lines.push("");
		}
		const editLabel =
			this.model.request.questions[this.reviewQuestionIndex]?.label ?? `Q${this.reviewQuestionIndex + 1}`;
		lines.push(
			...wrapTextWithAnsi(
				`${this.reviewAction === "edit" ? "▶" : " "} [ Edit ${editLabel} ]   ${this.reviewAction === "submit" ? "▶" : " "} [ ${this.model.request.submitLabel ?? "Submit"} ]`,
				width,
			),
		);
		if (this.reviewAction === "submit") anchor = lines.length - 1;
		return { lines, anchor };
	}

	private renderDiscardConfirmation(width: number): { lines: string[]; anchor: number } {
		const lines = [
			...wrapTextWithAnsi(theme.bold(theme.fg("warning", "Discard questionnaire draft?")), width),
			...wrapTextWithAnsi(theme.fg("muted", "Partial answers will not be returned."), width),
			"",
			`${this.discardSelection === "keep" ? "▶" : " "} Keep editing`,
			`${this.discardSelection === "discard" ? "▶" : " "} Discard`,
		];
		return { lines, anchor: this.discardSelection === "keep" ? lines.length - 2 : lines.length - 1 };
	}

	private renderFooter(width: number, mode: "full" | "compact" | "essential"): string[] {
		const lines: string[] = [];
		const message = this.model.validationMessage;
		if (message) {
			const errorLines = wrapTextWithAnsi(theme.fg("error", message), width);
			const maximumErrorLines = 2;
			lines.push(...errorLines.slice(0, maximumErrorLines));
			if (mode !== "essential" && errorLines.length > maximumErrorLines) {
				lines.push(theme.fg("error", "… validation message continues"));
			}
		}
		if (mode !== "essential") {
			const next = this.keyText("app.questionnaire.next");
			const previous = this.keyText("app.questionnaire.previous");
			const cancel = this.keyText("tui.select.cancel");
			const confirm = this.keyText("tui.select.confirm");
			const chips: string[] = [];
			const currentQuestion = this.currentQuestion();
			if (this.discardConfirmation) {
				chips.push(`${confirm} choose`, `${cancel} keep editing`);
			} else if (this.isNoteEditorOpen) {
				chips.push(`${confirm} save & next`, `${cancel} close note`);
			} else if (this.isOtherEditorOpen) {
				chips.push(`${confirm} accept Other`, `${cancel} choices`);
			} else if (this.model.currentStep.kind === "review") {
				chips.push(`${confirm} choose`, `${previous}/${next} Edit/Submit`);
				if (mode === "full")
					chips.push(`${this.keyText("tui.select.up")}/${this.keyText("tui.select.down")} answer`);
				chips.push(`${cancel} dismiss`);
			} else if (currentQuestion) {
				if (currentQuestion.kind === "multi-select") {
					chips.push(`${this.keyText("app.questionnaire.toggle")}/${confirm} toggle`);
				} else if (currentQuestion.kind === "multiline-text") {
					chips.push(`${this.keyText("tui.input.newLine")} newline`);
				} else {
					chips.push(`${confirm} ${currentQuestion.kind === "short-text" ? "next" : "select"}`);
				}
				chips.push(`${previous}/${next} page`, `${cancel} dismiss`);
				if (mode === "full" && currentQuestion.kind !== "short-text" && currentQuestion.kind !== "multiline-text") {
					chips.unshift(`${this.keyText("tui.select.up")}/${this.keyText("tui.select.down")} move`);
				}
				if (this.model.request.version === 2) {
					chips.push(`${this.keyText("app.questionnaire.notes")} note`);
					if (!this.widePreviewVisible && this.activePreview(currentQuestion)) {
						chips.push(`${this.keyText("app.questionnaire.togglePreview")} preview`);
					}
				}
			}
			if (this.scrollingAvailable) {
				chips.push(`${this.keyText("tui.select.pageUp")}/${this.keyText("tui.select.pageDown")} scroll`);
			}
			if (chips.length > 0) lines.push(...wrapTextWithAnsi(theme.fg("muted", chips.join(" · ")), width));
		}
		lines.push(
			...wrapTextWithAnsi(
				theme.fg("dim", `${this.model.remainingBytes.toLocaleString()} aggregate bytes remaining`),
				width,
			),
		);
		return lines;
	}

	private responseSummary(question: QuestionnaireQuestion, response: ExtensionQuestionnaireResponse): string {
		const full = this.fullResponseSummary(question, response);
		if (full.length <= REVIEW_PREVIEW_MAX_CHARS) return full;
		return `${full.slice(0, REVIEW_PREVIEW_MAX_CHARS)}… Edit to view full`;
	}

	private fullResponseSummary(question: QuestionnaireQuestion, response: ExtensionQuestionnaireResponse): string {
		if (response.status === "unanswered") return "Unanswered";
		switch (response.kind) {
			case "confirm":
				return "value" in response
					? response.value
						? question.kind === "confirm"
							? (question.yesLabel ?? "Yes")
							: "Yes"
						: question.kind === "confirm"
							? (question.noLabel ?? "No")
							: "No"
					: response.otherText;
			case "single-select":
				return "choiceId" in response
					? ((question.kind === "single-select"
							? question.choices.find((choice) => choice.id === response.choiceId)?.label
							: undefined) ?? response.choiceId)
					: response.otherText;
			case "multi-select": {
				const labels = response.choiceIds.map((choiceId) =>
					question.kind === "multi-select"
						? (question.choices.find((choice) => choice.id === choiceId)?.label ?? choiceId)
						: choiceId,
				);
				if (response.otherText !== undefined) labels.push(response.otherText);
				return labels.join(", ");
			}
			case "short-text":
			case "multiline-text":
				return response.value;
		}
	}

	private choiceCount(question: QuestionnaireQuestion): number {
		switch (question.kind) {
			case "confirm":
				return 2 + (question.other ? 1 : 0);
			case "single-select":
			case "multi-select":
				return question.choices.length + (question.other ? 1 : 0);
			case "short-text":
			case "multiline-text":
				return 0;
		}
	}

	private pageChanged(result: QuestionnaireMutationResult): void {
		if (result.accepted) {
			this.manualScrollOffset = undefined;
			this.options.onDraftChange?.(this.model.draft);
		}
		this.syncChildFocus();
		this.renderRequested();
	}

	private recordLocalMutation(result: QuestionnaireMutationResult): void {
		if (!result.accepted) return;
		this.manualScrollOffset = undefined;
		this.options.onDraftChange?.(this.model.draft);
	}

	private scrollPage(direction: -1 | 1): void {
		const stride = Math.max(1, this.lastScrollContentRows - 1);
		this.manualScrollOffset = Math.max(
			0,
			direction < 0 ? this.lastScrollStart - stride : this.lastScrollStart + stride,
		);
		this.renderRequested();
	}

	private sliceBody(lines: string[], capacity: number, anchor: number): string[] {
		if (lines.length <= capacity) {
			this.lastScrollStart = 0;
			this.lastScrollContentRows = Math.max(1, lines.length);
			return lines;
		}
		const automaticStart = Math.max(0, anchor - Math.floor(Math.max(1, capacity - 2) / 2));
		const window = getMenuScrollWindow({
			totalRows: lines.length,
			availableRows: capacity,
			desiredStart: this.manualScrollOffset ?? automaticStart,
		});
		this.lastScrollStart = window.start;
		this.lastScrollContentRows = Math.max(1, window.contentRows);
		return [
			...(window.showAboveIndicator ? [theme.fg("muted", `↑ ${window.rowsAbove} more`)] : []),
			...lines.slice(window.start, window.start + window.contentRows),
			...(window.showBelowIndicator ? [theme.fg("muted", `↓ ${window.rowsBelow} more`)] : []),
		];
	}

	private syncControlsFromDraft(): void {
		for (const question of this.model.request.questions) {
			const state = this.model.getState(question.id);
			switch (state.kind) {
				case "short-text":
					this.shortInputs.get(question.id)?.setValue(state.value, { cursor: "end" });
					break;
				case "multiline-text":
					this.multilineEditors.get(question.id)?.setText(state.value);
					break;
				case "confirm":
					this.otherInputs.get(question.id)?.setValue(state.otherText, { cursor: "end" });
					this.choiceCursors.set(
						question.id,
						state.selection === "yes" ? 0 : state.selection === "no" ? 1 : state.selection === "other" ? 2 : 0,
					);
					break;
				case "single-select": {
					this.otherInputs.get(question.id)?.setValue(state.otherText, { cursor: "end" });
					const selection = state.selection;
					this.choiceCursors.set(
						question.id,
						selection?.kind === "choice" && question.kind === "single-select"
							? Math.max(
									0,
									question.choices.findIndex((choice) => choice.id === selection.choiceId),
								)
							: selection?.kind === "other" && question.kind === "single-select"
								? question.choices.length
								: 0,
					);
					break;
				}
				case "multi-select":
					this.otherInputs.get(question.id)?.setValue(state.otherText, { cursor: "end" });
					break;
			}
			this.noteEditors.get(question.id)?.setText("note" in state ? (state.note ?? "") : "");
		}
		const current = this.model.currentQuestionIndex;
		if (current !== undefined) this.reviewQuestionIndex = current;
	}

	private syncChildFocus(): void {
		for (const input of this.shortInputs.values()) input.focused = false;
		for (const editor of this.multilineEditors.values()) editor.focused = false;
		for (const input of this.otherInputs.values()) input.focused = false;
		for (const editor of this.noteEditors.values()) editor.focused = false;
		if (!this._focused || this.disposed || this.discardConfirmation) return;
		if (this.noteEditorQuestionId) {
			this.noteEditors.get(this.noteEditorQuestionId)!.focused = true;
			return;
		}
		const question = this.currentQuestion();
		if (!question) return;
		if (this.isOtherEditorOpen) this.otherInputs.get(question.id)!.focused = true;
		else if (question.kind === "short-text") this.shortInputs.get(question.id)!.focused = true;
		else if (question.kind === "multiline-text") this.multilineEditors.get(question.id)!.focused = true;
	}

	private renderRequested(): void {
		this.options.requestRender();
	}

	private viewportRows(): number {
		const rows = this.options.getRows();
		return Number.isFinite(rows) && rows > 0 ? Math.max(1, Math.floor(rows)) : 24;
	}

	private wrapWithPrefix(
		text: string,
		prefix: string,
		width: number,
		color: "accent" | "text" | "muted" | "warning",
	): string[] {
		const prefixWidth = visibleWidth(prefix);
		const contentWidth = Math.max(1, width - prefixWidth);
		return wrapTextWithAnsi(theme.fg(color, text), contentWidth).map(
			(line, index) => `${index === 0 ? prefix : " ".repeat(prefixWidth)}${line}`,
		);
	}

	private keyText(keybinding: Keybinding): string {
		const key = this.options.keybindings.getKeys(keybinding)[0];
		return key === undefined ? "" : formatKeyText(key);
	}

	private finishRenderLines(lines: string[], width: number): string[] {
		const rendered = lines.map((line) => this.padLine(line, width));
		return process.env.NO_COLOR === undefined ? rendered : rendered.map((line) => stripAnsi(line));
	}

	private padLine(line: string, width: number): string {
		const padding = Math.min(PANEL_PADDING_X, Math.max(0, Math.floor((width - 1) / 2)));
		const contentWidth = Math.max(1, width - padding * 2);
		const clipped = visibleWidth(line) <= contentWidth ? line : (wrapTextWithAnsi(line, contentWidth)[0] ?? "");
		const right = " ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)));
		return `${" ".repeat(padding)}${clipped}${right}${" ".repeat(padding)}`;
	}
}

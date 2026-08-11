import {
	type Component,
	CURSOR_MARKER,
	Editor,
	type Focusable,
	Input,
	type Keybinding,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	canonicalQuestionnaireJsonBytes,
	normalizeExtensionQuestionnaireDraftForValidatedRequest,
	normalizeExtensionQuestionnaireRequest,
	QUESTIONNAIRE_ENVELOPE_MAX_BYTES,
} from "../../../core/extensions/questionnaire.js";
import type {
	ExtensionQuestionnaireDraftQuestionState,
	ExtensionQuestionnaireDraftStep,
	ExtensionQuestionnaireDraftV1,
	ExtensionQuestionnaireOutcome,
	ExtensionQuestionnaireQuestion,
	ExtensionQuestionnaireRequestV1,
	ExtensionQuestionnaireResponse,
} from "../../../core/extensions/types.js";
import type { KeybindingsManager } from "../../../core/keybindings.js";
import { getEditorTheme, theme } from "../theme/theme.js";
import { formatKeyText } from "./keybinding-hints.js";
import { getMenuScrollWindow } from "./menu-panel.js";

const WIDE_LAYOUT_MIN_WIDTH = 64;
const PANEL_PADDING_X = 2;
const MIN_USEFUL_BODY_ROWS = 3;
const REVIEW_PREVIEW_MAX_CHARS = 512;

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

function cloneState(state: ExtensionQuestionnaireDraftQuestionState): ExtensionQuestionnaireDraftQuestionState {
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

function stateForQuestion(question: ExtensionQuestionnaireQuestion): ExtensionQuestionnaireDraftQuestionState {
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
	private requestValue: ExtensionQuestionnaireRequestV1;
	private value: ExtensionQuestionnaireDraftV1;
	private readonly currentStepBytes: Map<string, number>;
	private maximumCurrentStepBytes: number;
	private reservedEnvelopeBytes = 0;
	private lastValidationMessage: string | undefined;
	private disposed = false;

	constructor(request: ExtensionQuestionnaireRequestV1, initialDraft?: ExtensionQuestionnaireDraftV1) {
		this.requestValue = normalizeExtensionQuestionnaireRequest(request);
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
				version: 1,
				currentStep: { kind: "question", questionId: this.requestValue.questions[0]!.id },
				states: this.requestValue.questions.map(stateForQuestion),
			} satisfies ExtensionQuestionnaireDraftV1);
		const accepted = this.normalizeWithReservedStepBudget(draft);
		this.value = accepted.draft;
		this.reservedEnvelopeBytes = accepted.bytes;
	}

	get request(): ExtensionQuestionnaireRequestV1 {
		this.assertActive();
		return this.requestValue;
	}

	get draft(): ExtensionQuestionnaireDraftV1 {
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

	getState(questionId: string): ExtensionQuestionnaireDraftQuestionState {
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

	/**
	 * Apply an authoritative checkpoint. Protocol callers must catch validation errors and invoke this outside TUI input dispatch.
	 */
	applyDraft(draft: ExtensionQuestionnaireDraftV1): void {
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

	responses(): ExtensionQuestionnaireResponse[] {
		this.assertActive();
		return this.requestValue.questions.map((question, index) =>
			this.responseFor(question, this.value.states[index]!),
		);
	}

	isEmpty(): boolean {
		return this.responses().every((response) => response.status === "unanswered");
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

	private acceptCandidate(candidate: ExtensionQuestionnaireDraftV1): QuestionnaireMutationResult {
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

	private normalizeWithReservedStepBudget(draft: ExtensionQuestionnaireDraftV1): {
		draft: ExtensionQuestionnaireDraftV1;
		bytes: number;
	} {
		const normalized = normalizeExtensionQuestionnaireDraftForValidatedRequest(this.requestValue, draft);
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

	private cloneDraft(draft: ExtensionQuestionnaireDraftV1): ExtensionQuestionnaireDraftV1 {
		return { version: 1, currentStep: { ...draft.currentStep }, states: draft.states.map(cloneState) };
	}

	private assertActive(): void {
		if (this.disposed) throw new Error("Questionnaire draft model has been disposed");
	}

	private responseFor(
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
	request: ExtensionQuestionnaireRequestV1;
	initialDraft?: ExtensionQuestionnaireDraftV1;
	onDraftChange?: (draft: ExtensionQuestionnaireDraftV1) => void;
	getRows: () => number;
	requestRender: () => void;
	onSubmit: (outcome: Extract<ExtensionQuestionnaireOutcome, { status: "submitted" }>) => void;
	onDismiss: () => void;
}

/** Responsive focus-capturing questionnaire surface. */
export class QuestionnaireComponent implements Component, Focusable {
	readonly model: QuestionnaireDraftModel;
	private readonly shortInputs = new Map<string, Input>();
	private readonly multilineEditors = new Map<string, Editor>();
	private readonly otherInputs = new Map<string, Input>();
	private readonly choiceCursors = new Map<string, number>();
	private reviewQuestionIndex = 0;
	private reviewAction: "edit" | "submit" = "edit";
	private discardConfirmation = false;
	private discardSelection: "keep" | "discard" = "keep";
	private manualScrollOffset: number | undefined;
	private lastScrollStart = 0;
	private lastScrollContentRows = 1;
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
	applyDraft(draft: ExtensionQuestionnaireDraftV1): void {
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

	handleInput(data: string): void {
		if (this.disposed) return;
		const kb = this.options.keybindings;
		if (this.discardConfirmation) {
			this.handleDiscardInput(data);
			return;
		}
		if (this.isOtherEditorOpen) {
			this.handleOtherInput(data);
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
		const body = this.discardConfirmation
			? this.renderDiscardConfirmation(innerWidth)
			: this.model.currentStep.kind === "review"
				? this.renderReview(innerWidth)
				: this.renderQuestion(innerWidth);

		let footer = this.renderFooter(innerWidth, "full");
		let header = this.renderHeader(innerWidth);
		const maximumSeparators = () => Number(header.length > 0) + Number(footer.length > 0);
		const availableBodyRows = () => maxRows - header.length - footer.length - maximumSeparators();
		if (availableBodyRows() < MIN_USEFUL_BODY_ROWS) footer = this.renderFooter(innerWidth, "compact");
		if (availableBodyRows() < MIN_USEFUL_BODY_ROWS) header = this.renderCompactHeader(innerWidth);
		if (availableBodyRows() < MIN_USEFUL_BODY_ROWS) footer = this.renderFooter(innerWidth, "essential");
		if (availableBodyRows() < MIN_USEFUL_BODY_ROWS) header = [];

		footer = footer.slice(0, maxRows);
		if (footer.length === maxRows) return footer.map((line) => this.padLine(line, safeWidth));
		if (header.length + footer.length > maxRows) header = [];
		let remainingRows = maxRows - header.length - footer.length;
		const headerSeparatorRows = header.length > 0 && remainingRows >= 2 ? 1 : 0;
		remainingRows -= headerSeparatorRows;
		const footerSeparatorRows = footer.length > 0 && remainingRows >= 2 ? 1 : 0;
		const bodyCapacity = Math.max(0, remainingRows - footerSeparatorRows);
		const visibleBody = bodyCapacity > 0 ? this.sliceBody(body.lines, bodyCapacity, body.anchor) : [];
		const lines = [
			...header,
			...(headerSeparatorRows > 0 && visibleBody.length > 0 ? [""] : []),
			...visibleBody,
			...(footerSeparatorRows > 0 && visibleBody.length > 0 ? [""] : []),
			...footer,
		];
		return lines.slice(0, maxRows).map((line) => this.padLine(line, safeWidth));
	}

	invalidate(): void {
		for (const input of this.shortInputs.values()) input.invalidate();
		for (const editor of this.multilineEditors.values()) editor.invalidate();
		for (const input of this.otherInputs.values()) input.invalidate();
	}

	dispose(): void {
		if (this.disposed) return;
		this._focused = false;
		this.syncChildFocus();
		for (const input of this.shortInputs.values()) input.setValue("", { cursor: "start" });
		for (const editor of this.multilineEditors.values()) editor.setText("");
		for (const input of this.otherInputs.values()) input.setValue("", { cursor: "start" });
		this.shortInputs.clear();
		this.multilineEditors.clear();
		this.otherInputs.clear();
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

	private currentQuestion(): ExtensionQuestionnaireQuestion | undefined {
		const index = this.model.currentQuestionIndex;
		return index === undefined ? undefined : this.model.request.questions[index];
	}

	private handleChoiceInput(question: ExtensionQuestionnaireQuestion, data: string): void {
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
		} else if (question.kind === "multi-select" && kb.matches(data, "app.questionnaire.toggle")) {
			this.activateChoice(question, cursor);
		} else if (question.kind !== "multi-select" && kb.matches(data, "tui.select.confirm")) {
			this.activateChoice(question, cursor);
		}
		this.renderRequested();
	}

	private activateChoice(question: ExtensionQuestionnaireQuestion, cursor: number): void {
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
		const lines = [theme.bold(theme.fg("text", this.model.request.title ?? "Questionnaire"))];
		if (this.model.currentStep.kind === "review") {
			if (width >= WIDE_LAYOUT_MIN_WIDTH) {
				const responses = this.model.responses();
				const tabs = this.model.request.questions.map((question, index) => {
					const indicator = responses[index]?.status === "answered" ? "✓" : " ";
					return `[${indicator} ${question.label ?? `Q${index + 1}`}]`;
				});
				tabs.push("[▶ Review / Submit]");
				lines.push(...this.wrapItems(tabs, "  ", width));
			} else {
				lines.push(theme.bold(theme.fg("accent", "Review / Submit")));
			}
			return lines.flatMap((line) => wrapTextWithAnsi(line, width));
		}
		const index = this.model.currentQuestionIndex ?? 0;
		if (width >= WIDE_LAYOUT_MIN_WIDTH) {
			const responses = this.model.responses();
			const tabs = this.model.request.questions.map((question, tabIndex) => {
				const indicator = tabIndex === index ? "▶" : responses[tabIndex]?.status === "answered" ? "✓" : " ";
				return `[${indicator} ${question.label ?? `Q${tabIndex + 1}`}]`;
			});
			tabs.push("[  Review / Submit]");
			lines.push(...this.wrapItems(tabs, "  ", width));
		} else {
			const question = this.model.request.questions[index]!;
			lines.push(
				theme.fg(
					"muted",
					`Question ${index + 1} of ${this.model.request.questions.length}: ${question.label ?? `Q${index + 1}`}`,
				),
			);
		}
		return lines.flatMap((line) => wrapTextWithAnsi(line, width));
	}

	private renderCompactHeader(width: number): string[] {
		if (this.model.currentStep.kind === "review")
			return wrapTextWithAnsi(theme.bold("Review / Submit"), width).slice(0, 1);
		const index = this.model.currentQuestionIndex ?? 0;
		const question = this.model.request.questions[index]!;
		const text = `[${index + 1}/${this.model.request.questions.length}] ${question.label ?? `Q${index + 1}`}`;
		return wrapTextWithAnsi(theme.fg("muted", text), width).slice(0, 1);
	}

	private renderQuestion(width: number): { lines: string[]; anchor: number } {
		const question = this.currentQuestion()!;
		const lines = [...wrapTextWithAnsi(theme.bold(theme.fg("text", question.prompt)), width), ""];
		let anchor = lines.length;
		if (question.kind === "short-text") {
			if (!this.model.getText(question.id) && question.placeholder) {
				lines.push(...wrapTextWithAnsi(theme.fg("dim", question.placeholder), width));
			}
			anchor = lines.length;
			lines.push(...this.shortInputs.get(question.id)!.render(width));
		} else if (question.kind === "multiline-text") {
			if (!this.model.getText(question.id) && question.placeholder) {
				lines.push(...wrapTextWithAnsi(theme.fg("dim", question.placeholder), width));
			}
			const editorLines = this.multilineEditors.get(question.id)!.render(width);
			const cursorRow = editorLines.findIndex((line) => line.includes(CURSOR_MARKER));
			anchor = lines.length + Math.max(0, cursorRow);
			lines.push(...editorLines);
		} else {
			const rendered = this.renderChoices(question, width);
			anchor += rendered.anchor;
			lines.push(...rendered.lines);
		}
		return { lines, anchor };
	}

	private renderChoices(
		question: Exclude<ExtensionQuestionnaireQuestion, { kind: "short-text" | "multiline-text" }>,
		width: number,
	): { lines: string[]; anchor: number } {
		const state = this.model.getState(question.id);
		const cursor = this.choiceCursors.get(question.id) ?? 0;
		const rows: Array<{ label: string; description?: string; checked: boolean }> = [];
		if (question.kind === "confirm" && state.kind === "confirm") {
			rows.push(
				{ label: question.yesLabel ?? "Yes", checked: state.selection === "yes" },
				{ label: question.noLabel ?? "No", checked: state.selection === "no" },
			);
			if (question.other)
				rows.push({ label: question.other.label ?? "Something else…", checked: state.selection === "other" });
		} else if (question.kind === "single-select" && state.kind === "single-select") {
			for (const choice of question.choices) {
				rows.push({
					label: choice.label,
					description: choice.description,
					checked: state.selection?.kind === "choice" && state.selection.choiceId === choice.id,
				});
			}
			if (question.other)
				rows.push({ label: question.other.label ?? "Something else…", checked: state.selection?.kind === "other" });
		} else if (question.kind === "multi-select" && state.kind === "multi-select") {
			for (const choice of question.choices) {
				rows.push({
					label: choice.label,
					description: choice.description,
					checked: state.choiceIds.includes(choice.id),
				});
			}
			if (question.other)
				rows.push({ label: question.other.label ?? "Something else…", checked: state.otherSelected });
		}
		const lines: string[] = [];
		let anchor = 0;
		for (const [index, row] of rows.entries()) {
			if (index === cursor) anchor = lines.length;
			const selected = index === cursor;
			const glyph = question.kind === "multi-select" ? (row.checked ? "☑" : "☐") : row.checked ? "●" : "○";
			const prefix = `${selected ? "▶" : " "} ${glyph} `;
			lines.push(...this.wrapWithPrefix(row.label, prefix, width, selected ? "accent" : "text"));
			if (row.description) lines.push(...this.wrapWithPrefix(row.description, "      ", width, "muted"));
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
			lines.push(
				...this.wrapWithPrefix(this.responseSummary(question, responses[index]!), "    ", width, "muted"),
				"",
			);
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
			const up = this.keyText("tui.select.up");
			const down = this.keyText("tui.select.down");
			const pageUp = this.keyText("tui.select.pageUp");
			const pageDown = this.keyText("tui.select.pageDown");
			let hint: string;
			if (mode === "compact") {
				hint = `${pageUp}/${pageDown} scroll · ${cancel} dismiss`;
			} else {
				const currentQuestion = this.currentQuestion();
				if (this.discardConfirmation) {
					hint = `${confirm} choose · ${cancel} keep editing`;
				} else if (this.isOtherEditorOpen) {
					hint = `${confirm} accept Other · ${cancel} return to choices`;
				} else if (this.model.currentStep.kind === "review") {
					hint = `${previous}/${next} Edit/Submit · ${up}/${down} answer · ${confirm} choose · ${pageUp}/${pageDown} scroll · ${cancel} dismiss`;
				} else if (currentQuestion?.kind === "multi-select") {
					hint = `${up}/${down} move · ${this.keyText("app.questionnaire.toggle")} toggle · ${previous}/${next} previous/next · ${pageUp}/${pageDown} scroll · ${cancel} dismiss`;
				} else if (currentQuestion?.kind === "multiline-text") {
					const newline = this.keyText("tui.input.newLine");
					hint = `${newline} newline · ${previous}/${next} previous/next · ${pageUp}/${pageDown} scroll · ${cancel} dismiss`;
				} else if (currentQuestion?.kind === "short-text") {
					hint = `${confirm}/${next} next · ${previous} previous · ${pageUp}/${pageDown} scroll · ${cancel} dismiss`;
				} else {
					hint = `${up}/${down} move · ${confirm} select · ${previous}/${next} previous/next · ${pageUp}/${pageDown} scroll · ${cancel} dismiss`;
				}
			}
			lines.push(...wrapTextWithAnsi(theme.fg("muted", hint), width));
		}
		lines.push(
			...wrapTextWithAnsi(
				theme.fg("dim", `${this.model.remainingBytes.toLocaleString()} aggregate bytes remaining`),
				width,
			),
		);
		return lines;
	}

	private responseSummary(question: ExtensionQuestionnaireQuestion, response: ExtensionQuestionnaireResponse): string {
		const full = this.fullResponseSummary(question, response);
		if (full.length <= REVIEW_PREVIEW_MAX_CHARS) return full;
		return `${full.slice(0, REVIEW_PREVIEW_MAX_CHARS)}… Edit to view full`;
	}

	private fullResponseSummary(
		question: ExtensionQuestionnaireQuestion,
		response: ExtensionQuestionnaireResponse,
	): string {
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

	private choiceCount(question: ExtensionQuestionnaireQuestion): number {
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
		}
		const current = this.model.currentQuestionIndex;
		if (current !== undefined) this.reviewQuestionIndex = current;
	}

	private syncChildFocus(): void {
		for (const input of this.shortInputs.values()) input.focused = false;
		for (const editor of this.multilineEditors.values()) editor.focused = false;
		for (const input of this.otherInputs.values()) input.focused = false;
		if (!this._focused || this.disposed || this.discardConfirmation) return;
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

	private wrapItems(items: string[], separator: string, width: number): string[] {
		const lines: string[] = [];
		let line = "";
		for (const item of items) {
			const candidate = line ? `${line}${separator}${item}` : item;
			if (line && visibleWidth(candidate) > width) {
				lines.push(...wrapTextWithAnsi(line, width));
				line = item;
			} else line = candidate;
		}
		if (line) lines.push(...wrapTextWithAnsi(line, width));
		return lines;
	}

	private wrapWithPrefix(text: string, prefix: string, width: number, color: "accent" | "text" | "muted"): string[] {
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

	private padLine(line: string, width: number): string {
		const padding = Math.min(PANEL_PADDING_X, Math.max(0, Math.floor((width - 1) / 2)));
		const contentWidth = Math.max(1, width - padding * 2);
		const clipped = visibleWidth(line) <= contentWidth ? line : (wrapTextWithAnsi(line, contentWidth)[0] ?? "");
		const right = " ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)));
		return `${" ".repeat(padding)}${clipped}${right}${" ".repeat(padding)}`;
	}
}

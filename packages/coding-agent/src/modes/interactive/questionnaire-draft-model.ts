import {
	canonicalQuestionnaireJsonBytes,
	normalizeExtensionQuestionnaireDraftForValidatedRequest,
	normalizeExtensionQuestionnaireDraftV2,
	normalizeExtensionQuestionnaireRequest,
	normalizeExtensionQuestionnaireRequestV2,
	QUESTIONNAIRE_ENVELOPE_MAX_BYTES,
} from "../../core/extensions/questionnaire.js";
import type {
	ExtensionQuestionnaireDraftQuestionState,
	ExtensionQuestionnaireDraftQuestionStateV2,
	ExtensionQuestionnaireDraftStep,
	ExtensionQuestionnaireDraftV1,
	ExtensionQuestionnaireDraftV2,
	ExtensionQuestionnaireQuestion,
	ExtensionQuestionnaireQuestionV2,
	ExtensionQuestionnaireRequestV1,
	ExtensionQuestionnaireRequestV2,
	ExtensionQuestionnaireResponse,
	ExtensionQuestionnaireResponseV2,
} from "../../core/extensions/types.js";

export type QuestionnaireQuestion = ExtensionQuestionnaireQuestion | ExtensionQuestionnaireQuestionV2;
export type QuestionnaireRequest = ExtensionQuestionnaireRequestV1 | ExtensionQuestionnaireRequestV2;
export type QuestionnaireDraft = ExtensionQuestionnaireDraftV1 | ExtensionQuestionnaireDraftV2;
export type QuestionnaireState = ExtensionQuestionnaireDraftQuestionState | ExtensionQuestionnaireDraftQuestionStateV2;
export type QuestionnaireResponse = ExtensionQuestionnaireResponse | ExtensionQuestionnaireResponseV2;

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

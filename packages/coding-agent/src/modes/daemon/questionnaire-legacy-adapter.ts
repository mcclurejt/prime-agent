import { QUESTIONNAIRE_TEXT_FIELD_MAX_BYTES } from "../../core/extensions/questionnaire.js";
import type {
	ExtensionQuestionnaireDraftQuestionState,
	ExtensionQuestionnaireDraftV1,
	ExtensionQuestionnaireQuestion,
	ExtensionQuestionnaireRequestV1,
} from "../../core/extensions/types.js";
import type { DaemonExtensionUIResponse } from "./daemon-protocol.js";

export type QuestionnaireLegacyPrimitiveRequest =
	| { method: "select"; payload: { title: string; options: string[] } }
	| { method: "input"; payload: { title: string; placeholder?: string } }
	| { method: "editor"; payload: { title: string; prefill: string } };

export type QuestionnaireLegacyAdapterAction =
	| { status: "request"; request: QuestionnaireLegacyPrimitiveRequest }
	| { status: "submitted" }
	| { status: "indeterminate"; reason: "legacy-cancelled-or-presentation-lost" };

type ConfirmState = Extract<ExtensionQuestionnaireDraftQuestionState, { kind: "confirm" }>;
type SingleState = Extract<ExtensionQuestionnaireDraftQuestionState, { kind: "single-select" }>;
type MultiState = Extract<ExtensionQuestionnaireDraftQuestionState, { kind: "multi-select" }>;

type Phase =
	| { kind: "confirm"; options: Map<string, "yes" | "no" | "other"> }
	| { kind: "single"; options: Map<string, { kind: "choice"; choiceId: string } | { kind: "other" }> }
	| { kind: "confirm-other" }
	| { kind: "single-other" }
	| { kind: "multi"; working: MultiState; options: Map<string, "done" | "other" | { choiceId: string }> }
	| { kind: "multi-other"; working: MultiState }
	| { kind: "short" }
	| { kind: "multiline" }
	| { kind: "review"; submitValue: string; editValue: string };

function clone<T>(value: T): T {
	return structuredClone(value);
}

function numbered(label: string, index: number): string {
	return `${index + 1}. ${label}`;
}

function hasValue(response: DaemonExtensionUIResponse): response is { value: string } {
	return "value" in response;
}

function indeterminate(): QuestionnaireLegacyAdapterAction {
	return { status: "indeterminate", reason: "legacy-cancelled-or-presentation-lost" };
}

const LEGACY_DISALLOWED_CONTROL_PATTERN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;
const LEGACY_BIDIRECTIONAL_CONTROL_PATTERN = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const encoder = new TextEncoder();

function normalizeLegacyValue(value: string): string | undefined {
	const normalized = value.replace(/\r\n?/gu, "\n");
	if (
		LEGACY_DISALLOWED_CONTROL_PATTERN.test(normalized) ||
		LEGACY_BIDIRECTIONAL_CONTROL_PATTERN.test(normalized) ||
		encoder.encode(normalized).byteLength > QUESTIONNAIRE_TEXT_FIELD_MAX_BYTES
	) {
		return undefined;
	}
	return normalized;
}

/** Deterministic typed legacy questionnaire sequence. Only completed question states enter the authoritative draft. */
export class QuestionnaireLegacyAdapter {
	private questionIndex = 0;
	private phase: Phase | undefined;
	private draftValue: ExtensionQuestionnaireDraftV1;

	private requestValue: ExtensionQuestionnaireRequestV1;

	constructor(request: ExtensionQuestionnaireRequestV1, draft: ExtensionQuestionnaireDraftV1) {
		this.requestValue = clone(request);
		this.draftValue = clone(draft);
	}

	get draft(): ExtensionQuestionnaireDraftV1 {
		return clone(this.draftValue);
	}

	start(): QuestionnaireLegacyAdapterAction {
		if (this.phase) return this.requestForPhase();
		return this.beginCurrentStep();
	}

	resetPresentation(): void {
		this.phase = undefined;
	}

	dispose(): void {
		this.phase = undefined;
		this.questionIndex = 0;
		this.requestValue = { version: 1, questions: [] };
		this.draftValue = { version: 1, currentStep: { kind: "review" }, states: [] };
	}

	respond(response: DaemonExtensionUIResponse): QuestionnaireLegacyAdapterAction {
		const phase = this.phase;
		if (!phase || !hasValue(response)) return indeterminate();
		const value = normalizeLegacyValue(response.value);
		if (value === undefined) return this.requestForPhase();
		switch (phase.kind) {
			case "confirm": {
				const selection = phase.options.get(value);
				if (!selection) return indeterminate();
				if (selection === "other") {
					this.phase = { kind: "confirm-other" };
					return this.requestForPhase();
				}
				const state = clone(this.currentState()) as ConfirmState;
				state.selection = selection;
				state.otherEditorOpen = false;
				state.otherText = "";
				return this.commit(state);
			}
			case "confirm-other": {
				const state = clone(this.currentState()) as ConfirmState;
				state.selection = "other";
				state.otherEditorOpen = false;
				state.otherText = value;
				return this.commit(state);
			}
			case "single": {
				const selection = phase.options.get(value);
				if (!selection) return indeterminate();
				if (selection.kind === "other") {
					this.phase = { kind: "single-other" };
					return this.requestForPhase();
				}
				const state = clone(this.currentState()) as SingleState;
				state.selection = selection;
				state.otherEditorOpen = false;
				state.otherText = "";
				return this.commit(state);
			}
			case "single-other": {
				const state = clone(this.currentState()) as SingleState;
				state.selection = { kind: "other" };
				state.otherEditorOpen = false;
				state.otherText = value;
				return this.commit(state);
			}
			case "multi": {
				const selected = phase.options.get(value);
				if (!selected) return indeterminate();
				if (selected === "done") return this.commit(phase.working);
				if (selected === "other") {
					if (phase.working.otherSelected) {
						phase.working.otherSelected = false;
						phase.working.otherText = "";
						return this.requestForPhase();
					}
					this.phase = { kind: "multi-other", working: phase.working };
					return this.requestForPhase();
				}
				const index = phase.working.choiceIds.indexOf(selected.choiceId);
				if (index >= 0) phase.working.choiceIds.splice(index, 1);
				else phase.working.choiceIds.push(selected.choiceId);
				return this.requestForPhase();
			}
			case "multi-other":
				phase.working.otherSelected = true;
				phase.working.otherText = value;
				this.phase = this.multiPhase(phase.working);
				return this.requestForPhase();
			case "short": {
				const state = clone(this.currentState());
				if (state.kind !== "short-text") return indeterminate();
				state.value = value;
				return this.commit(state);
			}
			case "multiline": {
				const state = clone(this.currentState());
				if (state.kind !== "multiline-text") return indeterminate();
				state.value = value;
				return this.commit(state);
			}
			case "review":
				if (value === phase.submitValue) return { status: "submitted" };
				if (value !== phase.editValue) return indeterminate();
				this.questionIndex = 0;
				this.phase = undefined;
				return this.beginCurrentStep();
		}
	}

	private beginCurrentStep(): QuestionnaireLegacyAdapterAction {
		if (this.questionIndex >= this.requestValue.questions.length) {
			const submitValue = this.requestValue.submitLabel ?? "Submit";
			this.phase = { kind: "review", submitValue, editValue: "Edit answers" };
			this.draftValue.currentStep = { kind: "review" };
			return this.requestForPhase();
		}
		const question = this.currentQuestion();
		this.draftValue.currentStep = { kind: "question", questionId: question.id };
		switch (question.kind) {
			case "confirm": {
				const entries: Array<[string, "yes" | "no" | "other"]> = [
					[numbered(question.yesLabel ?? "Yes", 0), "yes"],
					[numbered(question.noLabel ?? "No", 1), "no"],
				];
				if (question.other) entries.push([numbered(question.other.label ?? "Other", 2), "other"]);
				this.phase = { kind: "confirm", options: new Map(entries) };
				break;
			}
			case "single-select": {
				const entries: Array<[string, { kind: "choice"; choiceId: string } | { kind: "other" }]> =
					question.choices.map((choice, index) => [
						numbered(choice.label, index),
						{ kind: "choice", choiceId: choice.id },
					]);
				if (question.other)
					entries.push([numbered(question.other.label ?? "Other", entries.length), { kind: "other" }]);
				this.phase = { kind: "single", options: new Map(entries) };
				break;
			}
			case "multi-select":
				this.phase = this.multiPhase(clone(this.currentState()) as MultiState);
				break;
			case "short-text":
				this.phase = { kind: "short" };
				break;
			case "multiline-text":
				this.phase = { kind: "multiline" };
				break;
		}
		return this.requestForPhase();
	}

	private requestForPhase(): QuestionnaireLegacyAdapterAction {
		const phase = this.phase!;
		const question = this.questionIndex < this.requestValue.questions.length ? this.currentQuestion() : undefined;
		switch (phase.kind) {
			case "confirm":
			case "single":
				return {
					status: "request",
					request: { method: "select", payload: { title: question!.prompt, options: [...phase.options.keys()] } },
				};
			case "confirm-other":
			case "single-other":
				return {
					status: "request",
					request: { method: "input", payload: { title: question!.prompt, ...this.otherPlaceholder(question!) } },
				};
			case "multi":
				return {
					status: "request",
					request: { method: "select", payload: { title: question!.prompt, options: [...phase.options.keys()] } },
				};
			case "multi-other":
				return {
					status: "request",
					request: { method: "input", payload: { title: question!.prompt, ...this.otherPlaceholder(question!) } },
				};
			case "short":
				return {
					status: "request",
					request: {
						method: "input",
						payload: {
							title: question!.prompt,
							...(question?.kind === "short-text" && question.placeholder
								? { placeholder: question.placeholder }
								: {}),
						},
					},
				};
			case "multiline":
				return {
					status: "request",
					request: {
						method: "editor",
						payload: {
							title: question!.prompt,
							prefill: question?.kind === "multiline-text" ? this.currentTextValue() : "",
						},
					},
				};
			case "review":
				return {
					status: "request",
					request: {
						method: "select",
						payload: { title: this.reviewText(), options: [phase.submitValue, phase.editValue] },
					},
				};
		}
	}

	private multiPhase(working: MultiState): Extract<Phase, { kind: "multi" }> {
		const question = this.currentQuestion();
		if (question.kind !== "multi-select") throw new TypeError("Legacy questionnaire state mismatch");
		const entries: Array<[string, "done" | "other" | { choiceId: string }]> = question.choices.map(
			(choice, index) => [
				`${working.choiceIds.includes(choice.id) ? "[x]" : "[ ]"} ${numbered(choice.label, index)}`,
				{ choiceId: choice.id },
			],
		);
		if (question.other)
			entries.push([
				`${working.otherSelected ? "[x]" : "[ ]"} ${numbered(question.other.label ?? "Other", question.choices.length)}`,
				"other",
			]);
		entries.push(["Done", "done"]);
		return { kind: "multi", working, options: new Map(entries) };
	}

	private commit(state: ExtensionQuestionnaireDraftQuestionState): QuestionnaireLegacyAdapterAction {
		this.draftValue.states[this.questionIndex] = clone(state);
		this.questionIndex++;
		this.phase = undefined;
		return this.beginCurrentStep();
	}

	private currentQuestion(): ExtensionQuestionnaireQuestion {
		return this.requestValue.questions[this.questionIndex]!;
	}

	private currentState(): ExtensionQuestionnaireDraftQuestionState {
		return this.draftValue.states[this.questionIndex]!;
	}

	private currentTextValue(): string {
		const state = this.currentState();
		return state.kind === "multiline-text" ? state.value : "";
	}

	private otherPlaceholder(question: ExtensionQuestionnaireQuestion): { placeholder?: string } {
		return "other" in question && question.other?.placeholder ? { placeholder: question.other.placeholder } : {};
	}

	private reviewText(): string {
		const lines = [this.requestValue.title ?? "Questionnaire", "Review answers:"];
		for (let index = 0; index < this.requestValue.questions.length; index++) {
			const question = this.requestValue.questions[index]!;
			const state = this.draftValue.states[index]!;
			lines.push(`${question.label ?? question.prompt}: ${this.summarize(question, state)}`);
		}
		return lines.join("\n");
	}

	private summarize(
		question: ExtensionQuestionnaireQuestion,
		state: ExtensionQuestionnaireDraftQuestionState,
	): string {
		switch (state.kind) {
			case "confirm":
				return state.selection === "other" ? state.otherText : (state.selection ?? "Unanswered");
			case "single-select": {
				if (state.selection?.kind === "other") return state.otherText;
				if (state.selection?.kind !== "choice") return "Unanswered";
				const choiceId = state.selection.choiceId;
				return question.kind === "single-select"
					? (question.choices.find((choice) => choice.id === choiceId)?.label ?? choiceId)
					: choiceId;
			}
			case "multi-select": {
				const labels =
					question.kind === "multi-select"
						? state.choiceIds.map(
								(choiceId) => question.choices.find((choice) => choice.id === choiceId)?.label ?? choiceId,
							)
						: state.choiceIds;
				return (
					[...labels, ...(state.otherSelected && state.otherText ? [state.otherText] : [])].join(", ") ||
					"Unanswered"
				);
			}
			case "short-text":
			case "multiline-text":
				return state.value || "Unanswered";
		}
	}
}

import type { ExtensionQuestionnaireDraftStep } from "../../core/extensions/types.js";
import {
	type QuestionnaireDraft,
	QuestionnaireDraftModel,
	type QuestionnaireMutationResult,
	type QuestionnaireRequest,
	type QuestionnaireResponse,
} from "./questionnaire-draft-model.js";

export type RemoteQuestionnaireDraftComparison =
	| { kind: "rebase"; draft: QuestionnaireDraft }
	| { kind: "conflict"; changedQuestionIds: string[]; completedDraft: QuestionnaireDraft };

export type RemoteQuestionnairePageAction =
	| { action: "next" }
	| { action: "previous" }
	| { action: "review" }
	| { action: "edit"; questionId: string }
	| { action: "answer-confirm"; questionId: string; selection: "yes" | "no" | "other"; text?: string }
	| {
			action: "answer-single";
			questionId: string;
			selection: { kind: "choice"; choiceId: string } | { kind: "other" };
			text?: string;
	  }
	| { action: "toggle-multi"; questionId: string; choiceId: string }
	| { action: "set-multi"; questionId: string; choiceIds: string[]; otherSelected: boolean; otherText: string }
	| { action: "set-other"; questionId: string; text: string }
	| { action: "update-text"; questionId: string; text: string }
	| { action: "update-note"; questionId: string; text: string }
	| { action: "submit" }
	| { action: "reload" };

export interface RemoteQuestionnairePageView {
	title: string | undefined;
	submitLabel: string;
	currentStep: ExtensionQuestionnaireDraftStep;
	questions: QuestionnaireDraftModel["request"]["questions"];
	responses: QuestionnaireResponse[];
	submitted: boolean;
}

/**
 * Renders rich questionnaire copy as text only. Lexing keeps markdown parsing
 * deterministic while escaped raw token text prevents HTML or URL activation.
 */
export function renderSafeQuestionnaireMarkdown(markdown: string): string {
	const source = escapeHtml(markdown)
		.replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1");
	const inline = (value: string) =>
		value
			.replace(/`([^`]+)`/gu, "<code>$1</code>")
			.replace(/\*\*([^*]+)\*\*/gu, "<strong>$1</strong>")
			.replace(/__([^_]+)__/gu, "<strong>$1</strong>")
			.replace(/(?<!\*)\*([^*]+)\*(?!\*)/gu, "<em>$1</em>")
			.replace(/(?<!_)_([^_]+)_(?!_)/gu, "<em>$1</em>");
	const lines = source.split("\n");
	const output: string[] = [];
	let list: "ul" | "ol" | undefined;
	const closeList = () => {
		if (list) output.push(`</${list}>`);
		list = undefined;
	};
	for (const line of lines) {
		const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
		const item = /^(?:[-*+]\s+|\d+[.)]\s+)(.+)$/u.exec(line);
		if (heading) {
			closeList();
			output.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
			continue;
		}
		if (item) {
			const kind = /^\d/u.test(line) ? "ol" : "ul";
			if (list && list !== kind) closeList();
			if (!list) {
				list = kind;
				output.push(`<${kind}>`);
			}
			output.push(`<li>${inline(item[1])}</li>`);
			continue;
		}
		closeList();
		if (line) output.push(`<p>${inline(line).replaceAll("  ", "<br>")}</p>`);
	}
	closeList();
	return output.join("");
}

export function compareRemoteQuestionnaireDrafts(
	baseDraft: QuestionnaireDraft,
	authoritativeDraft: QuestionnaireDraft,
	completedDraft: QuestionnaireDraft,
): RemoteQuestionnaireDraftComparison {
	const changedQuestionIds = baseDraft.states.flatMap((baseState, index) =>
		JSON.stringify(baseState) === JSON.stringify(authoritativeDraft.states[index]) ? [] : [baseState.questionId],
	);
	return changedQuestionIds.length === 0
		? { kind: "rebase", draft: completedDraft }
		: { kind: "conflict", changedQuestionIds, completedDraft };
}

export class RemoteQuestionnairePage {
	readonly model: QuestionnaireDraftModel;
	private submitted = false;

	constructor(request: QuestionnaireRequest, initialDraft?: QuestionnaireDraft) {
		this.model = new QuestionnaireDraftModel(request, initialDraft);
	}

	get draft(): QuestionnaireDraft {
		return this.model.draft;
	}

	view(): RemoteQuestionnairePageView {
		return {
			title: this.model.request.title,
			submitLabel: this.model.request.submitLabel ?? "Submit",
			currentStep: this.model.currentStep,
			questions: this.model.request.questions,
			responses: this.model.responses(),
			submitted: this.submitted,
		};
	}

	next(): QuestionnaireMutationResult {
		return this.model.next();
	}

	previous(): QuestionnaireMutationResult {
		return this.model.previous();
	}

	goToReview(): QuestionnaireMutationResult {
		return this.model.goToReview();
	}

	edit(questionId: string): QuestionnaireMutationResult {
		return this.model.goToQuestion(questionId);
	}

	answerConfirm(questionId: string, selection: "yes" | "no" | "other"): QuestionnaireMutationResult {
		return this.model.answerConfirm(questionId, selection);
	}

	answerSingle(
		questionId: string,
		selection: { kind: "choice"; choiceId: string } | { kind: "other" },
	): QuestionnaireMutationResult {
		return this.model.answerSingle(questionId, selection);
	}

	toggleMultiChoice(questionId: string, choiceId: string): QuestionnaireMutationResult {
		return this.model.toggleMultiChoice(questionId, choiceId);
	}

	setMultiOtherSelected(questionId: string, selected: boolean): QuestionnaireMutationResult {
		return this.model.setMultiOtherSelected(questionId, selected);
	}

	setOther(questionId: string, text: string): QuestionnaireMutationResult {
		return this.model.setOther(questionId, text);
	}

	updateText(questionId: string, text: string): QuestionnaireMutationResult {
		return this.model.updateText(questionId, text);
	}

	updateNote(questionId: string, note: string): QuestionnaireMutationResult {
		return this.model.updateNote(questionId, note);
	}

	apply(
		action: Exclude<RemoteQuestionnairePageAction, { action: "submit" } | { action: "reload" }>,
	): QuestionnaireMutationResult {
		switch (action.action) {
			case "next":
				return this.next();
			case "previous":
				return this.previous();
			case "review":
				return this.goToReview();
			case "edit":
				return this.edit(action.questionId);
			case "answer-confirm": {
				const result = this.answerConfirm(action.questionId, action.selection);
				return action.selection === "other" && action.text !== undefined
					? this.setOther(action.questionId, action.text)
					: result;
			}
			case "answer-single": {
				const result = this.answerSingle(action.questionId, action.selection);
				return action.selection.kind === "other" && action.text !== undefined
					? this.setOther(action.questionId, action.text)
					: result;
			}
			case "toggle-multi":
				return this.toggleMultiChoice(action.questionId, action.choiceId);
			case "set-multi": {
				const state = this.model.getState(action.questionId);
				if (state.kind !== "multi-select") throw new TypeError("Question kind does not match multi-select answer");
				const question = this.model.request.questions.find((candidate) => candidate.id === action.questionId);
				if (
					!question ||
					question.kind !== "multi-select" ||
					action.choiceIds.some((choiceId) => !question.choices.some((choice) => choice.id === choiceId))
				)
					return {
						accepted: false,
						remainingBytes: this.model.remainingBytes,
						message: "Unknown multi-select choice",
					};
				for (const choiceId of state.choiceIds)
					if (!action.choiceIds.includes(choiceId)) this.toggleMultiChoice(action.questionId, choiceId);
				for (const choiceId of action.choiceIds) {
					const current = this.model.getState(action.questionId);
					if (current.kind === "multi-select" && !current.choiceIds.includes(choiceId))
						this.toggleMultiChoice(action.questionId, choiceId);
				}
				const otherSelection = this.setMultiOtherSelected(action.questionId, action.otherSelected);
				return action.otherSelected ? this.setOther(action.questionId, action.otherText) : otherSelection;
			}
			case "set-other":
				return this.setOther(action.questionId, action.text);
			case "update-text":
				return this.updateText(action.questionId, action.text);
			case "update-note":
				return this.updateNote(action.questionId, action.text);
		}
	}

	submit(): QuestionnaireResponse[] {
		if (this.model.currentStep.kind !== "review") {
			throw new Error("Questionnaire submission is only available from Review");
		}
		if (this.submitted) throw new Error("Questionnaire has already been submitted");
		this.submitted = true;
		return this.model.responses();
	}
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

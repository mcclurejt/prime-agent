import { describe, expect, it } from "vitest";
import type { ExtensionQuestionnaireRequestV1 } from "../src/core/extensions/types.js";
import {
	QuestionnaireLegacyAdapter,
	type QuestionnaireLegacyAdapterAction,
} from "../src/modes/daemon/questionnaire-legacy-adapter.js";
import { createInitialQuestionnaireDraft } from "../src/modes/daemon/questionnaire-worker-authority.js";

const request: ExtensionQuestionnaireRequestV1 = {
	version: 1,
	title: "Setup",
	questions: [
		{ id: "confirm", kind: "confirm", prompt: "Continue?", other: { label: "Explain" } },
		{
			id: "single",
			kind: "single-select",
			prompt: "Pick one",
			choices: [
				{ id: "a", label: "Same" },
				{ id: "b", label: "Same" },
			],
		},
		{
			id: "multi",
			kind: "multi-select",
			prompt: "Pick many",
			choices: [
				{ id: "x", label: "X" },
				{ id: "y", label: "Y" },
			],
			other: { label: "Other" },
		},
		{ id: "short", kind: "short-text", prompt: "Short" },
		{ id: "long", kind: "multiline-text", prompt: "Long", initialValue: "seed" },
	],
};

function requestAction(action: QuestionnaireLegacyAdapterAction) {
	expect(action.status).toBe("request");
	if (action.status !== "request") throw new Error("Expected request");
	return action.request;
}

function selectValue(action: QuestionnaireLegacyAdapterAction, includes: string): string {
	const primitive = requestAction(action);
	expect(primitive.method).toBe("select");
	if (primitive.method !== "select") throw new Error("Expected select");
	const options = primitive.payload.options;
	const value = options.find((option) => option.includes(includes));
	if (!value) throw new Error(`Missing option containing ${includes}`);
	return value;
}

describe("QuestionnaireLegacyAdapter", () => {
	it("runs typed confirm, select, multi, text, and review steps", () => {
		const adapter = new QuestionnaireLegacyAdapter(request, createInitialQuestionnaireDraft(request));

		let action = adapter.start();
		action = adapter.respond({ value: selectValue(action, "Yes") });
		const single = requestAction(action);
		if (single.method !== "select") throw new Error("Expected select");
		expect(single.payload.options).toEqual(["1. Same", "2. Same"]);
		action = adapter.respond({ value: "2. Same" });

		action = adapter.respond({ value: selectValue(action, "X") });
		action = adapter.respond({ value: selectValue(action, "Other") });
		expect(requestAction(action)).toMatchObject({ method: "input" });
		action = adapter.respond({ value: "custom" });
		action = adapter.respond({ value: selectValue(action, "Done") });

		expect(requestAction(action)).toMatchObject({ method: "input" });
		action = adapter.respond({ value: "short answer" });
		expect(requestAction(action)).toMatchObject({ method: "editor", payload: { prefill: "seed" } });
		action = adapter.respond({ value: "long answer" });
		expect(requestAction(action)).toMatchObject({ method: "select" });
		action = adapter.respond({ value: selectValue(action, "Submit") });

		expect(action).toMatchObject({ status: "submitted" });
		expect(adapter.draft.states).toMatchObject([
			{ selection: "yes" },
			{ selection: { kind: "choice", choiceId: "b" } },
			{ choiceIds: ["x"], otherSelected: true, otherText: "custom" },
			{ value: "short answer" },
			{ value: "long answer" },
		]);
	});

	it("discards an incomplete multi-select step on lease reset but keeps completed answers", () => {
		const adapter = new QuestionnaireLegacyAdapter(request, createInitialQuestionnaireDraft(request));
		let action = adapter.start();
		action = adapter.respond({ value: selectValue(action, "No") });
		action = adapter.respond({ value: selectValue(action, "1. Same") });
		action = adapter.respond({ value: selectValue(action, "X") });

		adapter.resetPresentation();
		action = adapter.start();
		expect(selectValue(action, "X")).toContain("[ ]");
		expect(adapter.draft.states[0]).toMatchObject({ selection: "no" });
		expect(adapter.draft.states[1]).toMatchObject({ selection: { choiceId: "a" } });
		expect(adapter.draft.states[2]).toMatchObject({ choiceIds: [] });
	});

	it("clears request and draft buffers on disposal", () => {
		const adapter = new QuestionnaireLegacyAdapter(request, createInitialQuestionnaireDraft(request));
		adapter.start();
		adapter.dispose();
		expect(adapter.draft).toEqual({ version: 1, currentStep: { kind: "review" }, states: [] });
		expect(JSON.stringify(adapter)).not.toMatch(/Setup|Continue|Pick many|seed/u);
	});

	it("normalizes every old cancellation shape to conservative indeterminacy", () => {
		for (const response of [{ cancelled: true } as const, { confirmed: false } as const]) {
			const adapter = new QuestionnaireLegacyAdapter(request, createInitialQuestionnaireDraft(request));
			adapter.start();
			expect(adapter.respond(response)).toEqual({
				status: "indeterminate",
				reason: "legacy-cancelled-or-presentation-lost",
			});
		}
	});
});

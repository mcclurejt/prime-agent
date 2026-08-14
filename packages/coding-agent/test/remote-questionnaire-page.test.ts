import { describe, expect, it } from "vitest";
import type {
	ExtensionQuestionnaireDraftV1,
	ExtensionQuestionnaireDraftV2,
	ExtensionQuestionnaireRequestV1,
	ExtensionQuestionnaireRequestV2,
} from "../src/core/extensions/types.js";
import {
	compareRemoteQuestionnaireDrafts,
	RemoteQuestionnairePage,
	renderSafeQuestionnaireMarkdown,
} from "../src/modes/interactive/remote-questionnaire-page.js";

const request: ExtensionQuestionnaireRequestV2 = {
	version: 2,
	title: "Release checklist",
	submitLabel: "Submit decision",
	questions: [
		{
			id: "approve",
			kind: "confirm",
			label: "Approval",
			prompt: "Ship this release?",
			yesLabel: "Ship",
			noLabel: "Hold",
			other: { label: "Different outcome", placeholder: "Explain" },
			context: "Read the [runbook](https://example.com) before deciding.",
			recommendation: { rationale: "The checks passed." },
		},
		{
			id: "regions",
			kind: "multi-select",
			label: "Regions",
			prompt: "Choose regions.",
			choices: [
				{
					id: "us",
					label: "US",
					description: "Primary",
					detail: "Stable",
					preview: { markdown: "**US**", alt: "US preview" },
				},
			],
			other: { label: "Another region" },
		},
		{ id: "notes", kind: "multiline-text", label: "Notes", prompt: "Record a note.", placeholder: "Optional" },
	],
};

const v1Request: ExtensionQuestionnaireRequestV1 = {
	version: 1,
	questions: [
		{ id: "confirm", kind: "confirm", prompt: "Confirm" },
		{ id: "single", kind: "single-select", prompt: "Select", choices: [{ id: "one", label: "One" }] },
		{ id: "multi", kind: "multi-select", prompt: "Many", choices: [{ id: "two", label: "Two" }] },
		{ id: "short", kind: "short-text", prompt: "Short", initialValue: "seed" },
		{ id: "long", kind: "multiline-text", prompt: "Long", initialValue: "seeded body" },
	],
};

describe("RemoteQuestionnairePage", () => {
	it("preserves v1 projection and seeded drafts across all five answer kinds", () => {
		const seeded: ExtensionQuestionnaireDraftV1 = {
			version: 1,
			currentStep: { kind: "question", questionId: "short" },
			states: [
				{ questionId: "confirm", kind: "confirm", selection: "yes", otherEditorOpen: false, otherText: "" },
				{
					questionId: "single",
					kind: "single-select",
					selection: { kind: "choice", choiceId: "one" },
					otherEditorOpen: false,
					otherText: "",
				},
				{
					questionId: "multi",
					kind: "multi-select",
					choiceIds: ["two"],
					otherSelected: false,
					otherEditorOpen: false,
					otherText: "",
				},
				{ questionId: "short", kind: "short-text", value: "seed" },
				{ questionId: "long", kind: "multiline-text", value: "seeded body" },
			],
		};
		const page = new RemoteQuestionnairePage(v1Request, seeded);
		expect(page.draft).toEqual(seeded);
		expect(page.view().questions).toEqual(v1Request.questions);
		page.updateText("short", "updated");
		page.goToReview();
		expect(page.submit()).toEqual([
			{ questionId: "confirm", status: "answered", kind: "confirm", value: true },
			{ questionId: "single", status: "answered", kind: "single-select", choiceId: "one" },
			{ questionId: "multi", status: "answered", kind: "multi-select", choiceIds: ["two"] },
			{ questionId: "short", status: "answered", kind: "short-text", value: "updated" },
			{ questionId: "long", status: "answered", kind: "multiline-text", value: "seeded body" },
		]);
	});

	it("keeps all v2 content, answer kinds, notes, navigation, Review/Edit, and explicit Submit semantic", () => {
		const page = new RemoteQuestionnairePage(request);
		expect(page.view()).toMatchObject({
			title: "Release checklist",
			currentStep: { kind: "question", questionId: "approve" },
		});
		expect(() => page.submit()).toThrow(/Review/);
		page.answerConfirm("approve", "yes");
		page.updateNote("approve", "approved by release manager");
		page.next();
		page.toggleMultiChoice("regions", "us");
		page.setMultiOtherSelected("regions", true);
		page.setOther("regions", "eu");
		page.next();
		page.updateText("notes", "recorded");
		page.goToReview();
		expect(page.submit()).toEqual([
			{
				questionId: "approve",
				status: "answered",
				kind: "confirm",
				value: true,
				note: "approved by release manager",
			},
			{ questionId: "regions", status: "answered", kind: "multi-select", choiceIds: ["us"], otherText: "eu" },
			{ questionId: "notes", status: "answered", kind: "multiline-text", value: "recorded" },
		]);
		expect(page.edit("approve").accepted).toBe(true);
	});

	it("rejects unknown and wrong-kind mutations without turning navigation into submission", () => {
		const page = new RemoteQuestionnairePage(request);
		expect(() => page.answerSingle("approve", { kind: "choice", choiceId: "x" })).toThrow(/kind/);
		expect(() => page.updateText("unknown", "x")).toThrow(/Unknown/);
		page.next();
		expect(page.view().submitted).toBe(false);
	});

	it("preserves a completed phone draft for answer/note conflicts but permits current-step-only rebase", () => {
		const page = new RemoteQuestionnairePage(request);
		const initialDraft = page.draft;
		if (initialDraft.version !== 2) throw new Error("Expected v2 draft");
		const base: ExtensionQuestionnaireDraftV2 = initialDraft;
		page.answerConfirm("approve", "yes");
		const completed = page.draft;
		const stepOnly: ExtensionQuestionnaireDraftV2 = { ...base, currentStep: { kind: "review" } };
		expect(compareRemoteQuestionnaireDrafts(base, stepOnly, completed)).toMatchObject({
			kind: "rebase",
			draft: completed,
		});
		const changed: ExtensionQuestionnaireDraftV2 = structuredClone(stepOnly);
		const changedState = changed.states[0];
		if (!changedState || changedState.kind !== "confirm") throw new Error("Expected confirm state");
		changedState.selection = "no";
		expect(compareRemoteQuestionnaireDrafts(base, changed, completed)).toEqual({
			kind: "conflict",
			changedQuestionIds: ["approve"],
			completedDraft: completed,
		});
	});

	it("renders markdown as escaped text without active raw HTML or unsafe links", () => {
		expect(renderSafeQuestionnaireMarkdown("<script>alert(1)</script> [bad](javascript:alert(1))")).toContain(
			"&lt;script&gt;",
		);
		expect(renderSafeQuestionnaireMarkdown("<script>alert(1)</script> [bad](javascript:alert(1))")).not.toContain(
			"<script>",
		);
	});
});

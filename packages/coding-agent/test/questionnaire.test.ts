import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
	assertQuestionnaireEnvelopeBudget,
	assertQuestionnaireTextFieldBudget,
	canonicalQuestionnaireJsonBytes,
	normalizeExtensionQuestionnaireDraft,
	normalizeExtensionQuestionnaireDraftV2,
	normalizeExtensionQuestionnaireRequest,
	normalizeExtensionQuestionnaireRequestV2,
	projectExtensionQuestionnaireRequestV2ToV1,
	QUESTIONNAIRE_DEFAULT_OTHER,
	QUESTIONNAIRE_ENVELOPE_MAX_BYTES,
	QUESTIONNAIRE_TEXT_FIELD_MAX_BYTES,
	requestQuestionnaire,
} from "../src/core/extensions/questionnaire.js";
import type {
	ExtensionQuestionnaireDraftV1,
	ExtensionQuestionnaireOutcome,
	ExtensionQuestionnaireOutcomePresentation,
	ExtensionQuestionnaireOutcomeV2,
	ExtensionQuestionnaireRequestV1,
	ExtensionQuestionnaireRequestV2,
	ExtensionQuestionnaireResponse,
	ExtensionUIContext,
} from "../src/core/extensions/types.js";
import { requestQuestionnaire as packageRootRequestQuestionnaire } from "../src/index.js";

const request: ExtensionQuestionnaireRequestV1 = {
	version: 1,
	title: "Deploy",
	questions: [
		{ id: "confirm", kind: "confirm", prompt: "Continue?", other: {} },
		{
			id: "single",
			kind: "single-select",
			prompt: "Target?",
			choices: [
				{ id: "prod", label: "Production", description: "Live" },
				{ id: "stage", label: "Staging" },
			],
		},
		{
			id: "multi",
			kind: "multi-select",
			prompt: "Regions?",
			choices: [
				{ id: "east", label: "East" },
				{ id: "west", label: "West" },
			],
		},
		{ id: "short", kind: "short-text", prompt: "Name?", initialValue: "alpha" },
		{ id: "long", kind: "multiline-text", prompt: "Notes?", placeholder: "Optional" },
	],
};

describe("questionnaire public contract", () => {
	it("keeps an old structural UI context assignable", () => {
		type LegacyExtensionUIContext = Omit<ExtensionUIContext, "questionnaire">;
		expectTypeOf<LegacyExtensionUIContext>().toExtend<ExtensionUIContext>();
	});

	it("represents v1-projection terminal outcome metadata in v1 and v2", () => {
		const presentation = {
			mode: "v1-projection",
			unavailableFeatures: ["notes", "previews"],
		} satisfies ExtensionQuestionnaireOutcomePresentation;
		const dismissed = { status: "dismissed", presentation } satisfies ExtensionQuestionnaireOutcome;
		const submitted = { status: "submitted", responses: [], presentation } satisfies ExtensionQuestionnaireOutcomeV2;
		expect(dismissed.presentation).toBe(presentation);
		expect(submitted.presentation.unavailableFeatures).toEqual(["notes", "previews"]);
	});

	it("exports the request, draft, response, and outcome unions", () => {
		expectTypeOf(request).toMatchTypeOf<ExtensionQuestionnaireRequestV1>();
		expectTypeOf<ExtensionQuestionnaireDraftV1>().toBeObject();
		expectTypeOf<ExtensionQuestionnaireResponse>().toBeObject();
		expectTypeOf<ExtensionQuestionnaireOutcome>().toBeObject();
	});

	it("exports the helper from the package root", () => {
		expect(packageRootRequestQuestionnaire).toBe(requestQuestionnaire);
	});

	it("accepts v2 requests through the public helper", async () => {
		const ui = {
			...({} as Omit<ExtensionUIContext, "questionnaire">),
			questionnaire: vi.fn(async (): Promise<ExtensionQuestionnaireOutcome> => ({ status: "dismissed" })),
		} satisfies ExtensionUIContext;
		const v2Request: ExtensionQuestionnaireRequestV2 = {
			version: 2,
			questions: [{ id: "q", kind: "confirm", prompt: "Continue?" }],
		};
		await expect(requestQuestionnaire(ui, v2Request)).resolves.toEqual({ status: "dismissed" });
		expect(ui.questionnaire).toHaveBeenCalledWith(
			expect.objectContaining({
				version: 2,
				questions: [expect.objectContaining({ other: QUESTIONNAIRE_DEFAULT_OTHER })],
			}),
			undefined,
		);
	});

	it("returns unsupported before validating when the optional method is absent", async () => {
		const legacyUi = {} as Omit<ExtensionUIContext, "questionnaire">;
		await expect(requestQuestionnaire(legacyUi, request)).resolves.toEqual({ status: "unsupported" });
		const invalidRequest = {
			...request,
			questions: [{ id: "bad id", kind: "confirm", prompt: "?" }] as ExtensionQuestionnaireRequestV1["questions"],
		};
		await expect(requestQuestionnaire(legacyUi, invalidRequest)).resolves.toEqual({ status: "unsupported" });

		const malformedUi = { questionnaire: true } as unknown as ExtensionUIContext;
		await expect(requestQuestionnaire(malformedUi, invalidRequest)).resolves.toEqual({ status: "unsupported" });
	});

	it("validates before invoking questionnaire and forwards the signal", async () => {
		const controller = new AbortController();
		const questionnaire = vi.fn(async (): Promise<ExtensionQuestionnaireOutcome> => ({ status: "dismissed" }));
		const ui = {
			...({} as Omit<ExtensionUIContext, "questionnaire">),
			questionnaire,
		} satisfies ExtensionUIContext;
		await expect(requestQuestionnaire(ui, request, { signal: controller.signal })).resolves.toEqual({
			status: "dismissed",
		});
		expect(questionnaire).toHaveBeenCalledWith(request, { signal: controller.signal });

		await expect(
			requestQuestionnaire(ui, { ...request, questions: [{ id: "bad id", kind: "confirm", prompt: "?" }] }),
		).rejects.toThrow(/question id/i);
		expect(questionnaire).toHaveBeenCalledTimes(1);
	});
});

describe("questionnaire request validation", () => {
	it("accepts and preserves all five question kinds", () => {
		expect(normalizeExtensionQuestionnaireRequest(request)).toEqual(request);
	});

	it.each([
		["unsupported version", { ...request, version: 2 }, /version/i],
		["duplicate question IDs", { ...request, questions: [request.questions[0], request.questions[0]] }, /unique/i],
		["invalid ID", { ...request, questions: [{ id: "bad id", kind: "confirm", prompt: "ok" }] }, /question id/i],
		["empty prompt", { ...request, questions: [{ id: "ok", kind: "confirm", prompt: "" }] }, /prompt/i],
		[
			"duplicate choice IDs",
			{
				...request,
				questions: [
					{
						id: "q",
						kind: "single-select",
						prompt: "?",
						choices: [
							{ id: "x", label: "X" },
							{ id: "x", label: "Y" },
						],
					},
				],
			},
			/unique/i,
		],
		[
			"empty choices",
			{ ...request, questions: [{ id: "q", kind: "multi-select", prompt: "?", choices: [] }] },
			/choices/i,
		],
		["terminal control sequences", { ...request, title: "safe\u001b[2J" }, /control/i],
		["bidirectional controls", { ...request, title: "Approve\u202Espoofed" }, /bidirectional/i],
		["unknown fields", { ...request, extra: true }, /unknown/i],
	] as const)("rejects %s", (_name, value, message) => {
		expect(() => normalizeExtensionQuestionnaireRequest(value)).toThrow(message);
	});

	it("enforces question count and schema string limits", () => {
		expect(() => normalizeExtensionQuestionnaireRequest({ version: 1, questions: [] })).toThrow(/1.*32/i);
		expect(() =>
			normalizeExtensionQuestionnaireRequest({
				version: 1,
				questions: Array.from({ length: 33 }, (_, index) => ({ id: `q${index}`, kind: "confirm", prompt: "?" })),
			}),
		).toThrow(/1.*32/i);
		expect(() => normalizeExtensionQuestionnaireRequest({ ...request, title: "x".repeat(257) })).toThrow(/title/i);
		expect(() =>
			normalizeExtensionQuestionnaireRequest({
				version: 1,
				questions: [{ id: "q", kind: "short-text", prompt: "x".repeat(65_537) }],
			}),
		).toThrow(/prompt/i);
	});
	it("rejects nested controls while preserving tabs and line feeds", () => {
		expect(() =>
			normalizeExtensionQuestionnaireRequest({
				version: 1,
				questions: [
					{
						id: "q",
						kind: "single-select",
						prompt: "safe",
						choices: [{ id: "choice", label: "Choice", description: "unsafe\u001b[2J" }],
					},
				],
			}),
		).toThrow(/control/i);

		const withWhitespace = {
			version: 1,
			questions: [{ id: "q", kind: "multiline-text", prompt: "line one\nline two\tindented" }],
		} as const;
		expect(normalizeExtensionQuestionnaireRequest(withWhitespace)).toEqual(withWhitespace);
	});

	it("rejects an oversized normalized request", () => {
		expect(() =>
			normalizeExtensionQuestionnaireRequest({
				version: 1,
				questions: Array.from({ length: 3 }, (_, index) => ({
					id: `q${index}`,
					kind: "multiline-text",
					prompt: "😀".repeat(65_536),
				})),
			}),
		).toThrow(/512 KiB/i);
	});
});

describe("canonical questionnaire encoding and budgets", () => {
	it("sorts object keys recursively and counts exact UTF-8 bytes", () => {
		const left = canonicalQuestionnaireJsonBytes({ z: "😀", nested: { b: 2, a: 1 } });
		const right = canonicalQuestionnaireJsonBytes({ nested: { a: 1, b: 2 }, z: "😀" });
		expect(left).toEqual(right);
		expect(left.byteLength).toBe(new TextEncoder().encode('{"nested":{"a":1,"b":2},"z":"😀"}').byteLength);
	});

	it("faithfully preserves an own __proto__ key without colliding with an empty object", () => {
		const value = JSON.parse('{"__proto__":{"x":1}}') as unknown;
		const encoded = canonicalQuestionnaireJsonBytes(value);
		const parsed = JSON.parse(new TextDecoder().decode(encoded)) as Record<string, unknown>;
		expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
		expect(Reflect.get(parsed, "__proto__")).toEqual({ x: 1 });
		expect(encoded).not.toEqual(canonicalQuestionnaireJsonBytes({}));
	});

	it("rejects non-plain objects rather than silently changing them", () => {
		expect(() => canonicalQuestionnaireJsonBytes(new Date(0))).toThrow(/plain object/i);
	});

	it("enforces exact aggregate and individual text byte boundaries", () => {
		const envelopeOverhead = canonicalQuestionnaireJsonBytes({ text: "" }).byteLength;
		const fittingText = "x".repeat(QUESTIONNAIRE_ENVELOPE_MAX_BYTES - envelopeOverhead);
		expect(assertQuestionnaireEnvelopeBudget({ text: fittingText })).toBe(QUESTIONNAIRE_ENVELOPE_MAX_BYTES);
		expect(() => assertQuestionnaireEnvelopeBudget({ text: `${fittingText}x` })).toThrow(/512 KiB/i);

		const fittingMultibyte = "😀".repeat(QUESTIONNAIRE_TEXT_FIELD_MAX_BYTES / 4);
		expect(assertQuestionnaireTextFieldBudget(fittingMultibyte, "value")).toBe(QUESTIONNAIRE_TEXT_FIELD_MAX_BYTES);
		expect(() => assertQuestionnaireTextFieldBudget(`${fittingMultibyte}x`, "value")).toThrow(/128 KiB/i);
	});
});

describe("questionnaire draft validation", () => {
	it("requires one matching state per question and canonicalizes multi-select IDs into request order", () => {
		const draft: ExtensionQuestionnaireDraftV1 = {
			version: 1,
			currentStep: { kind: "review" },
			states: [
				{ questionId: "confirm", kind: "confirm", selection: null, otherEditorOpen: false, otherText: "" },
				{ questionId: "single", kind: "single-select", selection: null, otherEditorOpen: false, otherText: "" },
				{
					questionId: "multi",
					kind: "multi-select",
					choiceIds: ["west", "east"],
					otherSelected: false,
					otherEditorOpen: false,
					otherText: "",
				},
				{ questionId: "short", kind: "short-text", value: "" },
				{ questionId: "long", kind: "multiline-text", value: "partial\ntext" },
			],
		};
		expect(normalizeExtensionQuestionnaireDraft(request, draft)).toEqual({
			...draft,
			states: draft.states.map((state) =>
				state.kind === "multi-select" ? { ...state, choiceIds: ["east", "west"] } : state,
			),
		});
	});

	it("rejects wrong kinds, unknown choices, and oversized editable text", () => {
		const base = normalizeExtensionQuestionnaireDraft(request, {
			version: 1,
			currentStep: { kind: "question", questionId: "confirm" },
			states: [
				{ questionId: "confirm", kind: "confirm", selection: null, otherEditorOpen: false, otherText: "" },
				{ questionId: "single", kind: "single-select", selection: null, otherEditorOpen: false, otherText: "" },
				{
					questionId: "multi",
					kind: "multi-select",
					choiceIds: [],
					otherSelected: false,
					otherEditorOpen: false,
					otherText: "",
				},
				{ questionId: "short", kind: "short-text", value: "" },
				{ questionId: "long", kind: "multiline-text", value: "" },
			],
		});
		expect(() =>
			normalizeExtensionQuestionnaireDraft(request, {
				...base,
				states: base.states.map((state) =>
					state.questionId === "short" ? { questionId: "short", kind: "multiline-text", value: "" } : state,
				),
			}),
		).toThrow(/kind/i);
		expect(() =>
			normalizeExtensionQuestionnaireDraft(request, {
				...base,
				states: base.states.map((state) =>
					state.kind === "multi-select" ? { ...state, choiceIds: ["north"] } : state,
				),
			}),
		).toThrow(/choice/i);
		expect(() =>
			normalizeExtensionQuestionnaireDraft(request, {
				...base,
				states: base.states.map((state) =>
					state.kind === "short-text" ? { ...state, value: "😀".repeat(32_769) } : state,
				),
			}),
		).toThrow(/128 KiB/i);
		expect(() =>
			normalizeExtensionQuestionnaireDraft(request, {
				...base,
				states: base.states.map((state) =>
					state.kind === "single-select" ? { ...state, otherEditorOpen: true } : state,
				),
			}),
		).toThrow(/does not define/i);
		expect(() =>
			normalizeExtensionQuestionnaireDraft(request, {
				...base,
				states: base.states.map((state) =>
					state.kind === "multiline-text" ? { ...state, value: "unsafe\u0001" } : state,
				),
			}),
		).toThrow(/control/i);

		const whitespaceDraft = normalizeExtensionQuestionnaireDraft(request, {
			...base,
			states: base.states.map((state) =>
				state.kind === "multiline-text" ? { ...state, value: "line one\nline two\tindented" } : state,
			),
		});
		expect(whitespaceDraft.states.at(-1)).toMatchObject({ value: "line one\nline two\tindented" });
	});

	it("rejects an oversized complete draft through its normalizer", () => {
		const largeRequest = normalizeExtensionQuestionnaireRequest({
			version: 1,
			questions: Array.from({ length: 5 }, (_, index) => ({
				id: `q${index}`,
				kind: "multiline-text",
				prompt: "?",
			})),
		});
		expect(() =>
			normalizeExtensionQuestionnaireDraft(largeRequest, {
				version: 1,
				currentStep: { kind: "review" },
				states: largeRequest.questions.map((question) => ({
					questionId: question.id,
					kind: "multiline-text",
					value: "x".repeat(QUESTIONNAIRE_TEXT_FIELD_MAX_BYTES),
				})),
			}),
		).toThrow(/512 KiB/i);
	});
});

describe("questionnaire v2 core", () => {
	const v2: ExtensionQuestionnaireRequestV2 = {
		version: 2,
		questions: [
			{
				id: "q",
				kind: "single-select",
				prompt: "Choose",
				context: "**Tradeoff**",
				recommendation: { choiceId: "a", rationale: "Best *fit*" },
				choices: [
					{
						id: "a",
						label: "A",
						detail: "- Fast",
						preview: { title: "Preview", markdown: "```text\nok\n```", alt: "ok" },
					},
				],
			},
		],
	};
	it("normalizes rich fields and injects canonical Other", () => {
		expect(normalizeExtensionQuestionnaireRequestV2(v2)).toEqual({
			...v2,
			questions: [
				{
					...v2.questions[0],
					other: { label: "Something else…", placeholder: "Describe your answer and the key tradeoff" },
				},
			],
		});
	});
	it("normalizes v2 draft notes without treating them as answers", () => {
		const normalized = normalizeExtensionQuestionnaireDraftV2(v2, {
			version: 2,
			currentStep: { kind: "review" },
			states: [
				{
					questionId: "q",
					kind: "single-select",
					selection: null,
					otherEditorOpen: false,
					otherText: "",
					note: "Keep undecided",
				},
			],
		});
		expect(normalized.states[0]).toMatchObject({ selection: null, note: "Keep undecided" });
		expect(() =>
			normalizeExtensionQuestionnaireDraftV2(v2, {
				...normalized,
				states: [{ ...normalized.states[0], note: "x".repeat(16_385) }],
			}),
		).toThrow(/note/i);
	});
	it("projects v2 to a v1-only plain shape", () => {
		const projected = projectExtensionQuestionnaireRequestV2ToV1(v2);
		expect(projected.version).toBe(1);
		expect(projected.questions[0]).not.toHaveProperty("context");
		expect(projected.questions[0]).not.toHaveProperty("recommendation");
		expect(projected.questions[0]).toMatchObject({ other: QUESTIONNAIRE_DEFAULT_OTHER });
		expect(JSON.stringify(projected)).not.toContain("preview");
	});
	it.each([
		[
			"context",
			(base: ExtensionQuestionnaireRequestV2) => ({
				...base,
				questions: [{ ...base.questions[0], context: "bad\talignment" }],
			}),
		],
		[
			"recommendation rationale",
			(base: ExtensionQuestionnaireRequestV2) => ({
				...base,
				questions: [{ ...base.questions[0], recommendation: { choiceId: "a", rationale: "bad\talignment" } }],
			}),
		],
		[
			"choice detail",
			(base: ExtensionQuestionnaireRequestV2) => ({
				...base,
				questions: [{ ...base.questions[0], choices: [{ id: "a", label: "A", detail: "bad\talignment" }] }],
			}),
		],
		[
			"preview markdown",
			(base: ExtensionQuestionnaireRequestV2) => ({
				...base,
				questions: [
					{
						...base.questions[0],
						choices: [{ id: "a", label: "A", preview: { markdown: "bad\talignment", alt: "safe" } }],
					},
				],
			}),
		],
	] as const)("rejects tabs in v2 rich %s", (_name, mutate) => {
		expect(() => normalizeExtensionQuestionnaireRequestV2(mutate(v2))).toThrow(/tab/i);
	});
	it("rejects invalid recommendation references and unsafe rich text", () => {
		expect(() =>
			normalizeExtensionQuestionnaireRequestV2({
				...v2,
				questions: [{ ...v2.questions[0], recommendation: { choiceId: "missing", rationale: "no" } }],
			}),
		).toThrow(/recommendation.*choice/i);
		expect(() =>
			normalizeExtensionQuestionnaireRequestV2({ ...v2, questions: [{ ...v2.questions[0], context: "bad\u001b" }] }),
		).toThrow(/control/i);
	});
});

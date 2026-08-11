import type {
	ExtensionQuestionnaireChoice,
	ExtensionQuestionnaireDraftQuestionState,
	ExtensionQuestionnaireDraftStep,
	ExtensionQuestionnaireDraftV1,
	ExtensionQuestionnaireDraftV2,
	ExtensionQuestionnaireOptions,
	ExtensionQuestionnaireOutcome,
	ExtensionQuestionnaireOutcomeV2,
	ExtensionQuestionnaireQuestion,
	ExtensionQuestionnaireQuestionV2,
	ExtensionQuestionnaireRequestV1,
	ExtensionQuestionnaireRequestV2,
	ExtensionUIContext,
} from "./types.js";

export const QUESTIONNAIRE_ENVELOPE_MAX_BYTES = 512 * 1024;
export const QUESTIONNAIRE_TEXT_FIELD_MAX_BYTES = 128 * 1024;

const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;
const DISALLOWED_CONTROL_PATTERN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;
const BIDIRECTIONAL_CONTROL_PATTERN = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const encoder = new TextEncoder();

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

type NormalizedQuestionBase = {
	id: string;
	label?: string;
	prompt: string;
};

function fail(path: string, message: string): never {
	throw new TypeError(`Invalid questionnaire ${path}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, path: string): Record<string, unknown> {
	if (!isRecord(value)) fail(path, "must be an object");
	return value;
}

function assertKnownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
	const allowedKeys = new Set(allowed);
	const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key));
	if (unknownKey !== undefined) fail(path, `contains unknown field ${JSON.stringify(unknownKey)}`);
}

function stringValue(
	value: unknown,
	path: string,
	options: { minLength?: number; maxLength?: number; editable?: boolean } = {},
): string {
	if (typeof value !== "string") fail(path, "must be a string");
	const length = Array.from(value).length;
	if (options.minLength !== undefined && length < options.minLength) {
		fail(path, `must contain at least ${options.minLength} character`);
	}
	if (options.maxLength !== undefined && length > options.maxLength) {
		fail(path, `must contain at most ${options.maxLength} characters`);
	}
	if (DISALLOWED_CONTROL_PATTERN.test(value)) fail(path, "contains a disallowed control character");
	if (BIDIRECTIONAL_CONTROL_PATTERN.test(value)) fail(path, "contains a disallowed bidirectional control character");
	if (options.editable) assertQuestionnaireTextFieldBudget(value, path);
	return value;
}

function optionalString(
	value: unknown,
	path: string,
	options: { minLength?: number; maxLength?: number; editable?: boolean } = {},
): string | undefined {
	return value === undefined ? undefined : stringValue(value, path, options);
}

function richTextValue(value: unknown, path: string, options: { minLength?: number; maxLength?: number } = {}): string {
	const normalized = stringValue(value, path, options);
	if (normalized.includes("\t")) fail(path, "contains a tab; use spaces for stable rich-text alignment");
	return normalized;
}

function optionalRichText(
	value: unknown,
	path: string,
	options: { minLength?: number; maxLength?: number } = {},
): string | undefined {
	return value === undefined ? undefined : richTextValue(value, path, options);
}

function booleanValue(value: unknown, path: string): boolean {
	if (typeof value !== "boolean") fail(path, "must be a boolean");
	return value;
}

function canonicalizeJson(value: unknown, path: string): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) fail(path, "contains a non-finite number");
		return value;
	}
	if (Array.isArray(value)) return value.map((item, index) => canonicalizeJson(item, `${path}[${index}]`));
	if (!isRecord(value)) fail(path, "is not JSON-serializable");
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) fail(path, "must be a plain object");
	const output = Object.create(null) as { [key: string]: JsonValue };
	for (const key of Object.keys(value).sort()) {
		const item = value[key];
		if (item === undefined) fail(`${path}.${key}`, "is undefined and not JSON-serializable");
		output[key] = canonicalizeJson(item, `${path}.${key}`);
	}
	return output;
}

/** Encode JSON with recursively sorted object keys and exact UTF-8 byte semantics. */
export function canonicalQuestionnaireJsonBytes(value: unknown): Uint8Array {
	return encoder.encode(JSON.stringify(canonicalizeJson(value, "value")));
}

/** Assert the shared request/draft/response envelope budget and return its exact encoded size. */
export function assertQuestionnaireEnvelopeBudget(value: unknown): number {
	const bytes = canonicalQuestionnaireJsonBytes(value).byteLength;
	if (bytes > QUESTIONNAIRE_ENVELOPE_MAX_BYTES) {
		fail("envelope", `exceeds the 512 KiB canonical UTF-8 budget (${bytes} bytes)`);
	}
	return bytes;
}

/** Assert the per-field editable-text budget and return the field's exact UTF-8 size. */
export function assertQuestionnaireTextFieldBudget(value: string, path = "text field"): number {
	const bytes = encoder.encode(value).byteLength;
	if (bytes > QUESTIONNAIRE_TEXT_FIELD_MAX_BYTES) {
		fail(path, `exceeds the 128 KiB UTF-8 budget (${bytes} bytes)`);
	}
	return bytes;
}

function normalizeOther(value: unknown, path: string): { label?: string; placeholder?: string } | undefined {
	if (value === undefined) return undefined;
	const input = record(value, path);
	assertKnownKeys(input, ["label", "placeholder"], path);
	const label = optionalString(input.label, `${path}.label`, { minLength: 1, maxLength: 256 });
	const placeholder = optionalString(input.placeholder, `${path}.placeholder`, { maxLength: 1024 });
	return {
		...(label === undefined ? {} : { label }),
		...(placeholder === undefined ? {} : { placeholder }),
	};
}

function normalizeChoice(value: unknown, path: string): ExtensionQuestionnaireChoice {
	const input = record(value, path);
	assertKnownKeys(input, ["id", "label", "description"], path);
	const id = stringValue(input.id, `${path} id`);
	if (!ID_PATTERN.test(id)) fail(`${path} id`, "must match [A-Za-z0-9._-]{1,128}");
	const label = stringValue(input.label, `${path}.label`, { minLength: 1, maxLength: 1024 });
	const description = optionalString(input.description, `${path}.description`, { maxLength: 16_384 });
	return { id, label, ...(description === undefined ? {} : { description }) };
}

function normalizeQuestionBase(input: Record<string, unknown>, path: string): NormalizedQuestionBase {
	const id = stringValue(input.id, `${path} question ID`);
	if (!ID_PATTERN.test(id)) fail(`${path} question ID`, "must match [A-Za-z0-9._-]{1,128}");
	const label = optionalString(input.label, `${path}.label`, { minLength: 1, maxLength: 128 });
	const prompt = stringValue(input.prompt, `${path}.prompt`, { minLength: 1, maxLength: 65_536 });
	return { id, ...(label === undefined ? {} : { label }), prompt };
}

function normalizeChoices(value: unknown, path: string): ExtensionQuestionnaireChoice[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 100) fail(path, "must contain 1 to 100 choices");
	const choices = value.map((choice, index) => normalizeChoice(choice, `${path}[${index}]`));
	const ids = new Set<string>();
	for (const choice of choices) {
		if (ids.has(choice.id)) fail(path, "choice IDs must be unique within a question");
		ids.add(choice.id);
	}
	return choices;
}

function normalizeQuestion(value: unknown, index: number): ExtensionQuestionnaireQuestion {
	const path = `questions[${index}]`;
	const input = record(value, path);
	const kind = input.kind;
	if (typeof kind !== "string") fail(`${path}.kind`, "must be a supported question kind");
	const base = normalizeQuestionBase(input, path);
	switch (kind) {
		case "confirm": {
			assertKnownKeys(input, ["id", "label", "prompt", "kind", "yesLabel", "noLabel", "other"], path);
			const yesLabel = optionalString(input.yesLabel, `${path}.yesLabel`, { minLength: 1, maxLength: 256 });
			const noLabel = optionalString(input.noLabel, `${path}.noLabel`, { minLength: 1, maxLength: 256 });
			const other = normalizeOther(input.other, `${path}.other`);
			return {
				...base,
				kind,
				...(yesLabel === undefined ? {} : { yesLabel }),
				...(noLabel === undefined ? {} : { noLabel }),
				...(other === undefined ? {} : { other }),
			};
		}
		case "single-select":
		case "multi-select": {
			assertKnownKeys(input, ["id", "label", "prompt", "kind", "choices", "other"], path);
			const choices = normalizeChoices(input.choices, `${path}.choices`);
			const other = normalizeOther(input.other, `${path}.other`);
			return { ...base, kind, choices, ...(other === undefined ? {} : { other }) };
		}
		case "short-text":
		case "multiline-text": {
			assertKnownKeys(input, ["id", "label", "prompt", "kind", "placeholder", "initialValue"], path);
			const placeholder = optionalString(input.placeholder, `${path}.placeholder`, { maxLength: 1024 });
			const initialValue = optionalString(input.initialValue, `${path}.initialValue`, { editable: true });
			return {
				...base,
				kind,
				...(placeholder === undefined ? {} : { placeholder }),
				...(initialValue === undefined ? {} : { initialValue }),
			};
		}
		default:
			fail(`${path}.kind`, `unsupported value ${JSON.stringify(kind)}`);
	}
}

/** Validate and clone a v1 request into its canonical field shape. */
export function normalizeExtensionQuestionnaireRequest(value: unknown): ExtensionQuestionnaireRequestV1 {
	const input = record(value, "request");
	assertKnownKeys(input, ["version", "title", "questions", "submitLabel"], "request");
	if (input.version !== 1) fail("request.version", "must equal 1");
	if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 32) {
		fail("request.questions", "must contain 1 to 32 questions");
	}
	const title = optionalString(input.title, "request.title", { minLength: 1, maxLength: 256 });
	const submitLabel = optionalString(input.submitLabel, "request.submitLabel", { minLength: 1, maxLength: 256 });
	const questions = input.questions.map(normalizeQuestion);
	const ids = new Set<string>();
	for (const question of questions) {
		if (ids.has(question.id)) fail("request.questions", "question IDs must be unique");
		ids.add(question.id);
	}
	const normalized: ExtensionQuestionnaireRequestV1 = {
		version: 1,
		...(title === undefined ? {} : { title }),
		questions,
		...(submitLabel === undefined ? {} : { submitLabel }),
	};
	assertQuestionnaireEnvelopeBudget(normalized);
	return normalized;
}

export const QUESTIONNAIRE_DEFAULT_OTHER = {
	label: "Something else…",
	placeholder: "Describe your answer and the key tradeoff",
} as const;

function normalizePreview(value: unknown, path: string) {
	if (value === undefined) return undefined;
	const input = record(value, path);
	assertKnownKeys(input, ["title", "markdown", "alt"], path);
	const title = optionalString(input.title, `${path}.title`, { minLength: 1, maxLength: 256 });
	const markdown = richTextValue(input.markdown, `${path}.markdown`, { maxLength: 32_768 });
	const alt = stringValue(input.alt, `${path}.alt`, { maxLength: 4_096 });
	return { ...(title === undefined ? {} : { title }), markdown, alt };
}

function normalizeChoiceV2(value: unknown, path: string) {
	const input = record(value, path);
	assertKnownKeys(input, ["id", "label", "description", "detail", "preview"], path);
	const base = normalizeChoice(
		{
			id: input.id,
			label: input.label,
			...(input.description === undefined ? {} : { description: input.description }),
		},
		path,
	);
	const detail = optionalRichText(input.detail, `${path}.detail`, { maxLength: 16_384 });
	const preview = normalizePreview(input.preview, `${path}.preview`);
	return { ...base, ...(detail === undefined ? {} : { detail }), ...(preview === undefined ? {} : { preview }) };
}

function normalizeQuestionV2(value: unknown, index: number): ExtensionQuestionnaireQuestionV2 {
	const path = `questions[${index}]`;
	const input = record(value, path);
	const kind = input.kind;
	if (typeof kind !== "string") fail(`${path}.kind`, "must be a supported question kind");
	const baseV1 = normalizeQuestionBase(input, path);
	const context = optionalRichText(input.context, `${path}.context`, { maxLength: 65_536 });
	let recommendation: { choiceId?: string; rationale: string } | undefined;
	if (input.recommendation !== undefined) {
		const rec = record(input.recommendation, `${path}.recommendation`);
		assertKnownKeys(rec, ["choiceId", "rationale"], `${path}.recommendation`);
		const choiceId = optionalString(rec.choiceId, `${path}.recommendation.choiceId`);
		const rationale = richTextValue(rec.rationale, `${path}.recommendation.rationale`, { maxLength: 16_384 });
		recommendation = { ...(choiceId === undefined ? {} : { choiceId }), rationale };
	}
	const base = {
		...baseV1,
		...(context === undefined ? {} : { context }),
		...(recommendation === undefined ? {} : { recommendation }),
	};
	if (kind === "confirm") {
		assertKnownKeys(
			input,
			["id", "label", "prompt", "context", "recommendation", "kind", "yesLabel", "noLabel", "other"],
			path,
		);
		if (recommendation?.choiceId !== undefined)
			fail(`${path}.recommendation.choiceId`, "must reference a choice in the same question");
		const yesLabel = optionalString(input.yesLabel, `${path}.yesLabel`, { minLength: 1, maxLength: 256 });
		const noLabel = optionalString(input.noLabel, `${path}.noLabel`, { minLength: 1, maxLength: 256 });
		const custom = normalizeOther(input.other, `${path}.other`);
		return {
			...base,
			kind,
			...(yesLabel === undefined ? {} : { yesLabel }),
			...(noLabel === undefined ? {} : { noLabel }),
			other: { ...QUESTIONNAIRE_DEFAULT_OTHER, ...custom },
		};
	}
	if (kind === "single-select" || kind === "multi-select") {
		assertKnownKeys(input, ["id", "label", "prompt", "context", "recommendation", "kind", "choices", "other"], path);
		if (!Array.isArray(input.choices) || input.choices.length < 1 || input.choices.length > 100)
			fail(`${path}.choices`, "must contain 1 to 100 choices");
		const choices = input.choices.map((choice, choiceIndex) =>
			normalizeChoiceV2(choice, `${path}.choices[${choiceIndex}]`),
		);
		if (new Set(choices.map((choice) => choice.id)).size !== choices.length)
			fail(`${path}.choices`, "choice IDs must be unique within a question");
		if (recommendation?.choiceId !== undefined && !choices.some((choice) => choice.id === recommendation.choiceId))
			fail(`${path}.recommendation.choiceId`, "must reference a choice in the same question");
		const custom = normalizeOther(input.other, `${path}.other`);
		return { ...base, kind, choices, other: { ...QUESTIONNAIRE_DEFAULT_OTHER, ...custom } };
	}
	if (kind === "short-text" || kind === "multiline-text") {
		assertKnownKeys(
			input,
			["id", "label", "prompt", "context", "recommendation", "kind", "placeholder", "initialValue"],
			path,
		);
		if (recommendation?.choiceId !== undefined)
			fail(`${path}.recommendation.choiceId`, "must reference a choice in the same question");
		const placeholder = optionalString(input.placeholder, `${path}.placeholder`, { maxLength: 1024 });
		const initialValue = optionalString(input.initialValue, `${path}.initialValue`, { editable: true });
		return {
			...base,
			kind,
			...(placeholder === undefined ? {} : { placeholder }),
			...(initialValue === undefined ? {} : { initialValue }),
		};
	}
	return fail(`${path}.kind`, `unsupported value ${JSON.stringify(kind)}`);
}

export function normalizeExtensionQuestionnaireRequestV2(value: unknown): ExtensionQuestionnaireRequestV2 {
	const input = record(value, "request");
	assertKnownKeys(input, ["version", "title", "questions", "submitLabel"], "request");
	if (input.version !== 2) fail("request.version", "must equal 2");
	if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 32)
		fail("request.questions", "must contain 1 to 32 questions");
	const title = optionalString(input.title, "request.title", { minLength: 1, maxLength: 256 });
	const submitLabel = optionalString(input.submitLabel, "request.submitLabel", { minLength: 1, maxLength: 256 });
	const questions = input.questions.map(normalizeQuestionV2);
	if (new Set(questions.map((question) => question.id)).size !== questions.length)
		fail("request.questions", "question IDs must be unique");
	const normalized = {
		version: 2 as const,
		...(title === undefined ? {} : { title }),
		questions,
		...(submitLabel === undefined ? {} : { submitLabel }),
	};
	assertQuestionnaireEnvelopeBudget(normalized);
	return normalized;
}

function normalizeDraftStep(value: unknown, request: ExtensionQuestionnaireRequestV1): ExtensionQuestionnaireDraftStep {
	const input = record(value, "draft.currentStep");
	if (input.kind === "review") {
		assertKnownKeys(input, ["kind"], "draft.currentStep");
		return { kind: "review" };
	}
	if (input.kind !== "question") fail("draft.currentStep.kind", 'must be "question" or "review"');
	assertKnownKeys(input, ["kind", "questionId"], "draft.currentStep");
	const questionId = stringValue(input.questionId, "draft.currentStep.questionId");
	if (!request.questions.some((question) => question.id === questionId)) {
		fail("draft.currentStep.questionId", "must reference a request question");
	}
	return { kind: "question", questionId };
}

function normalizeSelection(value: unknown, question: ExtensionQuestionnaireQuestion, path: string) {
	if (value === null) return null;
	const input = record(value, path);
	if (input.kind === "other") {
		assertKnownKeys(input, ["kind"], path);
		if (!("other" in question)) fail(path, "cannot select Other when the question does not define it");
		return { kind: "other" } as const;
	}
	if (input.kind !== "choice") fail(`${path}.kind`, 'must be "choice" or "other"');
	assertKnownKeys(input, ["kind", "choiceId"], path);
	const choiceId = stringValue(input.choiceId, `${path}.choiceId`);
	if (!("choices" in question) || !question.choices.some((choice) => choice.id === choiceId)) {
		fail(`${path}.choiceId`, "must reference a choice in the request question");
	}
	return { kind: "choice", choiceId } as const;
}

function normalizeDraftState(
	value: unknown,
	question: ExtensionQuestionnaireQuestion,
	index: number,
): ExtensionQuestionnaireDraftQuestionState {
	const path = `draft.states[${index}]`;
	const input = record(value, path);
	const questionId = stringValue(input.questionId, `${path}.questionId`);
	if (questionId !== question.id)
		fail(`${path}.questionId`, `must be ${JSON.stringify(question.id)} in request order`);
	if (input.kind !== question.kind) fail(`${path}.kind`, `must match request kind ${JSON.stringify(question.kind)}`);
	switch (question.kind) {
		case "confirm": {
			assertKnownKeys(input, ["questionId", "kind", "selection", "otherEditorOpen", "otherText"], path);
			const selection = input.selection;
			if (selection !== null && selection !== "yes" && selection !== "no" && selection !== "other") {
				fail(`${path}.selection`, 'must be "yes", "no", "other", or null');
			}
			const otherEditorOpen = booleanValue(input.otherEditorOpen, `${path}.otherEditorOpen`);
			const otherText = stringValue(input.otherText, `${path}.otherText`, { editable: true });
			if ((selection === "other" || otherEditorOpen || otherText !== "") && question.other === undefined) {
				fail(`${path}.selection`, "cannot use Other when the request question does not define it");
			}
			return { questionId, kind: question.kind, selection, otherEditorOpen, otherText };
		}
		case "single-select": {
			assertKnownKeys(input, ["questionId", "kind", "selection", "otherEditorOpen", "otherText"], path);
			const selection = normalizeSelection(input.selection, question, `${path}.selection`);
			const otherEditorOpen = booleanValue(input.otherEditorOpen, `${path}.otherEditorOpen`);
			const otherText = stringValue(input.otherText, `${path}.otherText`, { editable: true });
			if ((selection?.kind === "other" || otherEditorOpen || otherText !== "") && question.other === undefined) {
				fail(`${path}.selection`, "cannot use Other when the request question does not define it");
			}
			return { questionId, kind: question.kind, selection, otherEditorOpen, otherText };
		}
		case "multi-select": {
			assertKnownKeys(
				input,
				["questionId", "kind", "choiceIds", "otherSelected", "otherEditorOpen", "otherText"],
				path,
			);
			if (!Array.isArray(input.choiceIds)) fail(`${path}.choiceIds`, "must be an array");
			const choiceIds = input.choiceIds.map((choiceId, choiceIndex) =>
				stringValue(choiceId, `${path}.choiceIds[${choiceIndex}]`),
			);
			if (new Set(choiceIds).size !== choiceIds.length) fail(`${path}.choiceIds`, "must contain unique choice IDs");
			const selected = new Set(choiceIds);
			if (choiceIds.some((choiceId) => !question.choices.some((choice) => choice.id === choiceId))) {
				fail(`${path}.choiceIds`, "must reference choices in the request question");
			}
			const otherSelected = booleanValue(input.otherSelected, `${path}.otherSelected`);
			const otherEditorOpen = booleanValue(input.otherEditorOpen, `${path}.otherEditorOpen`);
			const otherText = stringValue(input.otherText, `${path}.otherText`, { editable: true });
			if ((otherSelected || otherEditorOpen || otherText !== "") && question.other === undefined) {
				fail(`${path}.otherSelected`, "cannot use Other when the request question does not define it");
			}
			return {
				questionId,
				kind: question.kind,
				choiceIds: question.choices.filter((choice) => selected.has(choice.id)).map((choice) => choice.id),
				otherSelected,
				otherEditorOpen,
				otherText,
			};
		}
		case "short-text":
		case "multiline-text":
			assertKnownKeys(input, ["questionId", "kind", "value"], path);
			return {
				questionId,
				kind: question.kind,
				value: stringValue(input.value, `${path}.value`, { editable: true }),
			};
	}
}

function normalizeDraftForRequest(
	request: ExtensionQuestionnaireRequestV1,
	draftValue: unknown,
): ExtensionQuestionnaireDraftV1 {
	const input = record(draftValue, "draft");
	assertKnownKeys(input, ["version", "currentStep", "states"], "draft");
	if (input.version !== 1) fail("draft.version", "must equal 1");
	const states = input.states;
	if (!Array.isArray(states) || states.length !== request.questions.length) {
		fail("draft.states", "must contain exactly one state per request question");
	}
	return {
		version: 1,
		currentStep: normalizeDraftStep(input.currentStep, request),
		states: request.questions.map((question, index) => normalizeDraftState(states[index], question, index)),
	};
}

/** Validate a complete draft against its request and return its canonical state ordering. */
export function normalizeExtensionQuestionnaireDraft(
	requestValue: ExtensionQuestionnaireRequestV1,
	draftValue: unknown,
): ExtensionQuestionnaireDraftV1 {
	const request = normalizeExtensionQuestionnaireRequest(requestValue);
	const normalized = normalizeDraftForRequest(request, draftValue);
	assertQuestionnaireEnvelopeBudget(normalized);
	return normalized;
}

/**
 * Normalize a draft against a request already returned by `normalizeExtensionQuestionnaireRequest`.
 * The caller must perform its own complete-envelope budget check on the returned draft.
 */
export function normalizeExtensionQuestionnaireDraftForValidatedRequest(
	request: ExtensionQuestionnaireRequestV1,
	draftValue: unknown,
): ExtensionQuestionnaireDraftV1 {
	return normalizeDraftForRequest(request, draftValue);
}

/** Lossily project a rich v2 request to the plain v1 contract for legacy presentation. */
export function projectExtensionQuestionnaireRequestV2ToV1(value: unknown): ExtensionQuestionnaireRequestV1 {
	const request = normalizeExtensionQuestionnaireRequestV2(value);
	const questions: ExtensionQuestionnaireQuestion[] = request.questions.map((question) => {
		const additions = [
			question.context,
			question.recommendation === undefined ? undefined : `Recommendation: ${question.recommendation.rationale}`,
		].filter((part): part is string => part !== undefined);
		const prompt = additions.length === 0 ? question.prompt : `${question.prompt}\n\n${additions.join("\n\n")}`;
		if (question.kind === "confirm")
			return {
				id: question.id,
				...(question.label === undefined ? {} : { label: question.label }),
				prompt,
				kind: question.kind,
				...(question.yesLabel === undefined ? {} : { yesLabel: question.yesLabel }),
				...(question.noLabel === undefined ? {} : { noLabel: question.noLabel }),
				other: question.other,
			};
		if (question.kind === "single-select" || question.kind === "multi-select") {
			const choices = question.choices.map((choice) => {
				const detail = [choice.description, choice.detail, choice.preview?.alt].filter(
					(part): part is string => part !== undefined,
				);
				return {
					id: choice.id,
					label: choice.label,
					...(detail.length === 0 ? {} : { description: detail.join("\n\n") }),
				};
			});
			return {
				id: question.id,
				...(question.label === undefined ? {} : { label: question.label }),
				prompt,
				kind: question.kind,
				choices,
				other: question.other,
			};
		}
		return {
			id: question.id,
			...(question.label === undefined ? {} : { label: question.label }),
			prompt,
			kind: question.kind,
			...(question.placeholder === undefined ? {} : { placeholder: question.placeholder }),
			...(question.initialValue === undefined ? {} : { initialValue: question.initialValue }),
		};
	});
	const projected: ExtensionQuestionnaireRequestV1 = {
		version: 1,
		...(request.title === undefined ? {} : { title: request.title }),
		questions,
		...(request.submitLabel === undefined ? {} : { submitLabel: request.submitLabel }),
	};
	return normalizeExtensionQuestionnaireRequest(projected);
}

/** Validate a v2 draft, including independent per-question notes. */
export function normalizeExtensionQuestionnaireDraftV2(
	requestValue: ExtensionQuestionnaireRequestV2,
	draftValue: unknown,
): ExtensionQuestionnaireDraftV2 {
	const request = normalizeExtensionQuestionnaireRequestV2(requestValue);
	const input = record(draftValue, "draft");
	assertKnownKeys(input, ["version", "currentStep", "states"], "draft");
	if (input.version !== 2) fail("draft.version", "must equal 2");
	if (!Array.isArray(input.states) || input.states.length !== request.questions.length)
		fail("draft.states", "must contain exactly one state per request question");
	const stateInputs = input.states;
	const requestForState = {
		version: 1 as const,
		questions: request.questions,
		...(request.title === undefined ? {} : { title: request.title }),
		...(request.submitLabel === undefined ? {} : { submitLabel: request.submitLabel }),
	};
	const states = request.questions.map((question, index) => {
		const stateInput = record(stateInputs[index], `draft.states[${index}]`);
		const note = optionalString(stateInput.note, `draft.states[${index}].note`, {
			maxLength: 16_384,
			editable: true,
		});
		const withoutNote = Object.fromEntries(Object.entries(stateInput).filter(([key]) => key !== "note"));
		const state = normalizeDraftState(withoutNote, question, index);
		return { ...state, ...(note === undefined ? {} : { note }) };
	});
	const normalized: ExtensionQuestionnaireDraftV2 = {
		version: 2,
		currentStep: normalizeDraftStep(input.currentStep, requestForState),
		states,
	};
	assertQuestionnaireEnvelopeBudget(normalized);
	return normalized;
}

/** Use questionnaire when available while preserving compatibility with older structural UI contexts. */
export async function requestQuestionnaire(
	ui: ExtensionUIContext,
	request: ExtensionQuestionnaireRequestV1 | ExtensionQuestionnaireRequestV2,
	options?: ExtensionQuestionnaireOptions,
): Promise<ExtensionQuestionnaireOutcome | ExtensionQuestionnaireOutcomeV2> {
	if (typeof ui.questionnaire !== "function") return { status: "unsupported" };
	const normalized =
		request.version === 2
			? normalizeExtensionQuestionnaireRequestV2(request)
			: normalizeExtensionQuestionnaireRequest(request);
	return ui.questionnaire(normalized, options);
}

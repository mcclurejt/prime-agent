import type {
	ExtensionQuestionnaireChoice,
	ExtensionQuestionnaireDraftQuestionState,
	ExtensionQuestionnaireDraftStep,
	ExtensionQuestionnaireDraftV1,
	ExtensionQuestionnaireOptions,
	ExtensionQuestionnaireOutcome,
	ExtensionQuestionnaireQuestion,
	ExtensionQuestionnaireRequestV1,
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

/** Use questionnaire when available while preserving compatibility with older structural UI contexts. */
export async function requestQuestionnaire(
	ui: ExtensionUIContext,
	request: ExtensionQuestionnaireRequestV1,
	options?: ExtensionQuestionnaireOptions,
): Promise<ExtensionQuestionnaireOutcome> {
	if (typeof ui.questionnaire !== "function") return { status: "unsupported" };
	const normalized = normalizeExtensionQuestionnaireRequest(request);
	return ui.questionnaire(normalized, options);
}

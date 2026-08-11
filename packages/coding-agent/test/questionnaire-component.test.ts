import {
	type Component,
	type Focusable,
	type OverlayHandle,
	setKeybindings,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	canonicalQuestionnaireJsonBytes,
	QUESTIONNAIRE_ENVELOPE_MAX_BYTES,
} from "../src/core/extensions/questionnaire.js";
import type { ExtensionQuestionnaireRequestV1 } from "../src/core/extensions/types.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { QuestionnaireComponent, QuestionnaireDraftModel } from "../src/modes/interactive/components/questionnaire.js";
import { InteractiveQuestionnaireHost } from "../src/modes/interactive/questionnaire-host.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const request: ExtensionQuestionnaireRequestV1 = {
	version: 1,
	title: "Configure deployment",
	questions: [
		{ id: "confirm", label: "Approval", kind: "confirm", prompt: "Continue?", other: {} },
		{
			id: "single",
			label: "Strategy",
			kind: "single-select",
			prompt: "Which rollout strategy should we use?",
			choices: [
				{ id: "canary", label: "Canary", description: "Start with a small cohort, then expand." },
				{ id: "blue", label: "Blue/green" },
			],
			other: { label: "Something else" },
		},
		{
			id: "multi",
			label: "Regions",
			kind: "multi-select",
			prompt: "Where?",
			choices: [
				{ id: "east", label: "East" },
				{ id: "west", label: "West" },
			],
			other: {},
		},
		{ id: "short", label: "Name", kind: "short-text", prompt: "Name?", initialValue: "alpha" },
		{ id: "long", label: "Notes", kind: "multiline-text", prompt: "Notes?" },
	],
};

function createFakeTui(rows = 24): TUI & { requestRender: ReturnType<typeof vi.fn> } {
	return {
		terminal: { rows },
		requestRender: vi.fn(),
	} as unknown as TUI & { requestRender: ReturnType<typeof vi.fn> };
}

describe("QuestionnaireDraftModel", () => {
	it("navigates unanswered questions, edits back from review, and creates ordered explicit responses", () => {
		const model = new QuestionnaireDraftModel(request);

		model.next();
		model.answerSingle("single", { kind: "choice", choiceId: "canary" });
		model.next();
		model.toggleMultiChoice("multi", "west");
		model.setOther("multi", "custom");
		model.next();
		model.next();
		model.next();
		expect(model.currentStep).toEqual({ kind: "review" });

		model.goToQuestion("confirm");
		model.answerConfirm("confirm", "yes");
		model.goToReview();
		expect(model.responses()).toEqual([
			{ questionId: "confirm", status: "answered", kind: "confirm", value: true },
			{ questionId: "single", status: "answered", kind: "single-select", choiceId: "canary" },
			{
				questionId: "multi",
				status: "answered",
				kind: "multi-select",
				choiceIds: ["west"],
				otherText: "custom",
			},
			{ questionId: "short", status: "answered", kind: "short-text", value: "alpha" },
			{ questionId: "long", status: "unanswered" },
		]);
	});

	it("normalizes CRLF before validating and rejects oversized complete-draft edits non-destructively", () => {
		const budgetRequest: ExtensionQuestionnaireRequestV1 = {
			version: 1,
			questions: Array.from({ length: 5 }, (_, index) => ({
				id: `q${index}`,
				kind: "multiline-text" as const,
				prompt: "?",
			})),
		};
		const model = new QuestionnaireDraftModel(budgetRequest);
		expect(model.updateText("q0", "one\r\ntwo\rthree")).toMatchObject({ accepted: true });
		expect(model.getText("q0")).toBe("one\ntwo\nthree");
		const bidiRejected = model.updateText("q0", "approve\u202Espoofed");
		expect(bidiRejected).toMatchObject({ accepted: false });
		expect(model.getText("q0")).toBe("one\ntwo\nthree");

		for (const id of ["q0", "q1", "q2"]) {
			expect(model.updateText(id, "x".repeat(128 * 1024)).accepted).toBe(true);
		}
		const before = model.getText("q3");
		const rejected = model.updateText("q3", "x".repeat(128 * 1024));
		expect(rejected.accepted).toBe(false);
		expect(rejected.message).toMatch(/remaining|512 KiB/i);
		expect(model.getText("q3")).toBe(before);
		expect(model.remainingBytes).toBe(
			QUESTIONNAIRE_ENVELOPE_MAX_BYTES - canonicalQuestionnaireJsonBytes(model.draft).byteLength,
		);
	});

	it("reserves worst-case navigation framing and keeps zero-budget navigation non-destructive", () => {
		const budgetRequest: ExtensionQuestionnaireRequestV1 = {
			version: 1,
			questions: ["d", "q1", "q2", "q3", "summary-notes"].map((id) => ({
				id,
				kind: "multiline-text" as const,
				prompt: "?",
			})),
		};
		const model = new QuestionnaireDraftModel(budgetRequest);
		for (const id of ["d", "q1", "q2"]) expect(model.updateText(id, "x".repeat(128 * 1024)).accepted).toBe(true);
		expect(model.updateText("q3", "x".repeat(model.remainingBytes)).accepted).toBe(true);
		expect(model.remainingBytes).toBe(0);

		expect(() => model.goToReview()).not.toThrow();
		expect(model.currentStep).toEqual({ kind: "review" });
		expect(() => model.goToQuestion("summary-notes")).not.toThrow();
		expect(model.currentStep).toEqual({ kind: "question", questionId: "summary-notes" });
		expect(model.remainingBytes).toBe(0);
	});

	it("does not conflate field/control rejection with aggregate budget feedback", () => {
		const model = new QuestionnaireDraftModel({
			version: 1,
			questions: [{ id: "q", kind: "multiline-text", prompt: "?" }],
		});
		const rejected = model.updateText("q", "unsafe\u202Evalue");
		expect(rejected.accepted).toBe(false);
		expect(rejected.message).toMatch(/bidirectional/i);
		expect(rejected.message).not.toMatch(/aggregate bytes remain/i);
	});

	it("canonical-encodes each accepted candidate only once while reserving every navigation step", () => {
		const model = new QuestionnaireDraftModel({
			version: 1,
			questions: Array.from({ length: 32 }, (_, index) => ({
				id: `question-${index}-${"long-id-".repeat(8)}`,
				kind: "multiline-text" as const,
				prompt: "?",
			})),
		});
		const stringify = vi.spyOn(JSON, "stringify");

		try {
			expect(model.updateText(model.request.questions[0]!.id, "accepted").accepted).toBe(true);
			expect(stringify).toHaveBeenCalledTimes(1);
		} finally {
			stringify.mockRestore();
		}
	});
});

describe("QuestionnaireComponent", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => {
		setKeybindings(
			new KeybindingsManager({
				"app.questionnaire.next": "ctrl+n",
				"app.questionnaire.previous": "ctrl+p",
			}),
		);
	});

	it("renders responsive wide tabs and narrow steps without overflowing, and requires explicit review submission", () => {
		const tui = createFakeTui(18);
		const submit = vi.fn();
		const component = new QuestionnaireComponent({
			tui,
			keybindings: new KeybindingsManager({
				"app.questionnaire.next": "ctrl+n",
				"app.questionnaire.previous": "ctrl+p",
			}),
			request,
			getRows: () => tui.terminal.rows,
			requestRender: tui.requestRender,
			onSubmit: submit,
			onDismiss: vi.fn(),
		});

		const wide = stripAnsi(component.render(96).join("\n"));
		expect(wide).toContain("[▶ Approval]");
		expect(wide).toContain("[  Review / Submit]");

		const narrowLines = component.render(30);
		expect(stripAnsi(narrowLines.join("\n"))).toContain("Question 1 of 5: Approval");
		expect(narrowLines.length).toBeLessThanOrEqual(18);
		for (const line of narrowLines) expect(visibleWidth(line)).toBeLessThanOrEqual(30);

		for (let index = 0; index < request.questions.length; index++) component.handleInput("\x0e");
		expect(stripAnsi(component.render(96).join("\n"))).toContain("[▶ Review / Submit]");
		expect(submit).not.toHaveBeenCalled();
		component.handleInput("\r");
		expect(component.model.currentStep).toEqual({ kind: "question", questionId: "confirm" });
		component.model.goToReview();
		component.handleInput("\x0e");
		component.handleInput("\r");
		expect(submit).toHaveBeenCalledWith({ status: "submitted", responses: expect.any(Array) });
	});

	it("uses Space for multi-select toggles and left/right arrows for persistent page navigation", () => {
		const tui = createFakeTui(18);
		const component = new QuestionnaireComponent({
			tui,
			keybindings: new KeybindingsManager(),
			request,
			getRows: () => tui.terminal.rows,
			requestRender: tui.requestRender,
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});

		component.handleInput("\x1b[C");
		expect(component.model.currentStep).toEqual({ kind: "question", questionId: "single" });
		component.handleInput("\x1b[C");
		expect(component.model.currentStep).toEqual({ kind: "question", questionId: "multi" });

		component.handleInput("\r");
		expect(component.model.currentStep).toEqual({ kind: "question", questionId: "multi" });
		expect(component.model.getState("multi")).toMatchObject({ choiceIds: [] });
		component.handleInput(" ");
		expect(component.model.getState("multi")).toMatchObject({ choiceIds: ["east"] });

		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput(" ");
		expect(component.isOtherEditorOpen).toBe(true);
		component.handleInput("custom region");
		component.handleInput("\r");
		expect(component.isOtherEditorOpen).toBe(false);
		component.handleInput("\x1b[D");
		expect(component.model.currentStep).toEqual({ kind: "question", questionId: "single" });
		component.handleInput("\x1b[C");
		expect(component.model.currentStep).toEqual({ kind: "question", questionId: "multi" });
		expect(component.model.getOtherText("multi")).toBe("custom region");
		const output = stripAnsi(component.render(80).join("\n"));
		expect(output).toContain("Space toggle");
		expect(output).toContain("[▶ Regions]");
		component.handleInput("\x1b[C");
		expect(component.model.currentStep).toEqual({ kind: "question", questionId: "short" });
	});

	it("preserves cursor arrows inside text answers while Tab still changes pages", () => {
		const tui = createFakeTui(18);
		const component = new QuestionnaireComponent({
			tui,
			keybindings: new KeybindingsManager(),
			request: {
				version: 1,
				questions: [
					{ id: "text", kind: "short-text", prompt: "Text?", initialValue: "hello" },
					{ id: "next", kind: "confirm", prompt: "Next?" },
				],
			},
			getRows: () => tui.terminal.rows,
			requestRender: tui.requestRender,
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});

		component.handleInput("\x1b[D");
		component.handleInput("X");
		expect(component.model.getText("text")).toBe("hellXo");
		expect(component.model.currentStep).toEqual({ kind: "question", questionId: "text" });
		component.handleInput("\t");
		expect(component.model.currentStep).toEqual({ kind: "question", questionId: "next" });
	});

	it("uses the configured multi-select toggle key instead of hardcoding Space", () => {
		const tui = createFakeTui(18);
		const component = new QuestionnaireComponent({
			tui,
			keybindings: new KeybindingsManager({ "app.questionnaire.toggle": "ctrl+x" }),
			request: {
				version: 1,
				questions: [{ id: "multi", kind: "multi-select", prompt: "Pick", choices: [{ id: "x", label: "X" }] }],
			},
			getRows: () => tui.terminal.rows,
			requestRender: tui.requestRender,
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});

		component.handleInput(" ");
		expect(component.model.getState("multi")).toMatchObject({ choiceIds: [] });
		component.handleInput("\x18");
		expect(component.model.getState("multi")).toMatchObject({ choiceIds: ["x"] });
		expect(stripAnsi(component.render(80).join("\n"))).toContain("Ctrl+X toggle");
	});

	it("fills through keystrokes to zero reserved bytes and navigates review round trips without throwing", () => {
		const tui = createFakeTui(24);
		const component = new QuestionnaireComponent({
			tui,
			keybindings: new KeybindingsManager(),
			request: {
				version: 1,
				questions: ["d", "q1", "q2", "q3", "summary-notes"].map((id) => ({
					id,
					kind: "multiline-text" as const,
					prompt: "?",
				})),
			},
			getRows: () => tui.terminal.rows,
			requestRender: tui.requestRender,
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});
		for (let index = 0; index < 3; index++) {
			component.handleInput(`\x1b[200~${"x".repeat(128 * 1024)}\x1b[201~`);
			component.handleInput("\t");
		}
		component.handleInput(`\x1b[200~${"x".repeat(component.model.remainingBytes)}\x1b[201~`);
		expect(component.model.remainingBytes).toBe(0);
		expect(() => {
			component.handleInput("\t");
			component.handleInput("\t");
			component.handleInput("\x1b[Z");
			component.handleInput("\t");
		}).not.toThrow();
		expect(component.model.currentStep).toEqual({ kind: "review" });
		expect(component.model.remainingBytes).toBe(0);
	});

	it("keeps long wrapped choice content reachable by configured scrolling", () => {
		const tui = createFakeTui(16);
		const longRequest: ExtensionQuestionnaireRequestV1 = {
			version: 1,
			questions: [
				{
					id: "long-choice",
					kind: "single-select",
					prompt: "Choose",
					choices: [{ id: "one", label: `start ${"wrapped ".repeat(80)}TAIL` }],
				},
			],
		};
		const component = new QuestionnaireComponent({
			tui,
			keybindings: new KeybindingsManager(),
			request: longRequest,
			getRows: () => tui.terminal.rows,
			requestRender: tui.requestRender,
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});
		let rendered = "";
		for (let page = 0; page < 20 && !rendered.includes("TAIL"); page++) {
			const lines = component.render(28);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(28);
			rendered += stripAnsi(lines.join("\n"));
			component.handleInput("\x1b[6~");
		}
		expect(rendered).toContain("TAIL");
		expect(rendered).toMatch(/aggregate bytes\s+remaining/);
	});

	it("wraps long choice content, supports discard confirmation, and returns from subordinate Other", () => {
		const tui = createFakeTui(14);
		const dismiss = vi.fn();
		const component = new QuestionnaireComponent({
			tui,
			keybindings: new KeybindingsManager(),
			request,
			getRows: () => tui.terminal.rows,
			requestRender: tui.requestRender,
			onSubmit: vi.fn(),
			onDismiss: dismiss,
		});

		component.model.goToQuestion("single");
		component.render(34);
		for (let page = 0; page < 8; page++) {
			component.handleInput("\x1b[5~");
			component.render(34);
		}
		let output = stripAnsi(component.render(34).join("\n"));
		expect(output).toContain("Which rollout strategy should");
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput("\r");
		expect(component.isOtherEditorOpen).toBe(true);
		component.handleInput("custom");
		component.handleInput("\x1b");
		expect(component.isOtherEditorOpen).toBe(false);
		expect(component.model.getOtherText("single")).toBe("custom");

		component.handleInput("\x1b");
		output = stripAnsi(component.render(34).join("\n"));
		expect(output).toContain("Discard questionnaire draft?");
		expect(dismiss).not.toHaveBeenCalled();
		component.handleInput("\x1b[B");
		component.handleInput("\r");
		expect(dismiss).toHaveBeenCalledOnce();
	});

	it("keeps long text prompts scrollable while auto-anchoring the focused editor and accepted text", () => {
		for (const kind of ["short-text", "multiline-text"] as const) {
			const tui = createFakeTui(14);
			const component = new QuestionnaireComponent({
				tui,
				keybindings: new KeybindingsManager(),
				request: {
					version: 1,
					questions: [{ id: "text", kind, prompt: Array.from({ length: 30 }, (_, i) => `MARK${i}`).join("\n") }],
				},
				getRows: () => tui.terminal.rows,
				requestRender: tui.requestRender,
				onSubmit: vi.fn(),
				onDismiss: vi.fn(),
			});
			let output = stripAnsi(component.render(60).join("\n"));
			if (kind === "short-text") expect(output).toMatch(/>\s*$/m);
			component.handleInput("Z");
			output = stripAnsi(component.render(60).join("\n"));
			expect(output).toContain("Z");
			for (let page = 0; page < 10; page++) {
				component.handleInput("\x1b[5~");
				component.render(60);
			}
			expect(stripAnsi(component.render(60).join("\n"))).toContain("MARK0");
		}
	});

	it("anchors a multiline editor to its visible cursor row in an eight-row pane", () => {
		const tui = createFakeTui(8);
		const component = new QuestionnaireComponent({
			tui,
			keybindings: new KeybindingsManager(),
			request: {
				version: 1,
				questions: [
					{
						id: "text",
						kind: "multiline-text",
						prompt: Array.from({ length: 30 }, (_, index) => `PROMPT${index}`).join("\n"),
						initialValue: `${Array.from({ length: 8 }, (_, index) => `line${index}`).join("\n")}\nTAIL`,
					},
				],
			},
			getRows: () => tui.terminal.rows,
			requestRender: tui.requestRender,
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});
		component.focused = true;

		component.handleInput("Z");

		expect(stripAnsi(component.render(60).join("\n"))).toContain("TAILZ");
	});

	it.each([8, 10])("re-anchors both discard choices after deep scrolling at rows=%i", (rows) => {
		const tui = createFakeTui(rows);
		const dismiss = vi.fn();
		const component = new QuestionnaireComponent({
			tui,
			keybindings: new KeybindingsManager(),
			request: {
				version: 1,
				questions: [
					{
						id: "text",
						kind: "short-text",
						prompt: Array.from({ length: 40 }, (_, index) => `PROMPT${index}`).join("\n"),
					},
				],
			},
			getRows: () => tui.terminal.rows,
			requestRender: tui.requestRender,
			onSubmit: vi.fn(),
			onDismiss: dismiss,
		});
		component.handleInput("draft");
		component.render(20);
		for (let page = 0; page < 8; page++) {
			component.handleInput("\x1b[6~");
			component.render(20);
		}
		component.handleInput("\x1b[5~");
		component.render(20);

		component.handleInput("\x1b");
		expect((component as unknown as { manualScrollOffset?: number }).manualScrollOffset).toBeUndefined();
		let output = stripAnsi(component.render(20).join("\n"));
		expect(output).toContain("Keep editing");
		expect(output).toContain("Discard");
		component.handleInput("\x1b[B");
		expect((component as unknown as { manualScrollOffset?: number }).manualScrollOffset).toBeUndefined();
		output = stripAnsi(component.render(20).join("\n"));
		expect(output).toContain("Keep editing");
		expect(output).toContain("Discard");
		component.handleInput("\r");
		expect(dismiss).toHaveBeenCalledOnce();
	});

	it.each([10, 12, 14, 16])("reaches every wrapped prompt line in monotone up and down sweeps at rows=%i", (rows) => {
		for (const width of [20, 40, 80]) {
			const tui = createFakeTui(rows);
			const markers = Array.from({ length: 40 }, (_, index) => `MARK${index}`);
			const component = new QuestionnaireComponent({
				tui,
				keybindings: new KeybindingsManager(),
				request: {
					version: 1,
					questions: [
						{
							id: "q",
							kind: "single-select",
							prompt: markers.join("\n"),
							choices: [{ id: "x", label: "X" }],
						},
					],
				},
				getRows: () => tui.terminal.rows,
				requestRender: tui.requestRender,
				onSubmit: vi.fn(),
				onDismiss: vi.fn(),
			});
			const sweep = (key: string): Set<number> => {
				const seen = new Set<number>();
				for (let page = 0; page < 80; page++) {
					const output = stripAnsi(component.render(width).join("\n"));
					for (const match of output.matchAll(/\bMARK(\d+)\b/gu)) seen.add(Number(match[1]));
					component.handleInput(key);
				}
				return seen;
			};
			const upward = sweep("\x1b[5~");
			const downward = sweep("\x1b[6~");
			for (const index of markers.keys()) {
				expect(upward, `${rows}x${width} upward sweep missing MARK${index}`).toContain(index);
				expect(downward, `${rows}x${width} downward sweep missing MARK${index}`).toContain(index);
			}
		}
	});

	it("degrades 32 long tabs before hiding the active prompt in a ten-row pane", () => {
		const tui = createFakeTui(10);
		const component = new QuestionnaireComponent({
			tui,
			keybindings: new KeybindingsManager(),
			request: {
				version: 1,
				questions: Array.from({ length: 32 }, (_, index) => ({
					id: `q${index}`,
					label: `Question-${index}-${"very-long-label-".repeat(4)}`,
					kind: "confirm" as const,
					prompt: index === 0 ? "ACTIVE PROMPT" : "Other",
				})),
			},
			getRows: () => tui.terminal.rows,
			requestRender: tui.requestRender,
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});
		const output = stripAnsi(component.render(96).join("\n"));
		expect(output).toContain("ACTIVE PROMPT");
		expect(output).toContain("[1/32]");
		const narrow = stripAnsi(component.render(20).join("\n"));
		expect(narrow).toContain("ACTIVE PROMPT");
		expect(narrow).toMatch(/1\/32/);
	});

	it("appends to seeded short text and reopened Other through keystrokes", () => {
		const tui = createFakeTui(20);
		const seeded = new QuestionnaireComponent({
			tui,
			keybindings: new KeybindingsManager(),
			request: { version: 1, questions: [{ id: "short", kind: "short-text", prompt: "?", initialValue: "alpha" }] },
			getRows: () => tui.terminal.rows,
			requestRender: tui.requestRender,
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});
		seeded.handleInput("X");
		expect(seeded.model.getText("short")).toBe("alphaX");

		const other = new QuestionnaireComponent({
			tui,
			keybindings: new KeybindingsManager(),
			request: {
				version: 1,
				questions: [
					{ id: "single", kind: "single-select", prompt: "?", choices: [{ id: "x", label: "X" }], other: {} },
				],
			},
			getRows: () => tui.terminal.rows,
			requestRender: tui.requestRender,
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});
		other.handleInput("\x1b[B");
		other.handleInput("\r");
		other.handleInput("\x1b");
		other.model.setOther("single", "seed");
		other.handleInput("\r");
		other.handleInput("X");
		expect(other.model.getOtherText("single")).toBe("seedX");
	});

	it("drives all five kinds, Other, submission, and over-budget rejection through configured keys", () => {
		const tui = createFakeTui(24);
		const submit = vi.fn();
		const component = new QuestionnaireComponent({
			tui,
			keybindings: new KeybindingsManager({ "app.questionnaire.next": "ctrl+n" }),
			request,
			getRows: () => tui.terminal.rows,
			requestRender: tui.requestRender,
			onSubmit: submit,
			onDismiss: vi.fn(),
		});
		component.handleInput("\r");
		component.handleInput("\x0e");
		component.handleInput("\r");
		component.handleInput("\x0e");
		component.handleInput(" ");
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput(" ");
		component.handleInput("custom");
		component.handleInput("\x1b");
		component.handleInput("\x0e");
		component.handleInput("X");
		component.handleInput("\x0e");
		component.handleInput("notes");
		component.handleInput("\x0e");
		component.handleInput("\x0e");
		component.handleInput("\r");
		expect(submit).toHaveBeenCalledOnce();
		expect(submit.mock.calls[0]?.[0]).toMatchObject({ status: "submitted" });

		const budget = new QuestionnaireComponent({
			tui,
			keybindings: new KeybindingsManager(),
			request: { version: 1, questions: [{ id: "text", kind: "multiline-text", prompt: "?" }] },
			getRows: () => tui.terminal.rows,
			requestRender: tui.requestRender,
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});
		budget.handleInput(`\x1b[200~${"x".repeat(128 * 1024 + 1)}\x1b[201~`);
		expect(budget.model.getText("text")).toBe("");
		expect(budget.model.validationMessage).toMatch(/128 KiB/);
	});

	it("keeps field validation and useful body capacity visible in a narrow ten-row pane", () => {
		const tui = createFakeTui(10);
		const component = new QuestionnaireComponent({
			tui,
			keybindings: new KeybindingsManager(),
			request: { version: 1, questions: [{ id: "text", kind: "multiline-text", prompt: "ACTIVE" }] },
			getRows: () => tui.terminal.rows,
			requestRender: tui.requestRender,
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});
		component.handleInput(`\x1b[200~${"x".repeat(128 * 1024 + 1)}\x1b[201~`);
		component.render(20);
		for (let page = 0; page < 10; page++) component.handleInput("\x1b[5~");
		const output = stripAnsi(component.render(20).join("\n"));
		expect(output).toContain("ACTIVE");
		expect(output).toMatch(/128\s+KiB/);
		expect(component.render(20)).toHaveLength(10);
	});

	it.each([1, 2, 3, 4, 5])("preserves validation and available footer feedback in a tiny %i-row pane", (rows) => {
		const tui = createFakeTui(rows);
		const component = new QuestionnaireComponent({
			tui,
			keybindings: new KeybindingsManager(),
			request: { version: 1, questions: [{ id: "text", kind: "multiline-text", prompt: "ACTIVE" }] },
			getRows: () => tui.terminal.rows,
			requestRender: tui.requestRender,
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});
		component.handleInput(`\x1b[200~${"x".repeat(128 * 1024 + 1)}\x1b[201~`);

		const lines = component.render(80);
		const output = stripAnsi(lines.join("\n"));
		expect(lines).toHaveLength(rows);
		expect(output).toMatch(/128\s+KiB/);
		if (rows >= 2) expect(output).toMatch(/aggregate bytes remaining/);
	});

	it("uses injected keybindings for footer hints", () => {
		setKeybindings(new KeybindingsManager());
		const tui = createFakeTui(20);
		const component = new QuestionnaireComponent({
			tui,
			keybindings: new KeybindingsManager({
				"app.questionnaire.next": "ctrl+n",
				"app.questionnaire.previous": "ctrl+p",
			}),
			request: { version: 1, questions: [{ id: "q", kind: "confirm", prompt: "?" }] },
			getRows: () => tui.terminal.rows,
			requestRender: tui.requestRender,
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});
		const output = stripAnsi(component.render(80).join("\n"));
		expect(output).toContain("Ctrl+N");
		expect(output).toContain("Ctrl+P");
		expect(output).not.toContain("Tab next");
	});

	it("bounds review previews explicitly while keeping full text reachable by Edit", () => {
		const tui = createFakeTui(20);
		const previewRequest: ExtensionQuestionnaireRequestV1 = {
			version: 1,
			questions: [{ id: "text", kind: "multiline-text", prompt: "?" }],
		};
		const source = new QuestionnaireDraftModel(previewRequest);
		source.updateText("text", `${"A".repeat(120 * 1024)}TAIL`);
		source.goToReview();
		const component = new QuestionnaireComponent({
			tui,
			keybindings: new KeybindingsManager(),
			request: previewRequest,
			initialDraft: source.draft,
			getRows: () => tui.terminal.rows,
			requestRender: tui.requestRender,
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});
		const output = stripAnsi(component.render(80).join("\n"));
		expect(output).toContain("… Edit to view full");
		expect(output).not.toContain("TAIL");
		expect(output.length).toBeLessThan(5000);
		component.handleInput("\r");
		expect(stripAnsi(component.render(80).join("\n"))).toContain("TAIL");
	});

	it("clears private request, draft, editor, and Other buffers on disposal", () => {
		const tui = createFakeTui(20);
		const component = new QuestionnaireComponent({
			tui,
			keybindings: new KeybindingsManager(),
			request: {
				version: 1,
				title: "private title",
				questions: [{ id: "text", kind: "multiline-text", prompt: "private prompt" }],
			},
			getRows: () => tui.terminal.rows,
			requestRender: tui.requestRender,
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});
		component.handleInput("private answer");
		component.dispose();
		expect(() => component.model.getText("text")).toThrow(/disposed/i);
		expect(() => component.model.draft).toThrow(/disposed/i);
		expect(() => component.model.request).toThrow(/disposed/i);
	});

	it("rehydrates authoritative drafts without echo and emits accepted local draft changes", () => {
		const tui = createFakeTui(24);
		const source = new QuestionnaireDraftModel(request);
		source.answerConfirm("confirm", "other");
		source.setOther("confirm", "because");
		source.answerSingle("single", { kind: "choice", choiceId: "blue" });
		source.toggleMultiChoice("multi", "east");
		source.setOther("multi", "remote");
		source.updateText("short", "restored short");
		source.updateText("long", "restored\nmultiline");
		source.goToQuestion("long");
		const initialDraft = source.draft;
		const onDraftChange = vi.fn();
		const component = new QuestionnaireComponent({
			tui,
			keybindings: new KeybindingsManager(),
			request,
			initialDraft,
			onDraftChange,
			getRows: () => tui.terminal.rows,
			requestRender: tui.requestRender,
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});
		expect(component.model.draft).toEqual(initialDraft);
		expect(onDraftChange).not.toHaveBeenCalled();

		const authoritative = new QuestionnaireDraftModel(request);
		authoritative.updateText("short", "authoritative");
		authoritative.updateText("long", "server text");
		authoritative.goToReview();
		component.applyDraft(authoritative.draft);
		expect(component.model.draft).toEqual(authoritative.draft);
		expect(onDraftChange).not.toHaveBeenCalled();
		component.model.goToQuestion("short");
		component.applyDraft({ ...component.model.draft, currentStep: { kind: "question", questionId: "short" } });
		component.handleInput("X");
		expect(component.model.getText("short")).toBe("authoritativeX");
		expect(onDraftChange).toHaveBeenCalledOnce();
	});
});

describe("InteractiveQuestionnaireHost", () => {
	it("settles abort once, disposes the overlay, and lets the TUI restore prior focus once", async () => {
		const previousFocus: Component & Focusable = {
			focused: true,
			render: () => [],
			invalidate: () => {},
		};
		let overlay: (Component & Focusable) | undefined;
		const hide = vi.fn(() => {
			if (overlay) overlay.focused = false;
			previousFocus.focused = true;
		});
		const tui = {
			terminal: { rows: 24 },
			requestRender: vi.fn(),
			showOverlay: vi.fn((component: Component) => {
				previousFocus.focused = false;
				overlay = component as Component & Focusable;
				overlay.focused = true;
				return {
					hide,
					setHidden: vi.fn(),
					isHidden: () => false,
					focus: vi.fn(),
					unfocus: vi.fn(),
					isFocused: () => true,
				} satisfies OverlayHandle;
			}),
		} as unknown as TUI;
		const host = new InteractiveQuestionnaireHost(tui, new KeybindingsManager());
		const controller = new AbortController();
		const outcome = host.questionnaire(request, { signal: controller.signal });
		controller.abort();

		await expect(outcome).resolves.toEqual({ status: "aborted", reason: "signal" });
		expect(hide).toHaveBeenCalledOnce();
		expect(previousFocus.focused).toBe(true);
		controller.abort();
		expect(hide).toHaveBeenCalledOnce();
	});

	it("queues concurrent requests FIFO without overlay stacking and aborts queued requests without presenting", async () => {
		const overlays: Array<Component & { handleInput(data: string): void }> = [];
		const hides: Array<ReturnType<typeof vi.fn>> = [];
		const tui = {
			terminal: { rows: 24 },
			requestRender: vi.fn(),
			showOverlay: vi.fn((component: Component) => {
				overlays.push(component as Component & { handleInput(data: string): void });
				const hide = vi.fn();
				hides.push(hide);
				return {
					hide,
					setHidden: vi.fn(),
					isHidden: () => false,
					focus: vi.fn(),
					unfocus: vi.fn(),
					isFocused: () => true,
				} satisfies OverlayHandle;
			}),
		} as unknown as TUI;
		const host = new InteractiveQuestionnaireHost(tui, new KeybindingsManager());
		const blank: ExtensionQuestionnaireRequestV1 = {
			version: 1,
			questions: [{ id: "q", kind: "confirm", prompt: "?" }],
		};
		let firstSettled = false;
		const first = host.request(blank).then((outcome) => {
			firstSettled = true;
			return outcome;
		});
		const secondController = new AbortController();
		const second = host.request(blank, { signal: secondController.signal });
		await Promise.resolve();
		expect(firstSettled).toBe(false);
		expect(overlays).toHaveLength(1);
		secondController.abort();
		await expect(second).resolves.toEqual({ status: "aborted", reason: "signal" });
		expect(overlays).toHaveLength(1);
		overlays[0]!.handleInput("\x1b");
		await expect(first).resolves.toEqual({ status: "dismissed" });
		expect(hides[0]).toHaveBeenCalledOnce();

		const third = host.request(blank);
		const fourth = host.request(blank);
		expect(overlays).toHaveLength(2);
		overlays[1]!.handleInput("\x1b");
		await expect(third).resolves.toEqual({ status: "dismissed" });
		expect(overlays).toHaveLength(3);
		overlays[2]!.handleInput("\x1b");
		await expect(fourth).resolves.toEqual({ status: "dismissed" });
	});

	it("returns a rejected promise for invalid requests without throwing synchronously", async () => {
		const tui = {
			terminal: { rows: 24 },
			requestRender: vi.fn(),
			showOverlay: vi.fn(),
		} as unknown as TUI;
		const host = new InteractiveQuestionnaireHost(tui, new KeybindingsManager());
		const invalid = { version: 1, questions: [] } as ExtensionQuestionnaireRequestV1;
		let result: Promise<unknown> | undefined;

		expect(() => {
			result = host.request(invalid);
		}).not.toThrow();
		await expect(result).rejects.toThrow(/questions/i);
		expect(tui.showOverlay).not.toHaveBeenCalled();
	});

	it.each(["extension-reload", "runtime-replaced", "session-completed"] as const)(
		"settles active and queued requests exactly once for %s",
		async (reason) => {
			const hide = vi.fn();
			const tui = {
				terminal: { rows: 24 },
				requestRender: vi.fn(),
				showOverlay: vi.fn(
					() =>
						({
							hide,
							setHidden: vi.fn(),
							isHidden: () => false,
							focus: vi.fn(),
							unfocus: vi.fn(),
							isFocused: () => true,
						}) satisfies OverlayHandle,
				),
			} as unknown as TUI;
			const host = new InteractiveQuestionnaireHost(tui, new KeybindingsManager());
			const active = host.request(request);
			const queued = host.request(request);
			host.terminate(reason);
			await expect(active).resolves.toEqual({ status: "terminated", reason });
			await expect(queued).resolves.toEqual({ status: "terminated", reason });
			expect(hide).toHaveBeenCalledOnce();
			expect(tui.showOverlay).toHaveBeenCalledOnce();
		},
	);
});

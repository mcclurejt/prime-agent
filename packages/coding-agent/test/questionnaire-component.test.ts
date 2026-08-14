import {
	type Component,
	CURSOR_MARKER,
	clearDefaultTerminalColors,
	type Focusable,
	type OverlayHandle,
	setDefaultTerminalColors,
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
import type {
	ExtensionQuestionnaireDraftV2,
	ExtensionQuestionnaireRequestV1,
	ExtensionQuestionnaireRequestV2,
} from "../src/core/extensions/types.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { QuestionnaireComponent } from "../src/modes/interactive/components/questionnaire.js";
import { QuestionnaireDraftModel } from "../src/modes/interactive/questionnaire-draft-model.js";
import { InteractiveQuestionnaireHost } from "../src/modes/interactive/questionnaire-host.js";
import { initTheme, setThemeInstance, Theme, theme } from "../src/modes/interactive/theme/theme.js";

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
			other: { label: "Custom test answer" },
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
		expect(wide).toContain("[▶ 1]");
		expect(wide).toContain("[· 2]");
		expect(wide).toContain("[  Review]");
		expect(wide.split("\n").filter((line) => line.includes("[▶ 1]"))).toHaveLength(1);

		const narrowLines = component.render(60);
		expect(stripAnsi(narrowLines.join("\n"))).toContain("Question 1 of 5 · Approval");
		expect(narrowLines.length).toBeLessThanOrEqual(18);
		for (const line of narrowLines) expect(visibleWidth(line)).toBeLessThanOrEqual(60);

		for (let index = 0; index < request.questions.length; index++) component.handleInput("\x0e");
		expect(stripAnsi(component.render(96).join("\n"))).toContain("[▶ Review]");
		expect(submit).not.toHaveBeenCalled();
		component.handleInput("\x1b[A");
		expect(stripAnsi(component.render(96).join("\n"))).toContain("▶ Notes");
		component.handleInput("\x0e");
		component.handleInput("\r");
		expect(submit).toHaveBeenCalledWith({ status: "submitted", responses: expect.any(Array) });
		component.handleInput("\x10");
		expect(component.model.currentStep).toEqual({ kind: "question", questionId: "long" });
	});

	it("uses Enter or Space for multi-select toggles and left/right arrows for persistent page navigation", () => {
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
		expect(component.model.getState("multi")).toMatchObject({ choiceIds: ["east"] });
		component.handleInput("\r");
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
		expect(output).toContain("Space/Enter toggle");
		expect(output).toContain("[▶ 3]");
		expect(output).toContain("custom region");
		expect(output).not.toContain("Custom test answer");
		component.handleInput(" ");
		const deselectedOutput = stripAnsi(component.render(80).join("\n"));
		expect(deselectedOutput).toContain("Custom test answer");
		expect(deselectedOutput).not.toContain("custom region");
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
		expect(stripAnsi(component.render(80).join("\n"))).toContain("Ctrl+X/Enter toggle");
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
			const lines = component.render(60);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
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
		component.render(60);
		for (let page = 0; page < 8; page++) {
			component.handleInput("\x1b[5~");
			component.render(60);
		}
		let output = stripAnsi(component.render(60).join("\n"));
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
		output = stripAnsi(component.render(60).join("\n"));
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

	it("anchors a multiline editor at the responsive height floor", () => {
		const tui = createFakeTui(12);
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

	it.each([12, 14])("re-anchors both discard choices after deep scrolling at rows=%i", (rows) => {
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
		component.render(60);
		for (let page = 0; page < 8; page++) {
			component.handleInput("\x1b[6~");
			component.render(60);
		}
		component.handleInput("\x1b[5~");
		component.render(60);

		component.handleInput("\x1b");
		expect((component as unknown as { manualScrollOffset?: number }).manualScrollOffset).toBeUndefined();
		let output = stripAnsi(component.render(60).join("\n"));
		expect(output).toContain("Keep editing");
		expect(output).toContain("Discard");
		component.handleInput("\x1b[B");
		expect((component as unknown as { manualScrollOffset?: number }).manualScrollOffset).toBeUndefined();
		output = stripAnsi(component.render(60).join("\n"));
		expect(output).toContain("Keep editing");
		expect(output).toContain("Discard");
		component.handleInput("\r");
		expect(dismiss).toHaveBeenCalledOnce();
	});

	it.each([12, 14, 16, 18])("reaches every wrapped prompt line in monotone up and down sweeps at rows=%i", (rows) => {
		for (const width of [60, 70, 80]) {
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

	it("degrades 32 long tabs before hiding the active prompt at the height floor", () => {
		const tui = createFakeTui(12);
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
		expect(output).toContain("[▶ 1]");
		expect(output.split("\n").filter((line) => line.includes("[▶ 1]"))).toHaveLength(1);
		component.model.goToQuestion("q16");
		const middleLines = component.render(64);
		const middle = stripAnsi(middleLines.join("\n"));
		expect(middle).toContain("[▶ 17]");
		expect(middle).toMatch(/… \d+ more/);
		expect(middle.split("\n").filter((line) => line.includes("[▶ 17]"))).toHaveLength(1);
		for (const line of middleLines) expect(visibleWidth(line)).toBeLessThanOrEqual(64);

		(tui.terminal as { rows: number }).rows = 24;
		component.model.goToReview();
		const review = stripAnsi(component.render(64).join("\n"));
		expect(review).toContain("[▶ Review]");
		expect(review.split("\n").filter((line) => line.includes("[▶ Review]"))).toHaveLength(1);

		component.model.goToQuestion("q0");
		const narrowLines = component.render(60);
		const narrow = stripAnsi(narrowLines.join("\n"));
		expect(narrow).toContain("ACTIVE PROMPT");
		expect(narrow).toMatch(/1 of 32/);
		for (const line of narrowLines) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
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

	it("keeps field validation and useful body capacity visible at the responsive floor", () => {
		const tui = createFakeTui(12);
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
		component.render(60);
		for (let page = 0; page < 10; page++) component.handleInput("\x1b[5~");
		const output = stripAnsi(component.render(60).join("\n"));
		expect(output).toContain("ACTIVE");
		expect(output).toMatch(/128\s+KiB/);
		expect(component.render(60)).toHaveLength(12);
	});

	it.each([1, 2, 3, 4, 5])("renders only resize and essential guidance in a tiny %i-row pane", (rows) => {
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
		expect(lines.length).toBeLessThanOrEqual(rows);
		expect(output).toContain("Resize terminal to continue");
		expect(output).not.toContain("ACTIVE");
		if (rows >= 2) expect(output).toMatch(/128\s+KiB/);
		if (rows >= 3) expect(output).toContain("Esc dismiss");
		if (rows >= 4) expect(output).toMatch(/aggregate bytes remaining/);
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

	it("uses only contextual footer chips before the byte-status line", () => {
		const tui = createFakeTui(12);
		const component = new QuestionnaireComponent({
			tui,
			keybindings: new KeybindingsManager(),
			request: {
				version: 1,
				questions: [
					{ id: "q", kind: "confirm", prompt: Array.from({ length: 12 }, () => "Long prompt").join(" ") },
				],
			},
			getRows: () => tui.terminal.rows,
			requestRender: tui.requestRender,
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});
		const output = stripAnsi(component.render(60).join("\n"));
		const normalized = output.replace(/\s+/gu, " ");
		expect(normalized).toContain("Enter select");
		expect(normalized).toContain("Shift+Tab/Tab page");
		expect(normalized).toContain("Esc dismiss");
		expect(normalized).toContain("PageUp/PageDown scroll");
		expect(normalized).toContain("↑/↓ move");
		expect(normalized.indexOf("Enter select")).toBeLessThan(normalized.indexOf("aggregate bytes remaining"));
	});

	it("uses the responsive floor instead of compressing unusable frames", () => {
		const tui = createFakeTui(24);
		const component = new QuestionnaireComponent({
			tui,
			keybindings: new KeybindingsManager(),
			request: { version: 2, questions: [{ id: "q", kind: "confirm", prompt: "Choose" }] },
			getRows: () => tui.terminal.rows,
			requestRender: tui.requestRender,
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});

		const tooNarrow = component.render(59);
		expect(stripAnsi(tooNarrow.join("\n"))).toContain("Resize terminal to continue");
		expect(tooNarrow.every((line) => visibleWidth(line) === 59)).toBe(true);
		expect(stripAnsi(component.render(60).join("\n"))).toContain("Choose");
		(tui.terminal as { rows: number }).rows = 11;
		expect(stripAnsi(component.render(100).join("\n"))).toContain("Resize terminal to continue");
	});

	it.each([
		{ name: "a choice question without a preview", kind: "confirm" as const },
		{ name: "a text question", kind: "short-text" as const },
		{ name: "Review", kind: "review" as const },
	])("owns the full 200x40 workspace for $name", ({ kind }) => {
		const tui = createFakeTui(40);
		const question =
			kind === "short-text"
				? ({ id: "q", kind, prompt: "Explain" } as const)
				: ({ id: "q", kind: "confirm", prompt: "Approve?" } as const);
		const component = new QuestionnaireComponent({
			tui,
			keybindings: new KeybindingsManager(),
			request: { version: 1, title: "Workspace questionnaire", questions: [question] },
			getRows: () => tui.terminal.rows,
			requestRender: tui.requestRender,
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});
		if (kind === "review") component.model.goToReview();

		const lines = component.render(200);
		expect(lines).toHaveLength(40);
		expect(stripAnsi(lines[0] ?? "")).toContain("Workspace questionnaire");
		expect(stripAnsi(lines.at(-1) ?? "")).toContain("aggregate bytes remaining");
		expect(lines.every((line) => visibleWidth(line) === 200)).toBe(true);
	});

	it("renders the focused Submit action with an actual high-contrast light-theme background", () => {
		setDefaultTerminalColors({ foreground: { r: 24, g: 24, b: 24 }, background: { r: 255, g: 255, b: 255 } });
		initTheme("light");
		const previousNoColor = process.env.NO_COLOR;
		delete process.env.NO_COLOR;
		try {
			const tui = createFakeTui(40);
			const component = new QuestionnaireComponent({
				tui,
				keybindings: new KeybindingsManager(),
				request: { version: 1, questions: [{ id: "q", kind: "confirm", prompt: "Approve?" }] },
				getRows: () => tui.terminal.rows,
				requestRender: tui.requestRender,
				onSubmit: vi.fn(),
				onDismiss: vi.fn(),
			});
			component.model.goToReview();

			const actionLine = component.render(200).find((line) => stripAnsi(line).includes("Submit answers"));
			const adaptiveAccentProbe = theme.getAdaptiveAccentColor()("probe");
			const adaptiveAccentOpening = adaptiveAccentProbe.slice(0, adaptiveAccentProbe.indexOf("probe"));
			expect(adaptiveAccentOpening).toContain("\x1b[");
			expect(actionLine).toContain("\x1b[7m");
			expect(actionLine).toContain(adaptiveAccentOpening);
			expect(stripAnsi(actionLine ?? "")).toContain("▶ [ Submit answers ]");
		} finally {
			if (previousNoColor === undefined) delete process.env.NO_COLOR;
			else process.env.NO_COLOR = previousNoColor;
			clearDefaultTerminalColors();
			initTheme("dark");
		}
	});

	it("focuses the filled Review submit action by default and keeps it visible at 60 and 80 columns", () => {
		const tui = createFakeTui(24);
		const onSubmit = vi.fn();
		const component = new QuestionnaireComponent({
			tui,
			keybindings: new KeybindingsManager(),
			request: {
				version: 2,
				submitLabel: `Submit this deliberately long answer ${"now ".repeat(20)}`,
				questions: [
					{
						id: "q",
						label: `Question ${"very long ".repeat(11)}`,
						kind: "confirm",
						prompt: "Choose",
					},
				],
			},
			getRows: () => tui.terminal.rows,
			requestRender: tui.requestRender,
			onSubmit,
			onDismiss: vi.fn(),
		});
		component.handleInput("\r");
		component.handleInput("\t");
		const previousNoColor = process.env.NO_COLOR;
		delete process.env.NO_COLOR;
		try {
			const adaptiveAccentProbe = theme.getAdaptiveAccentColor()("probe");
			const adaptiveAccentOpening = adaptiveAccentProbe.slice(0, adaptiveAccentProbe.indexOf("probe"));
			for (const width of [60, 80]) {
				const actionLine = component.render(width).find((line) => stripAnsi(line).includes("Submit this"));
				expect(stripAnsi(actionLine ?? "")).toContain("▶ [ Submit this");
				expect(stripAnsi(actionLine ?? "")).not.toContain("Edit");
				expect(actionLine).toContain("\x1b[7m");
				expect(actionLine).toContain(adaptiveAccentOpening);
				expect(visibleWidth(actionLine ?? "")).toBe(width);
			}
			component.handleInput("\x1b[A");
			const unfocusedAction = component.render(80).find((line) => stripAnsi(line).includes("Submit this"));
			expect(stripAnsi(unfocusedAction ?? "")).not.toContain("▶ [");
			expect(unfocusedAction).toContain("\x1b[7m");
			expect(unfocusedAction).toContain(adaptiveAccentOpening);
			component.handleInput("\x1b[B");
			component.handleInput("\r");
			expect(onSubmit).toHaveBeenCalledOnce();
		} finally {
			if (previousNoColor === undefined) delete process.env.NO_COLOR;
			else process.env.NO_COLOR = previousNoColor;
		}
	});

	it("routes Review between Submit, summary editing, and the last question with live footer guidance", () => {
		const tui = createFakeTui(24);
		const component = new QuestionnaireComponent({
			tui,
			keybindings: new KeybindingsManager(),
			request: {
				version: 1,
				questions: [
					{ id: "first", label: "First", kind: "confirm", prompt: "First?" },
					{ id: "second", label: "Second", kind: "confirm", prompt: "Second?" },
				],
			},
			getRows: () => tui.terminal.rows,
			requestRender: tui.requestRender,
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});
		component.model.goToReview();

		let review = stripAnsi(component.render(80).join("\n"));
		expect(review).toContain("▶ [ Submit answers ]");
		expect(review).toContain("Enter submit");
		expect(review).toContain("↑ inspect answers");
		expect(review).not.toContain("Edit answers");
		expect(review).not.toContain(" preview");
		expect(review).not.toContain(" note");

		component.handleInput("\x1b[A");
		review = stripAnsi(component.render(80).join("\n"));
		expect(review).toContain("▶ Second");
		expect(review).toContain("Enter edit");
		expect(review).toContain("↓ submit");
		expect(review).not.toContain("▶ [ Submit answers ]");
		expect(review).toContain("[ Submit answers ]");

		component.handleInput("\r");
		expect(component.model.currentStep).toEqual({ kind: "question", questionId: "second" });
		component.handleInput("\t");
		expect(component.model.currentStep).toEqual({ kind: "review" });
		expect(stripAnsi(component.render(80).join("\n"))).toContain("▶ [ Submit answers ]");

		component.handleInput("\x1b[A");
		component.handleInput("\x1b[B");
		expect(stripAnsi(component.render(80).join("\n"))).toContain("▶ [ Submit answers ]");
		component.handleInput("\x1b[D");
		expect(component.model.currentStep).toEqual({ kind: "question", questionId: "second" });

		component.handleInput("\t");
		component.handleInput("\x1b[A");
		component.handleInput("\x1b[D");
		expect(component.model.currentStep).toEqual({ kind: "question", questionId: "second" });
	});

	it("uses a padded semantic selection surface with terminal-defined basic ANSI colors", () => {
		setThemeInstance(
			new Theme(
				{
					text: 7,
					accent: 6,
					dim: 8,
					muted: 8,
					success: 2,
					warning: 3,
					error: 1,
				} as ConstructorParameters<typeof Theme>[0],
				{ selectedBg: 0 } as ConstructorParameters<typeof Theme>[1],
				"256color",
			),
		);
		const previousNoColor = process.env.NO_COLOR;
		delete process.env.NO_COLOR;
		try {
			const tui = createFakeTui(20);
			const component = new QuestionnaireComponent({
				tui,
				keybindings: new KeybindingsManager(),
				request: { version: 1, questions: [{ id: "q", kind: "confirm", prompt: "Choose" }] },
				getRows: () => tui.terminal.rows,
				requestRender: tui.requestRender,
				onSubmit: vi.fn(),
				onDismiss: vi.fn(),
			});
			const lines = component.render(80);
			const focused = lines.find((line) => stripAnsi(line).includes("▶ ○ Yes"));
			expect(focused).toContain("\x1b[48;5;0m");
			expect(focused).not.toMatch(/\x1b\[(?:38|48);2;/u);
			expect(visibleWidth(focused ?? "")).toBe(80);
			expect(stripAnsi(focused ?? "")).toMatch(/^ {2}▶ ○ Yes +$/u);
		} finally {
			if (previousNoColor === undefined) delete process.env.NO_COLOR;
			else process.env.NO_COLOR = previousNoColor;
			initTheme("dark");
		}
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
		component.handleInput("\x1b[A");
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
	it("keeps preview actions safe on v1/v2 Other rows and avoids empty wide preview panes", () => {
		for (const version of [1, 2] as const) {
			const tui = createFakeTui(24);
			const component = new QuestionnaireComponent({
				tui,
				keybindings: new KeybindingsManager(),
				request:
					version === 1
						? {
								version,
								questions: [
									{
										id: "q",
										kind: "single-select",
										prompt: "Pick",
										choices: [{ id: "a", label: "A" }],
										other: {},
									},
								],
							}
						: {
								version,
								questions: [
									{ id: "q", kind: "single-select", prompt: "Pick", choices: [{ id: "a", label: "A" }] },
								],
							},
				getRows: () => tui.terminal.rows,
				requestRender: tui.requestRender,
				onSubmit: vi.fn(),
				onDismiss: vi.fn(),
			});
			expect(stripAnsi(component.render(144).join("\n"))).not.toContain("No preview for active choice");
			component.handleInput("\x1b[B");
			expect(() => component.handleInput("p")).not.toThrow();
		}
	});

	it("keeps v2 multiline paging usable and refuses invisible note editing on Review", () => {
		const tui = createFakeTui(24);
		const submit = vi.fn();
		const component = new QuestionnaireComponent({
			tui,
			keybindings: new KeybindingsManager(),
			request: { version: 2, questions: [{ id: "text", kind: "multiline-text", prompt: "Explain" }] },
			getRows: () => tui.terminal.rows,
			requestRender: tui.requestRender,
			onSubmit: submit,
			onDismiss: vi.fn(),
		});
		component.handleInput("n");
		expect(component.model.getText("text")).toBe("n");
		component.handleInput("\t");
		expect(component.model.currentStep).toEqual({ kind: "review" });
		component.handleInput("n");
		expect(component.isNoteEditorOpen).toBe(false);
		const review = stripAnsi(component.render(80).join("\n"));
		expect(review).not.toContain("N note");
		expect(review).not.toContain("P preview");
		component.handleInput("\x1b[C");
		component.handleInput("\r");
		expect(submit).toHaveBeenCalledOnce();
	});

	it("clips fenced context/detail code and changes previews with the cursor without selecting", () => {
		const tui = createFakeTui(24);
		const component = new QuestionnaireComponent({
			tui,
			keybindings: new KeybindingsManager(),
			request: {
				version: 2,
				questions: [
					{
						id: "q",
						kind: "single-select",
						prompt: "Pick",
						context: `\`\`\`text\n${"C".repeat(100)}\n\`\`\``,
						choices: [
							{
								id: "a",
								label: "A",
								detail: `\`\`\`text\n${"D".repeat(100)}\n\`\`\``,
								preview: { markdown: "first", alt: "first alt" },
							},
							{ id: "b", label: "B", preview: { markdown: "second", alt: "second alt" } },
						],
					},
				],
			},
			getRows: () => tui.terminal.rows,
			requestRender: tui.requestRender,
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});
		let output = stripAnsi(component.render(144).join("\n"));
		expect(output).toContain("[horizontal content clipped]");
		expect(output).toContain("first");
		component.handleInput("\x1b[B");
		output = stripAnsi(component.render(144).join("\n"));
		expect(output).toContain("second");
		expect(component.model.responses()[0]).toEqual({ questionId: "q", status: "unanswered" });
	});

	it("anchors only the active choice preview without shifting the wide workspace shell", () => {
		const tui = createFakeTui(40);
		const component = new QuestionnaireComponent({
			tui,
			keybindings: new KeybindingsManager(),
			request: {
				version: 2,
				questions: [
					{
						id: "mixed",
						kind: "single-select",
						prompt: "Choose",
						choices: [
							{ id: "visual", label: "Visual", preview: { markdown: "visual-only", alt: "Visual option" } },
							{ id: "text", label: "Text tradeoff", description: "Lower operational risk." },
						],
					},
				],
			},
			getRows: () => tui.terminal.rows,
			requestRender: tui.requestRender,
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});

		const visualLines = component.render(200);
		const visual = stripAnsi(visualLines.join("\n"));
		const previewRow = visualLines.findIndex((line) => stripAnsi(line).includes("Preview"));
		const shellPositions = (lines: string[]) => ({
			header: lines.findIndex((line) => stripAnsi(line).includes("Questionnaire")),
			focus: lines.findIndex((line) => stripAnsi(line).includes("▶ ○")),
			footer: lines.findIndex((line) => stripAnsi(line).includes("aggregate bytes remaining")),
		});
		const visualPositions = shellPositions(visualLines);
		expect(visual).toContain("│ Preview");
		expect(visual).toContain("visual-only");
		expect(previewRow).toBeGreaterThan(Math.floor(visualLines.length / 2));
		expect(visualLines).toHaveLength(40);
		expect(visualLines.every((line) => visibleWidth(line) === 200)).toBe(true);
		const largeLines = component.render(220);
		const largeCardLine = largeLines.find((line) => stripAnsi(line).includes("│ Preview"));
		expect(largeLines.every((line) => visibleWidth(line) === 220)).toBe(true);
		expect(stripAnsi(largeCardLine ?? "").indexOf("│")).toBeGreaterThan(100);
		const previousNoColor = process.env.NO_COLOR;
		process.env.NO_COLOR = "1";
		try {
			const monochrome = component.render(144).join("\n");
			expect(monochrome).not.toContain("\x1b[");
			expect(monochrome).toContain("▶");
			expect(monochrome).toContain("Preview");
		} finally {
			if (previousNoColor === undefined) delete process.env.NO_COLOR;
			else process.env.NO_COLOR = previousNoColor;
		}

		component.handleInput("\x1b[B");
		const textualLines = component.render(200);
		const textual = stripAnsi(textualLines.join("\n"));
		expect(textualLines).toHaveLength(40);
		const textualPositions = shellPositions(textualLines);
		expect(textualPositions.header).toBe(visualPositions.header);
		expect(textualPositions.footer).toBe(visualPositions.footer);
		expect(textualPositions.focus - visualPositions.focus).toBe(1);
		expect(textual).not.toContain("│ Preview");
		expect(textual).not.toContain("No visual preview");
		expect(textual).not.toContain("visual-only");
		expect(textual).toContain("Lower operational risk.");

		component.handleInput("\x1b[A");
		expect(stripAnsi(component.render(200).join("\n"))).toContain("│ Preview");
	});

	it("uses named card width, height, and maximum-ratio boundaries", () => {
		const tui = createFakeTui(24);
		const component = new QuestionnaireComponent({
			tui,
			keybindings: new KeybindingsManager(),
			request: {
				version: 2,
				questions: [
					{
						id: "q",
						kind: "single-select",
						prompt: "Pick",
						choices: [
							{
								id: "visual",
								label: "Visual",
								preview: {
									markdown: Array.from({ length: 80 }, (_, index) => `Preview ${index + 1}`).join("\n"),
									alt: "Tall preview",
								},
							},
						],
					},
				],
			},
			getRows: () => tui.terminal.rows,
			requestRender: tui.requestRender,
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});

		expect(stripAnsi(component.render(119).join("\n"))).not.toContain("│ Preview");
		expect(stripAnsi(component.render(120).join("\n"))).toContain("│ Preview");
		(tui.terminal as { rows: number }).rows = 17;
		expect(stripAnsi(component.render(120).join("\n"))).not.toContain("│ Preview");
		(tui.terminal as { rows: number }).rows = 18;
		expect(stripAnsi(component.render(120).join("\n"))).toContain("│ Preview");
		(tui.terminal as { rows: number }).rows = 40;
		const tallFrame = component.render(200);
		const cardRows = tallFrame.filter((line) => stripAnsi(line).includes("│"));
		expect(cardRows.length).toBeLessThanOrEqual(13);
		expect(stripAnsi(cardRows.at(-1) ?? "")).toContain("… preview continues");
	});

	it("keeps a wide preview anchored and clips it independently from left-pane scrolling", () => {
		const tui = createFakeTui(18);
		const component = new QuestionnaireComponent({
			tui,
			keybindings: new KeybindingsManager(),
			request: {
				version: 2,
				questions: [
					{
						id: "q",
						kind: "single-select",
						prompt: "Pick a deployment path",
						context: Array.from({ length: 18 }, (_, index) => `Context ${index + 1}`).join("\n"),
						choices: [
							{
								id: "a",
								label: "A",
								preview: {
									markdown: Array.from({ length: 30 }, (_, index) => `Preview ${index + 1}`).join("\n"),
									alt: "Thirty preview rows",
								},
							},
						],
					},
				],
			},
			getRows: () => tui.terminal.rows,
			requestRender: tui.requestRender,
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});

		let output = stripAnsi(component.render(144).join("\n"));
		expect(output).toContain("Preview 1");
		expect(output).toContain("… preview continues");
		component.handleInput("\x1b[6~");
		output = stripAnsi(component.render(144).join("\n"));
		expect(output).toContain("Preview 1");
		expect(output).toContain("… preview continues");
		expect(output).toMatch(/↑ \d+ more/);
	});

	it("keeps confirm and multi Other typed, additive, and textually accessible without color", () => {
		const tui = createFakeTui(24);
		const component = new QuestionnaireComponent({
			tui,
			keybindings: new KeybindingsManager(),
			request: {
				version: 2,
				questions: [
					{ id: "confirm", kind: "confirm", prompt: "Confirm?", recommendation: { rationale: "Preferred" } },
					{ id: "multi", kind: "multi-select", prompt: "Select", choices: [{ id: "a", label: "A" }] },
				],
			},
			getRows: () => tui.terminal.rows,
			requestRender: tui.requestRender,
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});
		const output = stripAnsi(component.render(80).join("\n"));
		expect(output).toContain("Recommended");
		expect(output).toContain("Something else");
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput("\r");
		component.handleInput("custom confirm");
		component.handleInput("\r");
		component.handleInput("\t");
		component.handleInput(" ");
		component.handleInput("\x1b[B");
		component.handleInput(" ");
		component.handleInput("custom multi");
		component.handleInput("\r");
		expect(component.model.responses()).toEqual([
			{ questionId: "confirm", status: "answered", kind: "confirm", otherText: "custom confirm" },
			{ questionId: "multi", status: "answered", kind: "multi-select", choiceIds: ["a"], otherText: "custom multi" },
		]);
	});

	it("keeps fixed-size monochrome fixtures for multi-select notes and Review unanswered warnings", () => {
		const tui = createFakeTui(24);
		const component = new QuestionnaireComponent({
			tui,
			keybindings: new KeybindingsManager(),
			request: {
				version: 2,
				title: "Release choices",
				questions: [
					{
						id: "regions",
						label: "Regions",
						kind: "multi-select",
						prompt: "Where should this ship?",
						choices: [
							{ id: "east", label: "East" },
							{ id: "west", label: "West" },
						],
					},
					{ id: "approval", label: "Approval", kind: "confirm", prompt: "Approve the release?" },
				],
			},
			getRows: () => tui.terminal.rows,
			requestRender: tui.requestRender,
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});

		component.handleInput(" ");
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput(" ");
		component.handleInput("custom region");
		component.handleInput("\r");
		component.handleInput("n");
		component.handleInput("needs audit trail");
		component.handleInput("\x1b");

		const previousNoColor = process.env.NO_COLOR;
		process.env.NO_COLOR = "1";
		try {
			const multiFrame = component
				.render(80)
				.map((line) => line.trimEnd())
				.join("\n");
			expect(multiFrame).not.toContain("\x1b[");
			expect(multiFrame).toMatchInlineSnapshot(`
				"  Release choices
				  [▶ 1]  [· 2]  [  Review]

				  Regions
				  Where should this ship?

				    ☑ East
				    ☐ West
				  ▶ ☑ custom region

				  Notes
				  needs audit trail










				  ↑/↓ move · Space/Enter toggle · Shift+Tab/Tab page · Esc dismiss · N note
				  523,939 aggregate bytes remaining"
			`);

			component.handleInput("\t");
			component.handleInput("\t");
			const reviewFrame = component
				.render(80)
				.map((line) => line.trimEnd())
				.join("\n");
			expect(reviewFrame).not.toContain("\x1b[");
			expect(reviewFrame).toContain("Unanswered");
			expect(reviewFrame).toMatchInlineSnapshot(`
				"  Release choices
				  [✓ 1]  [· 2]  [▶ Review]

				    Regions
				      East, custom region
				      Note: needs audit trail

				    Approval
				      ⚠ Unanswered

				  ▶ [ Submit answers ]











				  Enter submit · ↑ inspect answers · ← last question · Esc dismiss
				  523,939 aggregate bytes remaining"
			`);
			component.handleInput("\x1b[A");
			const summaryFrame = component.render(80).join("\n");
			expect(summaryFrame).not.toContain("\x1b[");
			expect(summaryFrame).toContain("▶ Approval");
			expect(summaryFrame).toContain("  [ Submit answers ]");
			expect(summaryFrame).toContain("Enter edit · ↑/↓ navigate · ↓ submit");
		} finally {
			if (previousNoColor === undefined) delete process.env.NO_COLOR;
			else process.env.NO_COLOR = previousNoColor;
		}
	});

	it("renders review warnings with warning foreground rather than nested accent styling", () => {
		const tui = createFakeTui(24);
		const component = new QuestionnaireComponent({
			tui,
			keybindings: new KeybindingsManager(),
			request: { version: 1, questions: [{ id: "q", kind: "confirm", prompt: "Approve?" }] },
			getRows: () => tui.terminal.rows,
			requestRender: tui.requestRender,
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});
		component.model.goToReview();
		const previousNoColor = process.env.NO_COLOR;
		delete process.env.NO_COLOR;
		try {
			const warningLine = component.render(80).find((line) => stripAnsi(line).includes("⚠ Unanswered"));
			expect(warningLine).toContain(theme.getFgAnsi("warning"));
			expect(warningLine).not.toContain(theme.getFgAnsi("accent"));
		} finally {
			if (previousNoColor === undefined) delete process.env.NO_COLOR;
			else process.env.NO_COLOR = previousNoColor;
		}
	});

	it("renders v2 decision context, recommendation, distinct selection, and responsive previews", () => {
		const tui = createFakeTui(24);
		const richRequest: ExtensionQuestionnaireRequestV2 = {
			version: 2,
			title: "Deployment decision",
			questions: [
				{
					id: "strategy",
					label: "Strategy",
					kind: "single-select",
					prompt: "Choose a rollout",
					context: "Use **staged delivery** because risk is elevated.",
					recommendation: { choiceId: "canary", rationale: "Limits the initial **blast radius**." },
					choices: [
						{
							id: "canary",
							label: "Canary",
							description: "Plain *description* stays literal.",
							detail: "- Observe metrics\n- Expand gradually",
							preview: {
								title: "Traffic",
								markdown:
									"```text\nusers -> canary -> stable\nthis-line-is-deliberately-too-long-for-the-preview-panel-to-fit-without-clipping-even-at-one-hundred-and-forty-four-columns\n```",
								alt: "Traffic moves through canary before stable.",
							},
						},
						{ id: "direct", label: "Direct" },
					],
				},
			],
		};
		const initial = new QuestionnaireDraftModel(richRequest);
		initial.answerSingle("strategy", { kind: "choice", choiceId: "direct" });
		const component = new QuestionnaireComponent({
			tui,
			keybindings: new KeybindingsManager(),
			request: richRequest,
			initialDraft: initial.draft,
			getRows: () => tui.terminal.rows,
			requestRender: tui.requestRender,
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});

		component.handleInput("\x1b[A");
		const wide = stripAnsi(component.render(144).join("\n"));
		expect(
			wide
				.split("\n")
				.map((line) => line.trimEnd())
				.join("\n"),
		).toMatchInlineSnapshot(`
			"  Deployment decision
			  [▶ 1]  [  Review]

			  Strategy
			  Choose a rollout

			  Why I’m asking
			  Use staged delivery because risk is elevated.

			  Recommendation · Recommended
			  Limits the initial blast radius.

			  ▶ ○ Canary [Recommended]
			        Plain *description* stays literal.
			        - Observe metrics
			        - Expand gradually
			    ● Direct                                                                                    │ Preview · Traffic
			    ○ Something else…                                                                           │ users -> canary -> stable
			                                                                                                │ this-line-is-de [horizontal content clipped]
			  Notes                                                                                         │ Diagram description: Traffic moves through
			  Press N to add a note                                                                         │ canary before stable.

			  ↑/↓ move · Enter select · Shift+Tab/Tab page · Esc dismiss · N note
			  524,068 aggregate bytes remaining"
		`);
		expect(wide).toContain("Why I’m asking");
		expect(wide).toContain("Recommendation · Recommended");
		expect(wide).toContain("Observe metrics");
		expect(wide).toContain("▶ ○ Canary [Recommended]");
		expect(wide).toContain("● Direct");
		expect(wide).toContain("Preview · Traffic");
		expect(wide).toContain("[horizontal content clipped]");
		expect(wide).toContain("Diagram description: Traffic moves through");
		expect(wide).toContain("canary before stable.");
		expect(wide).toContain("Plain *description* stays literal.");
		const previousNoColorForWide = process.env.NO_COLOR;
		delete process.env.NO_COLOR;
		try {
			const focusedWideLine = component.render(144).find((line) => stripAnsi(line).includes("▶ ○ Canary"));
			const selectionProbe = theme.getSelectionBackgroundColor()("probe");
			const selectionOpening = selectionProbe.slice(0, selectionProbe.indexOf("probe"));
			expect(selectionOpening).not.toBe("");
			expect(focusedWideLine).toContain(selectionOpening);
			expect(focusedWideLine).toContain("\x1b[49m");
			expect(stripAnsi(focusedWideLine ?? "")).not.toContain("Preview");
			const previewHeadingLine = component.render(144).find((line) => stripAnsi(line).includes("Preview · Traffic"));
			expect(previewHeadingLine).toMatch(/\x1b\[49m {2}$/u);
		} finally {
			if (previousNoColorForWide === undefined) delete process.env.NO_COLOR;
			else process.env.NO_COLOR = previousNoColorForWide;
		}
		expect(component.model.responses()[0]).toEqual({
			questionId: "strategy",
			status: "answered",
			kind: "single-select",
			choiceId: "direct",
		});

		component.handleInput("p");
		const standardAfterWidePreviewKey = stripAnsi(component.render(100).join("\n"));
		expect(standardAfterWidePreviewKey).not.toContain("users -> canary");
		component.handleInput("\x1b[B");
		const wideWithoutActivePreview = stripAnsi(component.render(144).join("\n"));
		expect(wideWithoutActivePreview).not.toContain("│ Preview");
		expect(wideWithoutActivePreview).not.toContain("No visual preview");
		expect(wideWithoutActivePreview).not.toContain("users -> canary");
		component.handleInput("p");
		const standardAfterNoPreviewWideKey = stripAnsi(component.render(100).join("\n"));
		expect(standardAfterNoPreviewWideKey).not.toContain("users -> canary");
		component.handleInput("\x1b[A");

		component.focused = true;
		component.handleInput("n");
		expect(component.render(144).join("\n")).toContain(CURSOR_MARKER);
		component.handleInput("\x1b");

		(tui.terminal as { rows: number }).rows = 17;
		const heightConstrained = stripAnsi(component.render(144).join("\n"));
		expect(heightConstrained).toContain("Preview available");
		expect(heightConstrained).not.toContain("users -> canary");
		(tui.terminal as { rows: number }).rows = 24;

		let narrow = stripAnsi(component.render(100).join("\n"));
		expect(
			narrow
				.split("\n")
				.map((line) => line.trimEnd())
				.join("\n"),
		).toMatchInlineSnapshot(`
			"  Deployment decision
			  [▶ 1]  [  Review]

			  ↑ 2 more

			  Why I’m asking
			  Use staged delivery because risk is elevated.

			  Recommendation · Recommended
			  Limits the initial blast radius.

			  ▶ ○ Canary [Recommended]
			        Plain *description* stays literal.
			        - Observe metrics
			        - Expand gradually
			        Preview available · P expand
			        Diagram description: Traffic moves through canary before stable.
			    ● Direct
			    ○ Something else…
			  ↓ 3 more

			  ↑/↓ move · Enter select · Shift+Tab/Tab page · Esc dismiss · N note · P preview ·
			  PageUp/PageDown scroll
			  524,068 aggregate bytes remaining"
		`);
		expect(narrow).toContain("Preview available");
		expect(narrow).not.toContain("users -> canary");
		component.handleInput("n");
		expect(component.isNoteEditorOpen).toBe(true);
		component.handleInput("\x1b");
		component.handleInput("p");
		narrow = stripAnsi(component.render(100).join("\n"));
		expect(narrow).toContain("users -> canary");
	});

	it("gives v2 answer editors literal note-key precedence and a distinct focus action for notes", () => {
		const tui = createFakeTui(24);
		const component = new QuestionnaireComponent({
			tui,
			keybindings: new KeybindingsManager(),
			request: { version: 2, questions: [{ id: "text", kind: "short-text", prompt: "Explain" }] },
			getRows: () => tui.terminal.rows,
			requestRender: tui.requestRender,
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});

		component.handleInput("n");
		expect(component.model.getText("text")).toBe("n");
		expect(component.isNoteEditorOpen).toBe(false);
		component.handleInput("\x1bn");
		expect(component.isNoteEditorOpen).toBe(true);
		component.handleInput("n");
		expect(component.model.getNote("text")).toBe("n");
		component.handleInput("\x1b");
		expect(component.isNoteEditorOpen).toBe(false);
		expect(component.model.currentStep).toEqual({ kind: "question", questionId: "text" });
	});

	it("saves a note and advances to the next question when Enter is pressed", () => {
		const tui = createFakeTui(24);
		const component = new QuestionnaireComponent({
			tui,
			keybindings: new KeybindingsManager(),
			request: {
				version: 2,
				questions: [
					{ id: "first", kind: "confirm", prompt: "First decision?" },
					{ id: "second", kind: "confirm", prompt: "Second decision?" },
				],
			},
			getRows: () => tui.terminal.rows,
			requestRender: tui.requestRender,
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});

		component.handleInput("n");
		component.handleInput("record this rationale");
		component.handleInput("\r");

		expect(component.isNoteEditorOpen).toBe(false);
		expect(component.model.getNote("first")).toBe("record this rationale");
		expect(component.model.currentStep).toEqual({ kind: "question", questionId: "second" });
	});

	it("edits v2 notes with configured precedence and returns an unanswered note through review", () => {
		const tui = createFakeTui(24);
		const drafts: ExtensionQuestionnaireDraftV2[] = [];
		const submit = vi.fn();
		const component = new QuestionnaireComponent({
			tui,
			keybindings: new KeybindingsManager({ "app.questionnaire.notes": "ctrl+y" }),
			request: { version: 2, questions: [{ id: "q", kind: "confirm", prompt: "Proceed?" }] },
			getRows: () => tui.terminal.rows,
			requestRender: tui.requestRender,
			onDraftChange: (draft) => drafts.push(draft as ExtensionQuestionnaireDraftV2),
			onSubmit: submit,
			onDismiss: vi.fn(),
		});

		component.handleInput("n");
		expect(stripAnsi(component.render(100).join("\n"))).not.toContain("Editing note");
		component.handleInput("\x19");
		component.handleInput("keep unanswered");
		expect(component.model.responses()[0]).toEqual({
			questionId: "q",
			status: "unanswered",
			note: "keep unanswered",
		});
		expect(component.model.isEmpty()).toBe(false);
		component.handleInput("\x1b");
		expect(stripAnsi(component.render(100).join("\n"))).not.toContain("Discard questionnaire draft?");
		component.handleInput("\t");
		expect(stripAnsi(component.render(100).join("\n"))).toContain("Note: keep unanswered");
		component.handleInput("\x1b[C");
		component.handleInput("\r");
		expect(submit).toHaveBeenCalledWith({
			status: "submitted",
			responses: [{ questionId: "q", status: "unanswered", note: "keep unanswered" }],
		});
		expect(drafts.at(-1)?.states[0]?.note).toBe("keep unanswered");
	});
});

describe("InteractiveQuestionnaireHost", () => {
	it("keeps the presented overlay frame height stable when the active preview collapses", async () => {
		let overlay: (Component & { handleInput(data: string): void }) | undefined;
		const tui = {
			terminal: { rows: 40 },
			requestRender: vi.fn(),
			showOverlay: vi.fn((component: Component) => {
				overlay = component as Component & { handleInput(data: string): void };
				return {
					hide: vi.fn(),
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
		const outcome = host.request(
			{
				version: 2,
				questions: [
					{
						id: "mixed",
						kind: "single-select",
						prompt: "Choose",
						choices: [
							{ id: "visual", label: "Visual", preview: { markdown: "visual", alt: "Visual" } },
							{ id: "text", label: "Text" },
						],
					},
				],
			},
			{ signal: controller.signal },
		);
		expect(overlay).toBeDefined();
		const previewFrame = overlay!.render(200);
		overlay!.handleInput("\x1b[B");
		const collapsedFrame = overlay!.render(200);
		expect(previewFrame).toHaveLength(40);
		expect(collapsedFrame).toHaveLength(40);
		expect(stripAnsi(previewFrame.join("\n"))).toContain("│ Preview");
		expect(stripAnsi(collapsedFrame.join("\n"))).not.toContain("│ Preview");
		controller.abort();
		await expect(outcome).resolves.toEqual({ status: "aborted", reason: "signal" });
	});

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

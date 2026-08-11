import { stripVTControlCharacters } from "node:util";
import type { AutocompleteProvider, EditorTheme, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { CURSOR_MARKER, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.js";

const passthrough = (text: string) => text;

const editorTheme: EditorTheme = {
	borderColor: passthrough,
	selectList: {
		selectedPrefix: passthrough,
		selectedText: passthrough,
		description: passthrough,
		scrollInfo: passthrough,
		noMatch: passthrough,
	},
};

const fakeOverlayHandle: OverlayHandle = {
	hide: vi.fn(),
	setHidden: vi.fn(),
	isHidden: () => false,
	focus: vi.fn(),
	unfocus: vi.fn(),
	isFocused: () => false,
};

const fakeTui = {
	requestRender: vi.fn(),
	showOverlay: vi.fn(() => fakeOverlayHandle),
	terminal: { rows: 24, columns: 80 },
} as unknown as TUI;

const autocompleteProvider: AutocompleteProvider = {
	async getSuggestions() {
		return {
			prefix: "/",
			items: [
				{ value: "/help", label: "/help" },
				{ value: "/hotkeys", label: "/hotkeys" },
			],
		};
	},
	applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
		const line = lines[cursorLine] ?? "";
		const before = line.slice(0, cursorCol - prefix.length);
		const after = line.slice(cursorCol);
		const nextLines = [...lines];
		nextLines[cursorLine] = before + item.value + after;
		return {
			lines: nextLines,
			cursorLine,
			cursorCol: before.length + item.value.length,
		};
	},
};

describe("CustomEditor", () => {
	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
		vi.clearAllMocks();
	});

	it("cancels autocomplete before handling app.clear", async () => {
		const editor = new CustomEditor(fakeTui, editorTheme, new KeybindingsManager());
		const handler = vi.fn();

		editor.setAutocompleteProvider(autocompleteProvider);
		editor.onAction("app.clear", handler);
		editor.handleInput("/");
		await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));

		editor.handleInput("\x03");

		expect(editor.isShowingAutocomplete()).toBe(false);
		expect(handler).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("/");
	});

	it("routes Escape through its handler while dismissing autocomplete", async () => {
		const editor = new CustomEditor(fakeTui, editorTheme, new KeybindingsManager());
		const handler = vi.fn();

		editor.setAutocompleteProvider(autocompleteProvider);
		editor.onEscape = handler;
		editor.handleInput("/");
		await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));

		editor.handleInput("\x1b");

		expect(editor.isShowingAutocomplete()).toBe(false);
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("handles the question-mark shortcut as an app action", () => {
		const editor = new CustomEditor(fakeTui, editorTheme, new KeybindingsManager());
		const handler = vi.fn();

		editor.onAction("app.shortcuts", handler);
		editor.handleInput("?");

		expect(handler).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("");
	});

	it("keeps question marks in a nonempty prompt", () => {
		const editor = new CustomEditor(fakeTui, editorTheme, new KeybindingsManager());
		const handler = vi.fn();
		editor.onAction("app.shortcuts", handler);
		editor.setText("Can this contain");

		editor.handleInput("?");

		expect(handler).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("Can this contain?");
	});

	it("splits terminal-batched repeats for the configured clear-input binding", () => {
		const editor = new CustomEditor(fakeTui, editorTheme, new KeybindingsManager());
		const handler = vi.fn();
		editor.onEscape = handler;

		editor.handleInput("\x1b\x1b");

		expect(handler).toHaveBeenCalledTimes(2);
	});

	it("splits arbitrary terminal-batched clear-input repeats", () => {
		const editor = new CustomEditor(fakeTui, editorTheme, new KeybindingsManager());
		const handler = vi.fn();
		editor.onEscape = handler;

		editor.handleInput("\x1b\x1b\x1b");

		expect(handler).toHaveBeenCalledTimes(3);
	});

	it("uses custom clear-input bindings when splitting batched repeats", () => {
		const keybindings = new KeybindingsManager({ "app.input.clear": "ctrl+x" });
		const editor = new CustomEditor(fakeTui, editorTheme, keybindings);
		const handler = vi.fn();
		editor.onEscape = handler;

		editor.handleInput("\x18\x18");

		expect(handler).toHaveBeenCalledTimes(2);
	});

	it("renders the editor caret before an empty prompt placeholder", () => {
		const editor = new CustomEditor(fakeTui, editorTheme, new KeybindingsManager(), {
			placeholder: "type to start",
		});
		editor.focused = true;

		const line = editor.render(40)[1]!;

		expect(line).toContain(`${CURSOR_MARKER}\x1b[7m \x1b[0mtype to start`);
		expect(visibleWidth(line)).toBe(40);
	});

	it("omits the hardware cursor marker when the placeholder editor is unfocused", () => {
		const editor = new CustomEditor(fakeTui, editorTheme, new KeybindingsManager(), {
			placeholder: "type to start",
		});

		const line = editor.render(40)[1]!;

		expect(line).not.toContain(CURSOR_MARKER);
		expect(line).toContain("\x1b[7m \x1b[0mtype to start");
	});

	it("suppresses the hardware cursor marker while placeholder autocomplete is visible", async () => {
		const editor = new CustomEditor(fakeTui, editorTheme, new KeybindingsManager(), {
			placeholder: "type to start",
		});
		editor.focused = true;
		editor.setAutocompleteProvider(autocompleteProvider);

		editor.handleInput("\t");
		await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
		const line = editor.render(40)[1]!;

		expect(line).not.toContain(CURSOR_MARKER);
		expect(line).toContain("\x1b_pi:autocomplete:");
		expect(line).toContain("\x1b[7m \x1b[0mtype to start");
	});

	it("preserves the editor background and exact width around placeholder carets", () => {
		const backgroundColor = (text: string) => `\x1b[48;5;234m${text}\x1b[49m`;
		const editor = new CustomEditor(fakeTui, { ...editorTheme, backgroundColor }, new KeybindingsManager(), {
			paddingX: 2,
			placeholder: "type to start",
		});
		editor.focused = true;

		for (const width of [1, 2, 3, 4, 8, 40]) {
			const line = editor.render(width)[1]!;

			expect(line).toContain(`${CURSOR_MARKER}\x1b[7m \x1b[27m`);
			expect(visibleWidth(line)).toBe(width);
		}
	});

	it("keeps the placeholder caret on the input row below a header", () => {
		const editor = new CustomEditor(fakeTui, editorTheme, new KeybindingsManager(), {
			placeholder: "reply to agent",
		});
		editor.focused = true;
		editor.getHeaderLine = () => "6h last agent response";

		const lines = editor.render(40);

		expect(lines[1]).toContain("6h last agent response");
		expect(lines[1]).not.toContain(CURSOR_MARKER);
		expect(lines[2]).not.toContain(CURSOR_MARKER);
		expect(lines[3]).toContain(`${CURSOR_MARKER}\x1b[7m \x1b[0mreply to agent`);
	});

	it("renders a header line and blank spacer inside the top of the editor box", () => {
		const editor = new CustomEditor(fakeTui, editorTheme, new KeybindingsManager());
		const withoutHeader = editor.render(40);

		editor.getHeaderLine = () => "6h last agent response";
		const lines = editor.render(40);

		expect(lines.length).toBe(withoutHeader.length + 2);
		expect(lines[0]).toBe(withoutHeader[0]);
		expect(lines[1]).toContain("6h last agent response");
		expect(lines[2]!.trim()).toBe("");
		expect(lines.slice(3)).toEqual(withoutHeader.slice(1));
	});

	it("truncates the header line to the editor width", () => {
		const editor = new CustomEditor(fakeTui, editorTheme, new KeybindingsManager());
		editor.getHeaderLine = () => "x".repeat(100);
		const lines = editor.render(40);

		expect(lines[1]).toContain("x".repeat(37));
		expect(lines[1]).not.toContain("x".repeat(38));
		expect(lines[1]).toContain("...");
	});

	it("keeps the surface background across truncation resets in the header line", () => {
		const backgroundColor = (text: string) => `<bg>${text}</bg>`;
		const editor = new CustomEditor(fakeTui, { ...editorTheme, backgroundColor }, new KeybindingsManager());
		editor.getHeaderLine = () => `\x1b[31m${"x".repeat(100)}`;
		const lines = editor.render(40);

		const segments = lines[1]!.split("\x1b[0m");
		expect(segments.length).toBeGreaterThan(1);
		for (const segment of segments) {
			expect(segment.startsWith("<bg>")).toBe(true);
			expect(segment.endsWith("</bg>")).toBe(true);
		}
	});

	it("renders no header when the callback returns undefined", () => {
		const editor = new CustomEditor(fakeTui, editorTheme, new KeybindingsManager());
		const withoutCallback = editor.render(40);

		editor.getHeaderLine = () => undefined;

		expect(editor.render(40)).toEqual(withoutCallback);
	});

	it("renders a surface-backed top-right label inside the editor inset without adding height", () => {
		const backgroundColor = (text: string) => `\x1b[48;5;234m${text}\x1b[49m`;
		const editor = new CustomEditor(fakeTui, { ...editorTheme, backgroundColor }, new KeybindingsManager(), {
			paddingX: 2,
		});
		const withoutLabel = editor.render(40);

		editor.getTopRightLabel = () => "session-name";
		const lines = editor.render(40);
		const topLine = lines[0]!;
		const visibleTopLine = stripVTControlCharacters(topLine);

		expect(lines).toHaveLength(withoutLabel.length);
		expect(visibleWidth(topLine)).toBe(40);
		expect(visibleTopLine.endsWith("session-name  ")).toBe(true);
		expect(topLine.indexOf("session-name")).toBeLessThan(topLine.lastIndexOf("\x1b[49m"));
	});

	it("truncates ANSI-styled top-right labels before the inset", () => {
		const backgroundColor = (text: string) => `\x1b[48;5;234m${text}\x1b[49m`;
		const editor = new CustomEditor(fakeTui, { ...editorTheme, backgroundColor }, new KeybindingsManager(), {
			paddingX: 2,
		});
		editor.getTopRightLabel = () => `\x1b[2m${"x".repeat(100)}\x1b[22m`;

		const topLine = editor.render(20)[0]!;
		const visibleTopLine = stripVTControlCharacters(topLine);

		expect(visibleWidth(topLine)).toBe(20);
		expect(visibleTopLine.endsWith("...  ")).toBe(true);
		expect(visibleTopLine.trimEnd()).toHaveLength(18);
	});

	it("keeps the reply header and prompt caret when a top-right label is present", () => {
		const backgroundColor = (text: string) => `\x1b[48;5;234m${text}\x1b[49m`;
		const editor = new CustomEditor(fakeTui, { ...editorTheme, backgroundColor }, new KeybindingsManager(), {
			paddingX: 2,
			placeholder: "reply to agent",
		});
		editor.focused = true;
		editor.getTopRightLabel = () => "session-name";
		editor.getHeaderLine = () => "6h last agent response";

		const lines = editor.render(40);

		expect(stripVTControlCharacters(lines[0]!)).toContain("session-name");
		expect(lines[1]).toContain("6h last agent response");
		expect(lines[3]).toContain(CURSOR_MARKER);
	});

	it("preserves the upward-scroll indicator and omits a colliding label below its minimum width", () => {
		const backgroundColor = (text: string) => `\x1b[48;5;234m${text}\x1b[49m`;
		const shortTui = {
			...fakeTui,
			terminal: { rows: 5, columns: 80 },
		} as unknown as TUI;
		const editor = new CustomEditor(shortTui, { ...editorTheme, backgroundColor }, new KeybindingsManager(), {
			paddingX: 2,
		});
		editor.setText(Array.from({ length: 9 }, (_, index) => `line ${index}`).join("\n"));
		editor.getTopRightLabel = () => "session-name";

		const wideTopLine = stripVTControlCharacters(editor.render(40)[0]!);
		const truncatedTopLine = stripVTControlCharacters(editor.render(20)[0]!);
		const omittedTopLine = stripVTControlCharacters(editor.render(19)[0]!);

		expect(wideTopLine).toMatch(/↑ \d+ more .*session-name {2}$/);
		expect(truncatedTopLine).toMatch(/↑ \d+ more sessi\.{3} {2}$/);
		expect(omittedTopLine.trimEnd()).toMatch(/^ ↑ \d+ more$/);
		expect(omittedTopLine).not.toContain("...");
	});

	it("preserves the surface background across resets in a truncated top-right label", () => {
		const backgroundColor = (text: string) => `<bg>${text}</bg>`;
		const editor = new CustomEditor(fakeTui, { ...editorTheme, backgroundColor }, new KeybindingsManager(), {
			paddingX: 2,
		});
		editor.getTopRightLabel = () => `\x1b[2m${"x".repeat(100)}`;

		const segments = editor.render(20)[0]!.split("\x1b[0m");

		expect(segments.length).toBeGreaterThan(1);
		for (const segment of segments) {
			expect(segment.startsWith("<bg>")).toBe(true);
			expect(segment.endsWith("</bg>")).toBe(true);
		}
	});

	it("leaves editor rendering unchanged when the top-right callback is absent or empty", () => {
		const backgroundColor = (text: string) => `\x1b[48;5;234m${text}\x1b[49m`;
		const editor = new CustomEditor(fakeTui, { ...editorTheme, backgroundColor }, new KeybindingsManager(), {
			paddingX: 2,
		});
		const withoutCallback = editor.render(40);

		editor.getTopRightLabel = () => undefined;
		expect(editor.render(40)).toEqual(withoutCallback);

		editor.getTopRightLabel = () => "";
		expect(editor.render(40)).toEqual(withoutCallback);
	});
});

import type { Component, Focusable, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtensionQuestionnaireDraftV1, ExtensionQuestionnaireRequestV1 } from "../src/core/extensions/types.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type {
	AgentConnectionQuestionnaireLease,
	AgentConnectionQuestionnaireMutationResult,
	AgentConnectionQuestionnaireTransport,
} from "../src/modes/agent-connection/types.js";
import {
	DaemonQuestionnaireHost,
	QUESTIONNAIRE_TEXT_CHECKPOINT_DEBOUNCE_MS,
} from "../src/modes/interactive/daemon-questionnaire-host.js";
import { InteractiveQuestionnaireHost } from "../src/modes/interactive/questionnaire-host.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const request: ExtensionQuestionnaireRequestV1 = {
	version: 1,
	questions: [{ id: "q", kind: "short-text", prompt: "Private prompt" }],
};

function draft(value = "", review = false): ExtensionQuestionnaireDraftV1 {
	return {
		version: 1,
		currentStep: review ? { kind: "review" } : { kind: "question", questionId: "q" },
		states: [{ questionId: "q", kind: "short-text", value }],
	};
}

function lease(): AgentConnectionQuestionnaireLease {
	return {
		supervisorGeneration: "generation-a",
		logicalRequestId: "request-a",
		offerId: "offer-a",
		leaseEpoch: 1,
		logicalClientId: "logical-a",
		connectionId: "connection-a",
		mode: "rich",
	};
}

function harness() {
	let overlay: (Component & { handleInput(data: string): void }) | undefined;
	const hide = vi.fn();
	const tui = {
		terminal: { rows: 24 },
		requestRender: vi.fn(),
		showOverlay: vi.fn((component: Component) => {
			overlay = component as Component & { handleInput(data: string): void };
			(component as Component & Focusable).focused = true;
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
	let mutationId = 0;
	const checkpoint = vi.fn<AgentConnectionQuestionnaireTransport["checkpoint"]>(
		async (_lease, _base, clientMutationId) => ({
			status: "ack" as const,
			ack: { clientMutationId, authoritativeRevision: 1, draftHash: "hash-1" },
		}),
	);
	const transport = {
		setPresentable: vi.fn(async () => {}),
		respondToOffer: vi.fn(async () => "accepted" as const),
		checkpoint,
		submit: vi.fn(async () => ({
			status: "terminal" as const,
			outcome: { status: "submitted" as const, responses: [] },
		})),
		dismiss: vi.fn(async () => ({ status: "terminal" as const, outcome: { status: "dismissed" as const } })),
		reportPresentationError: vi.fn<AgentConnectionQuestionnaireTransport["reportPresentationError"]>(
			async () => "stale" as const,
		),
		acknowledgeWithdraw: vi.fn(async () => {}),
	} satisfies AgentConnectionQuestionnaireTransport;
	const host = new DaemonQuestionnaireHost({
		ui: tui,
		keybindings: new KeybindingsManager({ "app.questionnaire.next": "ctrl+n" }),
		transport,
		createMutationId: () => `mutation-${++mutationId}`,
	});
	return {
		host,
		transport,
		hide,
		get overlay() {
			return overlay;
		},
	};
}

async function present(target: ReturnType<typeof harness>, initialDraft = draft()): Promise<void> {
	const currentLease = lease();
	await target.host.offer("session-a", currentLease);
	await target.host.present({
		activeSessionId: "session-a",
		lease: currentLease,
		authoritativeRevision: 0,
		request,
		draft: initialDraft,
	});
}

function contentLeft(lines: string[]): number {
	const contentLines = lines.map((line) => stripAnsi(line)).filter((line) => line.trim().length > 0);
	return Math.min(...contentLines.map((line) => line.search(/\S/)));
}

beforeAll(() => initTheme("dark"));
afterEach(() => vi.useRealTimers());

describe("InteractiveQuestionnaireHost", () => {
	it("gives the local questionnaire the full available width", () => {
		let overlay: Component | undefined;
		const tui = {
			terminal: { rows: 24 },
			requestRender: vi.fn(),
			showOverlay: vi.fn((component: Component) => {
				overlay = component;
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
		host.request(request);

		const wideLeft = contentLeft(overlay!.render(144));
		expect(wideLeft).toBe(contentLeft(overlay!.render(96)));
		expect(contentLeft(overlay!.render(200))).toBe(wideLeft);
		host.terminate("runtime-replaced");
	});
});

describe("DaemonQuestionnaireHost", () => {
	it("gives the daemon questionnaire the full available width", async () => {
		const target = harness();
		await present(target);

		const wideLeft = contentLeft(target.overlay!.render(144));
		expect(wideLeft).toBe(contentLeft(target.overlay!.render(96)));
		expect(contentLeft(target.overlay!.render(200))).toBe(wideLeft);
	});

	it("accepts one exact offer, restores its private draft, and debounces text checkpoints", async () => {
		vi.useFakeTimers();
		const target = harness();
		await present(target, draft("restored"));
		expect(target.transport.respondToOffer).toHaveBeenCalledWith(lease(), "accepted");

		target.overlay?.handleInput("x");
		expect(target.transport.checkpoint).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(QUESTIONNAIRE_TEXT_CHECKPOINT_DEBOUNCE_MS);
		await vi.runAllTimersAsync();
		expect(target.transport.checkpoint).toHaveBeenCalledOnce();
		expect(target.transport.checkpoint).toHaveBeenCalledWith(lease(), 0, "mutation-1", draft("restoredx"));
	});

	it("flushes semantic navigation before atomic submit and restores focus once", async () => {
		vi.useFakeTimers();
		const target = harness();
		await present(target);
		target.overlay?.handleInput("x");
		target.overlay?.handleInput("\x0e");
		target.overlay?.handleInput("\x0e");
		target.overlay?.handleInput("\r");

		await vi.runAllTimersAsync();
		expect(target.transport.submit).toHaveBeenCalledOnce();
		expect(target.transport.checkpoint).toHaveBeenCalledWith(lease(), 0, "mutation-1", draft("x", true));
		expect(target.transport.submit).toHaveBeenCalledWith(lease(), 1, "mutation-2", draft("x", true));
		expect(target.hide).toHaveBeenCalledOnce();
	});

	it("applies an authoritative conflict snapshot instead of merging a stale local edit", async () => {
		vi.useFakeTimers();
		const target = harness();
		target.transport.checkpoint.mockResolvedValueOnce({
			status: "conflict",
			authoritativeRevision: 4,
			draftHash: "worker-hash",
			snapshot: { lease: lease(), authoritativeRevision: 4, request, draft: draft("worker") },
		});
		await present(target);
		target.overlay?.handleInput("local");
		await vi.advanceTimersByTimeAsync(QUESTIONNAIRE_TEXT_CHECKPOINT_DEBOUNCE_MS);
		await vi.runAllTimersAsync();
		target.overlay?.handleInput("!");
		await vi.advanceTimersByTimeAsync(QUESTIONNAIRE_TEXT_CHECKPOINT_DEBOUNCE_MS);
		await vi.runAllTimersAsync();
		expect(target.transport.checkpoint).toHaveBeenNthCalledWith(2, lease(), 4, "mutation-2", draft("worker!"));
		expect(target.hide).not.toHaveBeenCalled();
	});

	it("drops queued local mutations from the superseded epoch after an authoritative conflict", async () => {
		const target = harness();
		let resolveConflict!: (result: AgentConnectionQuestionnaireMutationResult) => void;
		target.transport.checkpoint.mockImplementationOnce(
			async () =>
				await new Promise<AgentConnectionQuestionnaireMutationResult>((resolve) => {
					resolveConflict = resolve;
				}),
		);
		await present(target);

		target.overlay?.handleInput("x");
		target.overlay?.handleInput("\x0e");
		await vi.waitFor(() => expect(target.transport.checkpoint).toHaveBeenCalledOnce());
		target.overlay?.handleInput("\x1b[Z");
		target.overlay?.handleInput("\r");

		resolveConflict({
			status: "conflict",
			authoritativeRevision: 4,
			draftHash: "worker-hash",
			snapshot: { lease: lease(), authoritativeRevision: 4, request, draft: draft("worker") },
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(target.transport.checkpoint).toHaveBeenCalledOnce();
		expect(target.hide).not.toHaveBeenCalled();
	});

	it("rejects a targeted presentation without its exact accepted lease but keeps the accepted offer", async () => {
		const target = harness();
		await target.host.offer("session-a", lease());
		const unexpectedLease = { ...lease(), offerId: "offer-b" };
		await target.host.present({
			activeSessionId: "session-a",
			lease: unexpectedLease,
			authoritativeRevision: 0,
			request,
			draft: draft(),
		});
		expect(target.transport.reportPresentationError).toHaveBeenCalledWith(unexpectedLease);

		await target.host.present({
			activeSessionId: "session-a",
			lease: lease(),
			authoritativeRevision: 0,
			request,
			draft: draft("accepted"),
		});
		expect(target.overlay).toBeDefined();
	});

	it("drops stale local state when the broker accepts a mismatched presentation error", async () => {
		const target = harness();
		target.transport.reportPresentationError.mockResolvedValueOnce("accepted");
		await target.host.offer("session-a", lease());
		await target.host.present({
			activeSessionId: "session-a",
			lease: { ...lease(), offerId: "offer-b" },
			authoritativeRevision: 0,
			request,
			draft: draft(),
		});

		const nextLease = { ...lease(), offerId: "offer-c", leaseEpoch: 2 };
		await target.host.offer("session-a", nextLease);
		expect(target.transport.respondToOffer).toHaveBeenLastCalledWith(nextLease, "accepted");
	});

	it("conceals an exact withdraw idempotently and ACKs even after local state is gone", async () => {
		const target = harness();
		await present(target);
		await target.host.withdraw("session-a", lease());
		await target.host.withdraw("session-a", lease());
		expect(target.hide).toHaveBeenCalledOnce();
		expect(target.transport.acknowledgeWithdraw).toHaveBeenCalledTimes(2);
	});

	it("reports construction failure without fabricating a user outcome", async () => {
		const target = harness();
		await target.host.offer("session-a", lease());
		await target.host.present({
			activeSessionId: "session-a",
			lease: lease(),
			authoritativeRevision: 0,
			request: { version: 1, questions: [] } as ExtensionQuestionnaireRequestV1,
			draft: { version: 1, currentStep: { kind: "review" }, states: [] },
		});
		expect(target.transport.reportPresentationError).toHaveBeenCalledWith(lease());
		expect(target.hide).not.toHaveBeenCalled();
	});
});

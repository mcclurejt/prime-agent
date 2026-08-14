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
		submit: vi.fn<AgentConnectionQuestionnaireTransport["submit"]>(async () => ({
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
		ui: tui,
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

	it("registers only frozen presentation data and a submit callback with no local terminal authority", async () => {
		const registration = { present: vi.fn() };
		const target = harness();
		const host = new DaemonQuestionnaireHost({
			ui: target.ui,
			keybindings: new KeybindingsManager({ "app.questionnaire.next": "ctrl+n" }),
			transport: target.transport,
			remoteRegistration: registration,
		});
		await host.offer("session-a", lease());
		await host.present({
			activeSessionId: "session-a",
			lease: lease(),
			authoritativeRevision: 0,
			request,
			draft: draft("frozen"),
		});
		expect(registration.present).toHaveBeenCalledOnce();
		const [snapshot, submit] = registration.present.mock.calls[0]!;
		expect(snapshot).toMatchObject({
			activeSessionId: "session-a",
			lease: lease(),
			authoritativeRevision: 0,
			draft: draft("frozen"),
		});
		expect(snapshot).not.toHaveProperty("dismiss");
		expect(snapshot).not.toHaveProperty("reportPresentationError");
		expect(typeof submit).toBe("function");
	});

	it("treats a worker terminal submit as remote success without preempting the remote registration", async () => {
		const registration = { present: vi.fn(), terminal: vi.fn() };
		const target = harness();
		const host = new DaemonQuestionnaireHost({
			ui: target.ui,
			keybindings: new KeybindingsManager({ "app.questionnaire.next": "ctrl+n" }),
			transport: target.transport,
			remoteRegistration: registration,
			createMutationId: (() => {
				let id = 0;
				return () => `remote-mutation-${++id}`;
			})(),
		});
		await host.offer("session-a", lease());
		await host.present({
			activeSessionId: "session-a",
			lease: lease(),
			authoritativeRevision: 0,
			request,
			draft: draft(),
		});
		const [frozen, submit] = registration.present.mock.calls[0]!;
		const result = await submit(frozen, draft("phone", true));
		expect(target.transport.submit).toHaveBeenCalledWith(lease(), 0, "remote-mutation-1", draft("phone", true));
		expect(result).toEqual({ status: "submitted" });
		expect(target.hide).toHaveBeenCalledOnce();
		expect(registration.terminal).not.toHaveBeenCalled();
		expect(target.transport.dismiss).not.toHaveBeenCalled();
		expect(target.transport.reportPresentationError).not.toHaveBeenCalled();
	});

	it("preserves phone work on answer drift and leaves the local overlay usable", async () => {
		const registration = { present: vi.fn() };
		const target = harness();
		const host = new DaemonQuestionnaireHost({
			ui: target.ui,
			keybindings: new KeybindingsManager({ "app.questionnaire.next": "ctrl+n" }),
			transport: target.transport,
			remoteRegistration: registration,
		});
		await host.offer("session-a", lease());
		await host.present({
			activeSessionId: "session-a",
			lease: lease(),
			authoritativeRevision: 0,
			request,
			draft: draft(),
		});
		const [frozen, submit] = registration.present.mock.calls[0]!;
		target.overlay?.handleInput("local");
		await new Promise<void>((resolve) => setTimeout(resolve, QUESTIONNAIRE_TEXT_CHECKPOINT_DEBOUNCE_MS + 10));
		const result = await submit(frozen, draft("phone", true));
		expect(result).toMatchObject({ status: "conflict", draft: draft("local") });
		expect(target.hide).not.toHaveBeenCalled();
		expect(target.transport.reportPresentationError).not.toHaveBeenCalled();
	});

	it("rebinds a same-logical-request remote callback to the new lease and leaves the old callback unavailable", async () => {
		const registration = { present: vi.fn(), rebind: vi.fn(), suspend: vi.fn() };
		const target = harness();
		const host = new DaemonQuestionnaireHost({
			ui: target.ui,
			keybindings: new KeybindingsManager({ "app.questionnaire.next": "ctrl+n" }),
			transport: target.transport,
			remoteRegistration: registration,
			createMutationId: (() => {
				let id = 0;
				return () => `rebind-${++id}`;
			})(),
		});
		await host.offer("session-a", lease());
		await host.present({
			activeSessionId: "session-a",
			lease: lease(),
			authoritativeRevision: 0,
			request,
			draft: draft(),
		});
		const [oldBase, oldSubmit] = registration.present.mock.calls[0]!;
		host.suspend();
		const reboundLease = { ...lease(), leaseEpoch: 2, offerId: "offer-b", connectionId: "connection-b" };
		await host.offer("session-a", reboundLease);
		await host.present({
			activeSessionId: "session-a",
			lease: reboundLease,
			authoritativeRevision: 8,
			request,
			draft: draft("new"),
		});
		expect(registration.rebind).toHaveBeenCalledOnce();
		const [newBase, newSubmit] = registration.rebind.mock.calls[0]!;
		expect(await oldSubmit(oldBase, draft("old", true))).toEqual({ status: "unavailable" });
		target.transport.submit.mockResolvedValueOnce({
			status: "terminal",
			outcome: { status: "submitted", responses: [] },
		});
		expect(await newSubmit(newBase, draft("phone", true))).toEqual({ status: "submitted" });
		expect(target.transport.submit).toHaveBeenLastCalledWith(reboundLease, 8, "rebind-1", draft("phone", true));
	});

	it("revokes a suspended registration exactly once when concealed or disposed", async () => {
		const registration = { present: vi.fn(), suspend: vi.fn(), revoke: vi.fn() };
		const target = harness();
		const host = new DaemonQuestionnaireHost({
			ui: target.ui,
			keybindings: new KeybindingsManager({ "app.questionnaire.next": "ctrl+n" }),
			transport: target.transport,
			remoteRegistration: registration,
		});
		await host.offer("session-a", lease());
		await host.present({
			activeSessionId: "session-a",
			lease: lease(),
			authoritativeRevision: 0,
			request,
			draft: draft(),
		});
		host.suspend();
		host.conceal();
		host.dispose();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(registration.revoke).toHaveBeenCalledOnce();
	});

	it("rebases a remote submit when only the current step changed", async () => {
		const registration = { present: vi.fn() };
		const target = harness();
		const host = new DaemonQuestionnaireHost({
			ui: target.ui,
			keybindings: new KeybindingsManager({ "app.questionnaire.next": "ctrl+n" }),
			transport: target.transport,
			remoteRegistration: registration,
		});
		await host.offer("session-a", lease());
		await host.present({
			activeSessionId: "session-a",
			lease: lease(),
			authoritativeRevision: 0,
			request,
			draft: draft(),
		});
		const [base, submit] = registration.present.mock.calls[0]!;
		target.overlay?.handleInput("\x0e");
		target.transport.submit.mockImplementationOnce(async (_lease, _revision, clientMutationId) => ({
			status: "ack",
			ack: { clientMutationId, authoritativeRevision: 2, draftHash: "hash-2" },
		}));
		expect(await submit(base, draft("phone", true))).toEqual({ status: "unavailable" });
		expect(target.transport.submit).toHaveBeenLastCalledWith(lease(), 1, expect.any(String), draft("phone", true));
	});

	it.each(["throw", "mutation-id-collision"] as const)(
		"keeps local UI usable when remote submit %s",
		async (outcome) => {
			const registration = { present: vi.fn() };
			const target = harness();
			const host = new DaemonQuestionnaireHost({
				ui: target.ui,
				keybindings: new KeybindingsManager({ "app.questionnaire.next": "ctrl+n" }),
				transport: target.transport,
				remoteRegistration: registration,
			});
			await host.offer("session-a", lease());
			await host.present({
				activeSessionId: "session-a",
				lease: lease(),
				authoritativeRevision: 0,
				request,
				draft: draft(),
			});
			const [base, submit] = registration.present.mock.calls[0]!;
			if (outcome === "throw") target.transport.submit.mockRejectedValueOnce(new Error("network"));
			else target.transport.submit.mockResolvedValueOnce({ status: "mutation-id-collision" });
			expect(await submit(base, draft("phone", true))).toEqual({ status: "unavailable" });
			expect(target.hide).not.toHaveBeenCalled();
			expect(target.transport.dismiss).not.toHaveBeenCalled();
			expect(target.transport.reportPresentationError).not.toHaveBeenCalled();
		},
	);

	it("keeps local presentation usable when a remote submit receives an unexpected acknowledgement", async () => {
		const registration = { present: vi.fn(), terminal: vi.fn() };
		const target = harness();
		const host = new DaemonQuestionnaireHost({
			ui: target.ui,
			keybindings: new KeybindingsManager(),
			transport: target.transport,
			remoteRegistration: registration,
		});
		target.transport.submit.mockImplementationOnce(async (_lease, _revision, clientMutationId) => ({
			status: "ack" as const,
			ack: { clientMutationId, authoritativeRevision: 2, draftHash: "hash" },
		}));
		await host.offer("session-a", lease());
		await host.present({
			activeSessionId: "session-a",
			lease: lease(),
			authoritativeRevision: 0,
			request,
			draft: draft(),
		});
		const [base, submit] = registration.present.mock.calls[0]!;
		expect(await submit(base, draft("phone", true))).toEqual({ status: "unavailable" });
		expect(target.hide).not.toHaveBeenCalled();
		expect(registration.terminal).not.toHaveBeenCalled();
		expect(target.transport.reportPresentationError).not.toHaveBeenCalled();
	});

	it("notifies remote once when local submit wins and duplicate presentation does not duplicate registration", async () => {
		const registration = { present: vi.fn(), terminal: vi.fn() };
		const target = harness();
		const host = new DaemonQuestionnaireHost({
			ui: target.ui,
			keybindings: new KeybindingsManager({ "app.questionnaire.next": "ctrl+n" }),
			transport: target.transport,
			remoteRegistration: registration,
		});
		await host.offer("session-a", lease());
		const presentation = {
			activeSessionId: "session-a",
			lease: lease(),
			authoritativeRevision: 0,
			request,
			draft: draft("x", true),
		};
		await host.present(presentation);
		await host.present(presentation);
		expect(registration.present).toHaveBeenCalledOnce();
		target.overlay?.handleInput("\r");
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(target.hide).toHaveBeenCalledOnce();
		expect(registration.terminal).toHaveBeenCalledOnce();
	});

	it("returns remote conflict snapshots without discarding the phone draft or reporting presentation failure", async () => {
		const registration = { present: vi.fn() };
		const target = harness();
		const host = new DaemonQuestionnaireHost({
			ui: target.ui,
			keybindings: new KeybindingsManager({ "app.questionnaire.next": "ctrl+n" }),
			transport: target.transport,
			remoteRegistration: registration,
		});
		target.transport.submit.mockResolvedValueOnce({
			status: "conflict",
			authoritativeRevision: 3,
			draftHash: "worker",
			snapshot: { lease: lease(), authoritativeRevision: 3, request, draft: draft("worker") },
		});
		await host.offer("session-a", lease());
		await host.present({
			activeSessionId: "session-a",
			lease: lease(),
			authoritativeRevision: 0,
			request,
			draft: draft(),
		});
		const [base, submit] = registration.present.mock.calls[0]!;
		expect(await submit(base, draft("phone", true))).toMatchObject({ status: "conflict", draft: draft("worker") });
		expect(target.hide).not.toHaveBeenCalled();
		expect(target.transport.dismiss).not.toHaveBeenCalled();
		expect(target.transport.reportPresentationError).not.toHaveBeenCalled();
	});

	it("revokes and closes once when a remote submit receives stale lease", async () => {
		const registration = { present: vi.fn(), revoke: vi.fn() };
		const target = harness();
		const host = new DaemonQuestionnaireHost({
			ui: target.ui,
			keybindings: new KeybindingsManager({ "app.questionnaire.next": "ctrl+n" }),
			transport: target.transport,
			remoteRegistration: registration,
		});
		target.transport.submit.mockResolvedValueOnce({ status: "stale-lease" });
		await host.offer("session-a", lease());
		await host.present({
			activeSessionId: "session-a",
			lease: lease(),
			authoritativeRevision: 0,
			request,
			draft: draft(),
		});
		const [base, submit] = registration.present.mock.calls[0]!;
		expect(await submit(base, draft("phone", true))).toEqual({ status: "stale-lease" });
		expect(target.hide).toHaveBeenCalledOnce();
		expect(registration.revoke).toHaveBeenCalledOnce();
		expect(target.transport.dismiss).not.toHaveBeenCalled();
		expect(target.transport.reportPresentationError).not.toHaveBeenCalled();
	});
});

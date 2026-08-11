import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import type { Component, Focusable, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import type { AgentCronJob } from "../src/core/cron-jobs.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { SessionManager } from "../src/core/session-manager.js";
import type { ExtensionAPI, ExtensionFactory } from "../src/index.js";
import { createAgentConnectionState } from "../src/modes/agent-connection/snapshot.js";
import type { ActiveSessionState } from "../src/modes/daemon/active-session-state.js";
import { bindActiveSessionState } from "../src/modes/daemon/daemon-extension-binding.js";
import type { DaemonOutbound } from "../src/modes/daemon/daemon-protocol.js";
import type { WorkerQuestionnaireBrokerMessage } from "../src/modes/daemon/daemon-worker-protocol.js";
import { WorkerUiClientsMirror } from "../src/modes/daemon/daemon-worker-ui-clients.js";
import { QuestionnaireWorkerAuthority } from "../src/modes/daemon/questionnaire-worker-authority.js";
import { DaemonQuestionnaireHost } from "../src/modes/interactive/daemon-questionnaire-host.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function getText(message: AgentSession["messages"][number]): string {
	if (!("content" in message)) {
		return "";
	}
	return typeof message.content === "string"
		? message.content
		: message.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("");
}

describe("daemon extension binding", () => {
	beforeAll(() => initTheme("dark"));
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeForTest(extensionFactory: ExtensionFactory, responses: string[]) {
		const tempDir = join(tmpdir(), `pi-daemon-extension-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({
			models: [{ id: "faux-daemon", reasoning: false }],
		});
		faux.setResponses(responses.map((response) => fauxAssistantMessage(response)));

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: tempDir,
				authStorage,
				resourceLoaderOptions: {
					extensionFactories: [
						(pi: ExtensionAPI) => {
							pi.registerProvider(faux.getModel().provider, {
								baseUrl: faux.getModel().baseUrl,
								apiKey: "faux-key",
								api: faux.api,
								models: faux.models.map((registeredModel) => ({
									id: registeredModel.id,
									name: registeredModel.name,
									api: registeredModel.api,
									reasoning: registeredModel.reasoning,
									input: registeredModel.input,
									cost: registeredModel.cost,
									contextWindow: registeredModel.contextWindow,
									maxTokens: registeredModel.maxTokens,
								})),
							});
							extensionFactory(pi);
						},
					],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};

		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
		});

		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return runtime;
	}

	it("strips the duplicated partial message from broadcast message_update events", async () => {
		const runtime = await createRuntimeForTest(() => {}, ["streamed reply"]);

		const outbound: DaemonOutbound[] = [];
		const state: ActiveSessionState = {
			activeSessionId: "active-slim",
			runtime,
			clients: new Set(),
			pendingAttaches: 0,
			extensionUiRequests: new Map(),
			eventGeneration: "generation-slim",
			lastEventSequence: 0,
		};
		await bindActiveSessionState(state, {
			broadcast: (_state, message) => {
				outbound.push(message);
			},
			shutdown: () => {},
			questionnaire: async () => ({ status: "unsupported" }),
			terminateQuestionnaires: () => {},
		});

		await runtime.session.prompt("hello");

		const updates = outbound.filter(
			(message): message is Extract<DaemonOutbound, { type: "session_event" }> =>
				message.type === "session_event" && message.event.type === "message_update",
		);
		expect(updates.length).toBeGreaterThan(0);
		for (const update of updates) {
			expect(update.event).toHaveProperty("message");
			expect(update.event).toHaveProperty("assistantMessageEvent");
			expect((update.event as { assistantMessageEvent: object }).assistantMessageEvent).not.toHaveProperty(
				"partial",
			);
		}
	});

	it("carries a negotiated v2 note through the real runtime, authority, and daemon host without control-plane leaks", async () => {
		let commandOutcome: unknown;
		const runtime = await createRuntimeForTest((pi) => {
			pi.registerCommand("daemon-questionnaire-v2", {
				description: "daemon questionnaire v2",
				handler: async (_args, ctx) => {
					commandOutcome = await ctx.ui.questionnaire?.({
						version: 2,
						title: "Private decision",
						questions: [{ id: "q", kind: "confirm", prompt: "Proceed?", context: "Private context" }],
					});
				},
			});
		}, []);
		const state: ActiveSessionState = {
			activeSessionId: "active-questionnaire-v2",
			runtime,
			clients: new Set(),
			pendingAttaches: 0,
			extensionUiRequests: new Map(),
			eventGeneration: "generation-questionnaire-v2",
			lastEventSequence: 0,
		};
		const mirror = new WorkerUiClientsMirror();
		mirror.applySync({
			supervisorGeneration: "generation-questionnaire-v2",
			syncRevision: 1,
			clients: [
				{
					logicalClientId: "logical-v2",
					connectionId: "connection-v2",
					activeSessionId: state.activeSessionId,
					capabilities: ["extension_ui", "questionnaire_v1", "questionnaire_v2"],
					presentable: true,
				},
			],
			complete: true,
		});
		const brokerMessages: WorkerQuestionnaireBrokerMessage[] = [];
		let id = 0;
		const authority = new QuestionnaireWorkerAuthority({
			uiClients: mirror,
			sendBrokerMessage: (message) => {
				brokerMessages.push(message);
				return true;
			},
			onStatusChanged: () => {},
			createId: () => `vertical-${++id}`,
			now: () => id,
		});
		await bindActiveSessionState(state, {
			broadcast: () => {},
			shutdown: () => {},
			questionnaire: (_targetState, request, options) =>
				authority.request(state.activeSessionId, request, options).outcome,
			terminateQuestionnaires: () => {},
		});

		const prompt = runtime.session.prompt("/daemon-questionnaire-v2");
		await vi.waitFor(() => expect(brokerMessages.at(-1)?.type).toBe("presenter_needed"));
		const needMessage = brokerMessages.at(-1);
		if (needMessage?.type !== "presenter_needed") throw new Error("missing v2 presenter need");
		expect(needMessage.need.questionnaireVersion).toBe(2);
		const lease = {
			supervisorGeneration: needMessage.need.supervisorGeneration,
			logicalRequestId: needMessage.need.logicalRequestId,
			offerId: needMessage.need.offerId,
			leaseEpoch: needMessage.need.leaseEpoch,
			logicalClientId: "logical-v2",
			connectionId: "connection-v2",
			mode: "rich" as const,
			questionnaireVersion: 2 as const,
		};
		let overlay: (Component & { handleInput(data: string): void }) | undefined;
		const tui = {
			terminal: { rows: 24 },
			requestRender: vi.fn(),
			showOverlay: vi.fn((component: Component) => {
				overlay = component as Component & { handleInput(data: string): void };
				(component as Component & Focusable).focused = true;
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
		const host = new DaemonQuestionnaireHost({
			ui: tui,
			keybindings: new KeybindingsManager({ "app.questionnaire.notes": "ctrl+y" }),
			transport: {
				setPresentable: async () => {},
				respondToOffer: async (offeredLease) => {
					authority.handleOfferResult({ status: "accepted", lease: offeredLease });
					return "accepted";
				},
				checkpoint: async (offeredLease, baseRevision, clientMutationId, completeDraft) =>
					authority.checkpoint({ lease: offeredLease, baseRevision, clientMutationId, completeDraft }),
				submit: async (offeredLease, baseRevision, clientMutationId, completeDraft) =>
					authority.submit({ lease: offeredLease, baseRevision, clientMutationId, completeDraft }),
				dismiss: async (offeredLease) => authority.dismiss(offeredLease),
				reportPresentationError: async () => "stale",
				acknowledgeWithdraw: async () => {},
			},
			createMutationId: () => `mutation-${++id}`,
		});
		await host.offer(state.activeSessionId, lease);
		const presentation = authority.presentationForLease(lease);
		if (!presentation) throw new Error("missing v2 presentation");
		await host.present({ activeSessionId: presentation.activeSessionId, ...presentation.snapshot });
		if (!overlay) throw new Error("missing questionnaire overlay");
		overlay.handleInput("\x19");
		overlay.handleInput("private note");
		overlay.handleInput("\x1b");
		overlay.handleInput("\t");
		overlay.handleInput("\x1b[C");
		overlay.handleInput("\r");
		await prompt;

		expect(commandOutcome).toEqual({
			status: "submitted",
			responses: [{ questionId: "q", status: "unanswered", note: "private note" }],
		});
		expect(JSON.stringify(brokerMessages)).not.toMatch(/Private decision|Private context|private note/u);
		const publicSnapshot = createAgentConnectionState(runtime, state.activeSessionId);
		expect(JSON.stringify(publicSnapshot)).not.toMatch(/Private decision|Private context|private note/u);
	});

	it("routes extension questionnaires through the daemon worker authority callback", async () => {
		let commandOutcome: unknown;
		const runtime = await createRuntimeForTest((pi) => {
			pi.registerCommand("daemon-questionnaire", {
				description: "daemon questionnaire",
				handler: async (_args, ctx) => {
					commandOutcome = await ctx.ui.questionnaire?.({
						version: 2,
						questions: [{ id: "confirm", kind: "confirm", prompt: "Proceed?", context: "Private context" }],
					});
				},
			});
		}, []);
		const state: ActiveSessionState = {
			activeSessionId: "active-questionnaire",
			runtime,
			clients: new Set(),
			pendingAttaches: 0,
			extensionUiRequests: new Map(),
			eventGeneration: "generation-questionnaire",
			lastEventSequence: 0,
		};
		let callbackState: ActiveSessionState | undefined;
		let callbackRequest: unknown;
		await bindActiveSessionState(state, {
			broadcast: () => {},
			shutdown: () => {},
			questionnaire: async (targetState, request) => {
				callbackState = targetState;
				callbackRequest = request;
				return {
					status: "submitted",
					responses: [{ questionId: "confirm", status: "unanswered", note: "private note" }],
				};
			},
			terminateQuestionnaires: () => {},
		});

		await runtime.session.prompt("/daemon-questionnaire");

		expect(callbackState).toBe(state);
		expect(callbackRequest).toEqual({
			version: 2,
			questions: [{ id: "confirm", kind: "confirm", prompt: "Proceed?", context: "Private context" }],
		});
		expect(commandOutcome).toEqual({
			status: "submitted",
			responses: [{ questionId: "confirm", status: "unanswered", note: "private note" }],
		});
	});

	it("keeps extension replacement callbacks daemon-side and rebinds before withSession", async () => {
		const phases: string[] = [];
		let oldSessionFile: string | undefined;
		let replacementSessionFile: string | undefined;

		const runtime = await createRuntimeForTest(
			(pi) => {
				pi.registerCommand("daemon-replace", {
					description: "daemon replace",
					handler: async (_args, ctx) => {
						phases.push("command");
						oldSessionFile = ctx.sessionManager.getSessionFile();
						await ctx.newSession({
							parentSession: oldSessionFile,
							withSession: async (replacedCtx) => {
								phases.push("withSession");
								replacementSessionFile = replacedCtx.sessionManager.getSessionFile();
								await replacedCtx.sendUserMessage("daemon replacement message");
							},
						});
					},
				});
			},
			["replacement reply"],
		);

		const outbound: DaemonOutbound[] = [];
		const heartbeat: AgentCronJob = {
			id: "heartbeat-1",
			status: "active",
			source: "heartbeat",
			activeSessionId: "active-test",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			prompt: "check status",
			schedule: { kind: "interval", expression: "every 10s", intervalMs: 10_000 },
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			nextRunAt: "2026-01-01T00:00:10.000Z",
			runCount: 0,
		};
		const state: ActiveSessionState = {
			activeSessionId: "active-test",
			runtime,
			clients: new Set(),
			pendingAttaches: 0,
			extensionUiRequests: new Map(),
			eventGeneration: "generation-test",
			lastEventSequence: 0,
			summaryState: { summary: "old recap", taskState: "completed", basedOnMessageCount: 2 },
		};
		await bindActiveSessionState(state, {
			broadcast: (_state, message) => {
				outbound.push(message);
				if (message.type === "session_replaced") {
					phases.push("broadcast:session_replaced");
				}
			},
			createConnectionState: (targetState) => {
				const connectionState = createAgentConnectionState(targetState.runtime, targetState.activeSessionId);
				if (targetState.summaryState?.summary) {
					connectionState.recap = targetState.summaryState.summary;
				}
				connectionState.heartbeat = heartbeat;
				return connectionState;
			},
			sessionReplaced: (targetState) => {
				phases.push("sessionReplaced");
				targetState.summaryState = undefined;
			},
			shutdown: () => {
				phases.push("shutdown");
			},
			questionnaire: async () => ({ status: "unsupported" }),
			terminateQuestionnaires: (_targetState, reason) => {
				phases.push(`terminate:${reason}`);
			},
		});

		await runtime.session.prompt("/daemon-replace");

		const replacementIndex = phases.indexOf("broadcast:session_replaced");
		const withSessionIndex = phases.indexOf("withSession");
		expect(replacementIndex).toBeGreaterThan(-1);
		expect(withSessionIndex).toBeGreaterThan(-1);
		expect(phases.indexOf("terminate:runtime-replaced")).toBeLessThan(phases.indexOf("sessionReplaced"));
		expect(phases.indexOf("sessionReplaced")).toBeLessThan(replacementIndex);
		expect(replacementIndex).toBeLessThan(withSessionIndex);
		expect(replacementSessionFile).toBeDefined();
		expect(replacementSessionFile).not.toBe(oldSessionFile);
		expect(outbound).toContainEqual(
			expect.objectContaining({
				type: "session_replaced",
				activeSessionId: "active-test",
				state: expect.objectContaining({
					heartbeat: expect.objectContaining({ id: "heartbeat-1" }),
				}),
			}),
		);
		const replaced = outbound.find(
			(message): message is Extract<DaemonOutbound, { type: "session_replaced" }> =>
				message.type === "session_replaced",
		);
		expect(replaced?.state.recap).toBeUndefined();
		expect(runtime.session.messages.map((message) => `${message.role}:${getText(message)}`)).toEqual([
			"user:daemon replacement message",
			"assistant:replacement reply",
		]);
	});
});

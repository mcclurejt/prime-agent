import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionMessageController } from "../src/core/agent-messages.js";
import type { AgentObserveController } from "../src/core/agent-observe.js";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import type { AgentRlmHeartbeatController } from "../src/core/cron-jobs.js";
import { SESSION_LEASE_OWNER_ID_ENV, SESSION_LEASES_ENABLED_ENV } from "../src/core/session-lease.js";
import { SessionManager } from "../src/core/session-manager.js";
import type { ExtensionFactory } from "../src/index.js";
import { createTestResourceLoader } from "./utilities.js";

describe("AgentSessionRuntime session lifecycle events", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
		vi.unstubAllEnvs();
	});

	type HostControllerOptions = {
		agentMessageController?: AgentSessionMessageController;
		agentObserveController?: AgentObserveController;
		rlmHeartbeatController?: AgentRlmHeartbeatController;
	};

	async function createRuntimeHost(
		extensionFactory: ExtensionFactory,
		hostControllerOptions: HostControllerOptions = {},
	) {
		const tempDir = join(tmpdir(), `pi-runtime-events-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const runtimeOptions = {
			agentDir: tempDir,
			authStorage,
			model: faux.getModel(),
			resourceLoaderOptions: {
				extensionFactories: [extensionFactory],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = vi.fn(
			async ({ cwd, sessionManager, sessionStartEvent, sessionOptions }) => {
				const baseServices = await createAgentSessionServices({
					...runtimeOptions,
					cwd,
				});
				const services = {
					...baseServices,
					resourceLoader: createTestResourceLoader({
						extensionsResult: baseServices.resourceLoader.getExtensions(),
						skills: ["agent-message", "agent-observe", "rlm-heartbeat"].map((name) => ({
							name,
							description: name,
							filePath: `/skills/${name}/SKILL.md`,
							baseDir: `/skills/${name}`,
							sourceInfo: {
								source: "local" as const,
								path: `/skills/${name}/SKILL.md`,
								scope: "project" as const,
								origin: "top-level" as const,
							},
							disableModelInvocation: false,
							kind: "markdown" as const,
						})),
					}),
				};
				return {
					...(await createAgentSessionFromServices({
						services,
						sessionManager,
						sessionStartEvent,
						model: faux.getModel(),
						agentMessageController: sessionOptions?.agentMessageController,
						agentObserveController: sessionOptions?.agentObserveController,
						rlmHeartbeatController: sessionOptions?.rlmHeartbeatController,
					})),
					services,
					diagnostics: services.diagnostics,
				};
			},
		);
		const runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
			sessionOptions: hostControllerOptions,
		});
		await runtimeHost.session.bindExtensions({});

		cleanups.push(async () => {
			await runtimeHost.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { runtimeHost, faux, createRuntime };
	}

	it("preserves host controller options across a saved-session replacement", async () => {
		const agentMessageController = {
			listAgents: () => ({ agents: [] }),
			sendAgentMessage: () => Promise.reject(new Error("not used")),
		} satisfies AgentSessionMessageController;
		const agentObserveController = {
			listAgents: () => Promise.reject(new Error("not used")),
			getAgent: () => Promise.reject(new Error("not used")),
			recentMessages: () => Promise.reject(new Error("not used")),
		} satisfies AgentObserveController;
		const rlmHeartbeatController: AgentRlmHeartbeatController = {
			listRlmHeartbeats: () => [],
			createRlmHeartbeat: () => {
				throw new Error("not used");
			},
			updateRlmHeartbeat: () => undefined,
			deleteRlmHeartbeat: () => undefined,
		};
		const hostControllerOptions = { agentMessageController, agentObserveController, rlmHeartbeatController };
		const { runtimeHost, createRuntime } = await createRuntimeHost(() => undefined, hostControllerOptions);

		await runtimeHost.newSession({ parentSession: runtimeHost.session.sessionFile });

		expect(createRuntime).toHaveBeenCalledTimes(2);
		expect(vi.mocked(createRuntime).mock.calls[1]?.[0].sessionOptions).toEqual(hostControllerOptions);
		const internals = runtimeHost.session as unknown as {
			_createKernelHostHandlers(): Record<string, unknown>;
			_modelVisibleSkills(): { name: string }[];
		};
		expect(internals._modelVisibleSkills().map((skill) => skill.name)).toEqual([
			"agent-message",
			"agent-observe",
			"rlm-heartbeat",
		]);
		expect(internals._createKernelHostHandlers()).toEqual(
			expect.objectContaining({
				"agent_message.list_agents": expect.any(Function),
				"agent_observe.list": expect.any(Function),
				"rlm_heartbeat.list": expect.any(Function),
			}),
		);
	});

	it("runs beforeSessionInvalidate after session_shutdown and before rebindSession", async () => {
		const phases: string[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_shutdown", () => {
				phases.push("session_shutdown");
			});
		});
		const oldSession = runtimeHost.session;
		runtimeHost.setBeforeSessionInvalidate(() => {
			phases.push("beforeSessionInvalidate");
			expect(oldSession.extensionRunner.createContext().cwd).toBe(oldSession.sessionManager.getCwd());
		});
		runtimeHost.setRebindSession(async () => {
			phases.push("rebindSession");
		});

		await runtimeHost.newSession();

		expect(phases).toEqual(["session_shutdown", "beforeSessionInvalidate", "rebindSession"]);
		expect(() => oldSession.extensionRunner.createContext().cwd).toThrow(
			"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		runtimeHost.setBeforeSessionInvalidate(undefined);
		runtimeHost.setRebindSession(undefined);
	});

	it("releases a replacement lease when current-session teardown fails", async () => {
		vi.stubEnv(SESSION_LEASES_ENABLED_ENV, "1");
		vi.stubEnv(SESSION_LEASE_OWNER_ID_ENV, "runtime-events");
		const { runtimeHost } = await createRuntimeHost(() => undefined);
		runtimeHost.setBeforeSessionInvalidate(() => {
			throw new Error("teardown failed");
		});

		await expect(runtimeHost.newSession()).rejects.toThrow("teardown failed");
		runtimeHost.setBeforeSessionInvalidate(undefined);
		const leaseRoot = join(runtimeHost.services.agentDir, "session-leases");
		expect(readdirSync(leaseRoot).filter((entry) => entry.endsWith(".lock"))).toHaveLength(1);
	});
});

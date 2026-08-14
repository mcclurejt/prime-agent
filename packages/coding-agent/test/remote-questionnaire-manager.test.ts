import type { SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { type RequestOptions, request } from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { DaemonQuestionnaireRemoteSnapshot } from "../src/modes/interactive/daemon-questionnaire-host.js";
import {
	buildRemoteQuestionnaireMessage,
	HID_IDLE_REQUIRED_NS,
	parseHidIdleNanoseconds,
	QuickTunnelUrlParser,
	type RemoteQuestionnaireIoregDependencies,
	RemoteQuestionnaireManager,
	type RemoteQuestionnaireManagerDependencies,
	type RemoteQuestionnaireMessageDependencies,
	readHidIdleNanoseconds,
	sendIMessage,
} from "../src/modes/interactive/remote-questionnaire-manager.js";
import { RemoteQuestionnairePage } from "../src/modes/interactive/remote-questionnaire-page.js";
import { RemoteQuestionnaireServer } from "../src/modes/interactive/remote-questionnaire-server.js";

class FakeChild extends EventEmitter {
	pid = 123;
	stdout = new PassThrough();
	stderr = new PassThrough();
	kill = vi.fn<(signal?: NodeJS.Signals | number) => boolean>(() => true);

	once(event: "error", listener: (error: Error) => void): this;
	once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	once(
		event: "error" | "exit",
		listener: ((error: Error) => void) | ((code: number | null, signal: NodeJS.Signals | null) => void),
	): this {
		return super.once(event, listener);
	}
}

function dependencies(overrides: Partial<RemoteQuestionnaireManagerDependencies> = {}) {
	const child = new FakeChild();
	const server = {
		url: "http://127.0.0.1:4444/r/route",
		routeId: "route",
		fragmentSecret: "secret",
		setPublicHostname: vi.fn(),
		setPage: vi.fn(),
		setActive: vi.fn(),
		setSuspended: vi.fn(),
		setTerminal: vi.fn(),
		revoke: vi.fn(),
		close: vi.fn(),
	};
	const messages: Array<{ recipient: string; body: string }> = [];
	const timers: Array<() => void> = [];
	const values: RemoteQuestionnaireManagerDependencies = {
		messageCaps: new Map(),
		platform: "darwin",
		supportsRichQuestionnaire: true,
		clock: { now: () => 1000, monotonicNow: () => 300_001 },
		timers: {
			setTimeout: (cb) => {
				timers.push(cb);
				return timers.length - 1;
			},
			clearTimeout: vi.fn(),
		},
		readHidIdleNanoseconds: vi.fn(async () => HID_IDLE_REQUIRED_NS),
		spawn: vi.fn<RemoteQuestionnaireManagerDependencies["spawn"]>(() => child),
		message: {
			send: vi.fn<RemoteQuestionnaireManagerDependencies["message"]["send"]>(async (recipient, body) => {
				messages.push({ recipient, body });
			}),
		},
		createServer: vi.fn(async () => server),
		journalPath: () => "/tmp/journal",
		recordOrphan: vi.fn(() => ({ processStartId: "child", ownerPid: 2, ownerProcessStartId: "owner" })),
		settleOrphan: vi.fn(),
		processOps: { signalProcessGroupOrProcess: vi.fn(), waitForExit: vi.fn(async () => true) },
		...overrides,
		labels: overrides.labels ?? (() => ({})),
	};
	return { values, child, server, messages, timers };
}

const settings = {
	enabled: true,
	recipient: "+12225550123",
	delayMinutes: 5,
	linkLifetimeHours: 12,
	cloudflaredPath: "/opt/homebrew/bin/cloudflared",
} as const;
const presentation = {
	logicalRequestId: "request",
	title: "Deploy",
	projectLabel: "prime",
	sessionLabel: "session",
	questionCount: 1,
	firstPrompt: "Ship it?",
	presentedAtMonotonic: 0,
};

interface HttpResponse {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}
function http(
	url: string,
	options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HttpResponse> {
	return new Promise((resolve, reject) => {
		const target = new URL(url);
		const requestOptions: RequestOptions = {
			hostname: target.hostname,
			port: target.port,
			path: target.pathname,
			method: options.method ?? "GET",
			headers: options.headers,
		};
		const client = request(requestOptions, (response) => {
			let body = "";
			response.setEncoding("utf8");
			response.on("data", (chunk: string) => {
				body += chunk;
			});
			response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
		});
		client.on("error", reject);
		if (options.body) client.write(options.body);
		client.end();
	});
}
function sessionCookie(response: HttpResponse): string {
	const header = response.headers["set-cookie"];
	if (!Array.isArray(header) || !header[0]) throw new Error("missing session cookie");
	return header[0].split(";", 1)[0]!;
}

describe("RemoteQuestionnaireManager", () => {
	it("owns a page per host presentation and invokes only its submit adapter with the complete current draft", async () => {
		let monotonicNow = 300_001;
		const fake = dependencies({ clock: { now: () => 1_000, monotonicNow: () => monotonicNow } });
		const manager = new RemoteQuestionnaireManager(settings, fake.values);
		const snapshot: DaemonQuestionnaireRemoteSnapshot = {
			activeSessionId: "active-a",
			lease: {
				supervisorGeneration: "generation-a",
				logicalRequestId: "request",
				offerId: "offer-a",
				leaseEpoch: 1,
				logicalClientId: "logical-a",
				connectionId: "connection-a",
				mode: "rich",
			},
			authoritativeRevision: 2,
			request: { version: 1, questions: [{ id: "q", kind: "short-text", prompt: "Ship?" }] },
			draft: {
				version: 1,
				currentStep: { kind: "review" },
				states: [{ questionId: "q", kind: "short-text", value: "phone answer" }],
			},
		};
		const submit = vi.fn(async () => ({ status: "ack" as const, authoritativeRevision: 3 }));

		await manager.present(snapshot, submit);
		monotonicNow += 300_000;
		await manager.consider();

		expect(fake.values.createServer).toHaveBeenCalledWith(expect.any(Number), expect.anything());
		const serverOptions = (fake.values.createServer as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
		expect(serverOptions.page.draft).toEqual(snapshot.draft);
		await serverOptions.onMutation({ sessionId: "mobile", page: { action: "submit" } });
		expect(submit).toHaveBeenCalledWith(snapshot, snapshot.draft);
		expect(fake.values.message.send).not.toHaveBeenCalled();
	});
	it("preserves phone edits across same-ID suspend/rebind and submits them through the new lease", async () => {
		let monotonicNow = 300_001;
		const fake = dependencies({ clock: { now: () => 1_000, monotonicNow: () => monotonicNow } });
		const manager = new RemoteQuestionnaireManager(settings, fake.values);
		const snapshot = {
			activeSessionId: "active-a",
			lease: {
				supervisorGeneration: "generation-a",
				logicalRequestId: "request",
				offerId: "offer-a",
				leaseEpoch: 1,
				logicalClientId: "logical-a",
				connectionId: "connection-a",
				mode: "rich" as const,
			},
			authoritativeRevision: 1,
			request: { version: 1 as const, questions: [{ id: "q", kind: "short-text" as const, prompt: "Ship?" }] },
			draft: {
				version: 1 as const,
				currentStep: { kind: "review" as const },
				states: [{ questionId: "q", kind: "short-text" as const, value: "old" }],
			},
		};
		await manager.present(snapshot, async () => ({ status: "unavailable" }));
		monotonicNow += 300_000;
		await manager.consider();
		const options = (fake.values.createServer as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
		options.page.updateText("q", "phone edit");
		manager.suspend();
		const rebound = {
			...snapshot,
			authoritativeRevision: 2,
			lease: { ...snapshot.lease, offerId: "offer-b", leaseEpoch: 2 },
			draft: {
				...snapshot.draft,
				states: [{ questionId: "q", kind: "short-text" as const, value: "terminal edit" }],
			},
		};
		const submit = vi.fn(async () => ({ status: "ack" as const, authoritativeRevision: 3 }));
		await manager.rebind(rebound, submit);
		await options.onMutation({ sessionId: "mobile", page: { action: "submit" } });
		expect(fake.server.setSuspended).toHaveBeenCalledOnce();
		expect(fake.server.revoke).not.toHaveBeenCalled();
		expect(fake.server.setPage).not.toHaveBeenCalled();
		expect(fake.server.setActive).toHaveBeenCalledOnce();
		expect(submit).toHaveBeenCalledWith(
			rebound,
			expect.objectContaining({ states: [{ questionId: "q", kind: "short-text", value: "phone edit" }] }),
		);
	});

	it("keeps phone edits while a stale conflict is shown and reloads only the authoritative snapshot", async () => {
		let monotonic = 0;
		const fake = dependencies({ clock: { now: () => 1_000, monotonicNow: () => monotonic } });
		const manager = new RemoteQuestionnaireManager(settings, fake.values);
		const snapshot: DaemonQuestionnaireRemoteSnapshot = {
			activeSessionId: "active",
			lease: {
				supervisorGeneration: "g",
				logicalRequestId: "request",
				offerId: "o",
				leaseEpoch: 1,
				logicalClientId: "l",
				connectionId: "c",
				mode: "rich",
			},
			authoritativeRevision: 1,
			request: { version: 1, questions: [{ id: "q", kind: "short-text", prompt: "<changed>" }] },
			draft: {
				version: 1,
				currentStep: { kind: "review" },
				states: [{ questionId: "q", kind: "short-text", value: "old" }],
			},
		};
		const latest = {
			...snapshot,
			authoritativeRevision: 2,
			draft: { ...snapshot.draft, states: [{ questionId: "q", kind: "short-text" as const, value: "terminal" }] },
		};
		await manager.present(snapshot, async () => ({
			status: "conflict",
			authoritativeRevision: 2,
			snapshot: latest,
			draft: latest.draft,
			changedQuestionIds: ["q"],
		}));
		monotonic = 300_001;
		await fake.timers.at(-1)?.();
		const options = (fake.values.createServer as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
		options.page.updateText("q", "phone edit");
		const stale = await options.onMutation({ sessionId: "phone", page: { action: "submit" } });
		expect(stale).toMatchObject({ kind: "stale" });
		expect(stale.message).toContain("<changed>");
		expect(options.page.draft.states[0]).toMatchObject({ value: "phone edit" });
		await options.onMutation({ sessionId: "phone", page: { action: "reload" } });
		expect(fake.server.setPage).toHaveBeenCalledWith(expect.objectContaining({ draft: latest.draft }));
	});

	it("uses a real HTTP server for conflict reload, escaped identity, and the current callback/base", async () => {
		let monotonic = 0;
		const realServers: RemoteQuestionnaireServer[] = [];
		const fake = dependencies({
			clock: { now: () => 1_000, monotonicNow: () => monotonic },
			labels: () => ({ projectLabel: "<project>", sessionLabel: "session & one" }),
			createServer: async (expiresAt, options) => {
				const server = await RemoteQuestionnaireServer.create({
					expiresAt,
					clock: { now: () => 1_000 },
					...options,
				});
				realServers.push(server);
				return server;
			},
		});
		const manager = new RemoteQuestionnaireManager(settings, fake.values);
		const base: DaemonQuestionnaireRemoteSnapshot = {
			activeSessionId: "active",
			lease: {
				supervisorGeneration: "g",
				logicalRequestId: "request",
				offerId: "old",
				leaseEpoch: 1,
				logicalClientId: "l",
				connectionId: "c",
				mode: "rich",
			},
			authoritativeRevision: 1,
			request: { version: 1, title: "Title", questions: [{ id: "q", kind: "short-text", prompt: "Prompt" }] },
			draft: {
				version: 1,
				currentStep: { kind: "review" },
				states: [{ questionId: "q", kind: "short-text", value: "old" }],
			},
		};
		const latest = {
			...base,
			authoritativeRevision: 2,
			lease: { ...base.lease, offerId: "new", leaseEpoch: 2 },
			draft: { ...base.draft, states: [{ questionId: "q", kind: "short-text" as const, value: "authoritative" }] },
		};
		const next = vi.fn(async (receivedBase: DaemonQuestionnaireRemoteSnapshot) =>
			receivedBase.lease.offerId === "old"
				? {
						status: "conflict" as const,
						authoritativeRevision: 2,
						snapshot: latest,
						draft: latest.draft,
						changedQuestionIds: ["q"],
					}
				: { status: "terminal" as const },
		);
		try {
			await manager.present(base, next);
			monotonic = 300_001;
			await fake.timers.at(-1)?.();
			fake.child.stdout.write("https://real.trycloudflare.com\n");
			await vi.waitFor(() => expect(realServers).toHaveLength(1));
			const server = realServers[0]!;
			const boot = await http(`${server.url}/bootstrap`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ secret: server.fragmentSecret }),
			});
			const cookie = sessionCookie(boot);
			const csrf = (JSON.parse(boot.body) as { csrf: string }).csrf;
			const page = await http(server.url, { headers: { cookie } });
			expect(page.body).toContain("&lt;project&gt;");
			expect(page.body).toContain("session &amp; one");
			const submit = await http(`${server.url}/mutate`, {
				method: "POST",
				headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ csrf, action: "submit" }).toString(),
			});
			expect(submit.status).toBe(200);
			expect(submit.body).toContain("Reload latest");
			expect(submit.body).toContain("Prompt");
			const reload = await http(`${server.url}/mutate`, {
				method: "POST",
				headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ csrf, action: "reload" }).toString(),
			});
			expect(reload.status).toBe(303);
			const active = await http(server.url, { headers: { cookie } });
			expect(active.body).toContain("authoritative");
			await http(`${server.url}/mutate`, {
				method: "POST",
				headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ csrf, action: "submit" }).toString(),
			});
			expect(next).toHaveBeenLastCalledWith(expect.objectContaining({ lease: latest.lease }), expect.anything());
		} finally {
			await manager.dispose();
			await Promise.all(realServers.map((server) => server.close()));
		}
	});

	it("renders Submitted for a remote terminal submit and Answered elsewhere only for local terminal", async () => {
		const real = await RemoteQuestionnaireServer.create({
			page: new RemoteQuestionnairePage(
				{ version: 1, questions: [{ id: "q", kind: "short-text", prompt: "Q" }] },
				{
					version: 1,
					currentStep: { kind: "review" },
					states: [{ questionId: "q", kind: "short-text", value: "a" }],
				},
			),
			onMutation: async () => ({ kind: "terminal", message: "Submitted." }),
		});
		try {
			const boot = await http(`${real.url}/bootstrap`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ secret: real.fragmentSecret }),
			});
			const cookie = sessionCookie(boot);
			const csrf = (JSON.parse(boot.body) as { csrf: string }).csrf;
			const submitted = await http(`${real.url}/mutate`, {
				method: "POST",
				headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ csrf, action: "submit" }).toString(),
			});
			expect(submitted.headers["content-type"]).toBe("text/html; charset=utf-8");
			expect(submitted.body).toContain('<p role="status">Submitted.</p>');
		} finally {
			await real.close();
		}
	});

	it("renders Answered elsewhere through a real manager-owned HTTP server after local terminal completion", async () => {
		const realServers: RemoteQuestionnaireServer[] = [];
		let monotonicNow = 300_001;
		const fake = dependencies({
			clock: { now: () => 1_000, monotonicNow: () => monotonicNow },
			createServer: async (expiresAt, options) => {
				const server = await RemoteQuestionnaireServer.create({
					expiresAt,
					clock: { now: () => 1_000 },
					...options,
				});
				realServers.push(server);
				return server;
			},
		});
		const manager = new RemoteQuestionnaireManager(settings, fake.values);
		try {
			await manager.present(
				{
					activeSessionId: "active",
					lease: {
						supervisorGeneration: "generation",
						logicalRequestId: presentation.logicalRequestId,
						offerId: "offer",
						leaseEpoch: 1,
						logicalClientId: "client",
						connectionId: "connection",
						mode: "rich",
					},
					authoritativeRevision: 1,
					request: { version: 1, questions: [{ id: "q", kind: "short-text", prompt: "Q" }] },
					draft: {
						version: 1,
						currentStep: { kind: "review" },
						states: [{ questionId: "q", kind: "short-text", value: "a" }],
					},
				},
				async () => ({ status: "ack", authoritativeRevision: 2 }),
			);
			monotonicNow += 300_000;
			await manager.consider();
			const server = realServers[0]!;
			expect(manager.active).toBe(true);
			expect(server.status).toBe("active");
			manager.terminal();
			expect(server.status).toBe("terminal");
			const terminal = await http(server.url);
			expect(terminal.body).toContain("Answered elsewhere.");
			expect(terminal.body).not.toContain("Submitted.");
		} finally {
			await manager.dispose();
			await Promise.all(realServers.map((server) => server.close()));
		}
	});

	it("marks local terminal state before bounded cleanup so an open phone page can observe it", async () => {
		const fake = dependencies();
		const manager = new RemoteQuestionnaireManager(settings, fake.values);
		await manager.offer(presentation);
		manager.terminal();
		expect(fake.server.setTerminal).toHaveBeenCalledWith("Answered elsewhere.");
		expect(fake.server.revoke).not.toHaveBeenCalled();
		expect(fake.timers.length).toBeGreaterThan(1);
		await fake.timers.at(-1)?.();
		expect(fake.server.revoke).toHaveBeenCalledOnce();
	});

	it("keeps a remote Submitted response observable before terminal cleanup tears down its worker", async () => {
		let monotonicNow = 300_001;
		const fake = dependencies({ clock: { now: () => 1_000, monotonicNow: () => monotonicNow } });
		const manager = new RemoteQuestionnaireManager(settings, fake.values);
		const snapshot: DaemonQuestionnaireRemoteSnapshot = {
			activeSessionId: "active",
			lease: {
				supervisorGeneration: "generation",
				logicalRequestId: presentation.logicalRequestId,
				offerId: "offer",
				leaseEpoch: 1,
				logicalClientId: "client",
				connectionId: "connection",
				mode: "rich",
			},
			authoritativeRevision: 1,
			request: { version: 1, questions: [{ id: "q", kind: "short-text", prompt: "Q" }] },
			draft: {
				version: 1,
				currentStep: { kind: "review" },
				states: [{ questionId: "q", kind: "short-text", value: "phone" }],
			},
		};
		await manager.present(snapshot, async () => ({ status: "submitted" }));
		monotonicNow += 300_000;
		await manager.consider();
		const onMutation = (fake.values.createServer as ReturnType<typeof vi.fn>).mock.calls[0]?.[1].onMutation;
		const timerCount = fake.timers.length;
		expect(await onMutation({ page: { action: "submit" } })).toEqual({ kind: "terminal", message: "Submitted." });
		expect(fake.timers).toHaveLength(timerCount + 1);
		expect(fake.server.revoke).not.toHaveBeenCalled();
		expect(fake.values.processOps.signalProcessGroupOrProcess).not.toHaveBeenCalled();
		await fake.timers[timerCount]?.();
		await vi.waitFor(() => expect(manager.active).toBe(false));
		expect(fake.server.revoke).toHaveBeenCalledOnce();
		expect(fake.server.close).toHaveBeenCalledOnce();
		expect(fake.values.processOps.signalProcessGroupOrProcess).toHaveBeenCalledOnce();
		expect(fake.values.settleOrphan).toHaveBeenCalledOnce();
	});

	it("parses the exact IOHIDSystem HIDIdleTime property as a non-negative BigInt", () => {
		expect(parseHidIdleNanoseconds('"HIDIdleTime" = 300000000000\n')).toBe(300000000000n);
		expect(() => parseHidIdleNanoseconds("")).toThrow("HIDIdleTime");
		expect(() => parseHidIdleNanoseconds('"HIDIdleTime" = 1\n"HIDIdleTime" = 2')).toThrow("exactly once");
		expect(() => parseHidIdleNanoseconds('"HIDIdleTime" = -1')).toThrow("non-negative");
		expect(() => parseHidIdleNanoseconds('"HIDIdleTime" = 1.5')).toThrow("non-negative");
	});

	it("uses injected fixed-argv ioreg and rejects nonzero output", async () => {
		const child = new FakeChild();
		const spawn = vi.fn<RemoteQuestionnaireIoregDependencies["spawn"]>(() => child);
		const promise = readHidIdleNanoseconds({ spawn, setTimeout: vi.fn(() => 1), clearTimeout: vi.fn() });
		expect(spawn).toHaveBeenCalledWith("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-d", "4", "-r"], {
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout.write('"HIDIdleTime" = 300000000000\n');
		child.emit("exit", 0);
		expect(await promise).toBe(HID_IDLE_REQUIRED_NS);
		const failed = new FakeChild();
		const nonzero = readHidIdleNanoseconds({
			spawn: (_command: string, _args: readonly string[], _options: SpawnOptions) => failed,
			setTimeout: vi.fn(() => 1),
			clearTimeout: vi.fn(),
		});
		failed.emit("exit", 1);
		await expect(nonzero).rejects.toThrow("nonzero");
	});

	it("kills injected ioreg on timeout and rejects malformed, duplicate, and nonzero output", async () => {
		const timers: Array<() => void> = [];
		const child = new FakeChild();
		const timedOut = readHidIdleNanoseconds({
			spawn: (_command: string, _args: readonly string[], _options: SpawnOptions) => child,
			setTimeout: (callback) => {
				timers.push(callback);
				return 1;
			},
			clearTimeout: vi.fn(),
		});
		timers[0]!();
		child.emit("exit", 0);
		await expect(timedOut).rejects.toThrow("timed out");
		expect(child.kill).toHaveBeenCalledWith("SIGKILL");
	});

	it("passes recipient and body only as fixed osascript argv with no shell", async () => {
		const child = new FakeChild();
		const spawn = vi.fn<RemoteQuestionnaireMessageDependencies["spawn"]>(() => child);
		const send = sendIMessage("+12225550123", "Hello 😀", {
			spawn,
			setTimeout: vi.fn(() => 1),
			clearTimeout: vi.fn(),
		});
		expect(spawn.mock.calls[0]?.[0]).toBe("/usr/bin/osascript");
		expect(spawn.mock.calls[0]?.[1]?.slice(-2)).toEqual(["+12225550123", "Hello 😀"]);
		expect(spawn.mock.calls[0]?.[2]).toEqual({ shell: false, stdio: "ignore" });
		child.emit("exit", 0);
		await expect(send).resolves.toBeUndefined();
		const failed = new FakeChild();
		const failure = sendIMessage("+12225550123", "Hello", {
			spawn: (_command: string, _args: readonly string[], _options: SpawnOptions) => failed,
			setTimeout: vi.fn(() => 1),
			clearTimeout: vi.fn(),
		});
		failed.emit("exit", 1);
		await expect(failure).rejects.toThrow("failed");
	});

	(process.platform === "darwin" ? it : it.skip)(
		"reads Darwin IOHIDSystem with the approved read-only smoke",
		async () => {
			await expect(readHidIdleNanoseconds()).resolves.toSatisfy((value) => value >= 0n);
		},
	);

	it("requires Darwin, rich transport, continuous age, and independently verified fixed HID idle", async () => {
		const fake = dependencies({ platform: "linux" });
		await new RemoteQuestionnaireManager(settings, fake.values).offer(presentation);
		expect(fake.values.readHidIdleNanoseconds).not.toHaveBeenCalled();
		expect(fake.values.spawn).not.toHaveBeenCalled();
		const young = dependencies({ clock: { now: () => 1, monotonicNow: () => 299_999 } });
		await new RemoteQuestionnaireManager(settings, young.values).offer(presentation);
		expect(young.values.readHidIdleNanoseconds).not.toHaveBeenCalled();
		const active = dependencies({ readHidIdleNanoseconds: vi.fn(async () => HID_IDLE_REQUIRED_NS - 1n) });
		await new RemoteQuestionnaireManager(settings, active.values).offer(presentation);
		expect(active.values.spawn).not.toHaveBeenCalled();
	});

	it("starts a loopback listener before one detached fixed-argv tunnel and discovers chunk-split stderr URLs", async () => {
		const fake = dependencies();
		const manager = new RemoteQuestionnaireManager(settings, fake.values);
		await manager.offer(presentation);
		expect(fake.values.createServer).toHaveBeenCalledBefore(fake.values.spawn as ReturnType<typeof vi.fn>);
		expect(fake.values.spawn).toHaveBeenCalledWith(
			settings.cloudflaredPath,
			["tunnel", "--no-autoupdate", "--protocol", "http2", "--metrics", "127.0.0.1:0", "--url", fake.server.url],
			{ detached: true, shell: false, stdio: ["ignore", "pipe", "pipe"] },
		);
		fake.child.stderr.write("INF https://blue-");
		fake.child.stderr.write("forest.trycloudflare.com ready\n");
		await vi.waitFor(() => expect(fake.messages).toHaveLength(1));
		expect(fake.server.setPublicHostname).toHaveBeenCalledWith("blue-forest.trycloudflare.com");
		expect(fake.messages[0]?.body).toContain("#secret");
	});

	it("has a bounded chunk-safe URL parser that accepts same-host duplicates and rejects different hosts", () => {
		const parser = new QuickTunnelUrlParser();
		expect(parser.push("x https://one.trycloudflare.com/")).toBe("one.trycloudflare.com");
		expect(parser.push("https://one.trycloudflare.com/")).toBe("one.trycloudflare.com");
		expect(() => parser.push("https://two.trycloudflare.com/")).toThrow("multiple");
	});

	it("keeps process-lifetime delivery caps across revoke and only permits one changed-host replacement after success", async () => {
		const first = dependencies();
		const manager = new RemoteQuestionnaireManager(settings, first.values);
		await manager.offer(presentation);
		first.child.stdout.write("https://one.trycloudflare.com\n");
		await vi.waitFor(() => expect(first.messages).toHaveLength(1));
		await manager.revoke();
		const second = dependencies();
		// Preserve dependencies so the in-memory ledger is tested without creating a second process manager.
		(first.values.spawn as ReturnType<typeof vi.fn>).mockImplementation(() => second.child);
		(first.values.createServer as ReturnType<typeof vi.fn>).mockImplementation(async () => second.server);
		await manager.offer(presentation);
		second.child.stdout.write("https://two.trycloudflare.com\n");
		await vi.waitFor(() => expect(first.messages).toHaveLength(2));
		await manager.revoke();
		await manager.offer(presentation);
		second.child.stdout.write("https://three.trycloudflare.com\n");
		await new Promise((resolve) => setImmediate(resolve));
		expect(first.messages).toHaveLength(2);
	});

	it("shares process-scoped caps across replacement managers and permits one changed-host replacement", async () => {
		const logicalRequestId = `handoff-${Date.now()}-${Math.random()}`;
		const request = { ...presentation, logicalRequestId };
		const first = dependencies();
		const { messageCaps: _firstLedger, ...firstDefaultDependencies } = first.values;
		const managerA = new RemoteQuestionnaireManager(settings, firstDefaultDependencies);
		await managerA.offer(request);
		first.child.stdout.write("https://one.trycloudflare.com\n");
		await vi.waitFor(() => expect(first.messages).toHaveLength(1));
		await managerA.dispose();

		const second = dependencies();
		const { messageCaps: _secondLedger, ...secondDefaultDependencies } = second.values;
		const managerB = new RemoteQuestionnaireManager(settings, secondDefaultDependencies);
		await managerB.offer(request);
		second.child.stdout.write("https://one.trycloudflare.com\n");
		await new Promise((resolve) => setImmediate(resolve));
		expect(second.messages).toHaveLength(0);
		await managerB.revoke();
		const replacementChild = new FakeChild();
		(second.values.spawn as ReturnType<typeof vi.fn>).mockImplementation(() => replacementChild);
		await managerB.offer(request);
		replacementChild.stderr.write("https://two.trycloudflare.com\n");
		await vi.waitFor(() => expect(second.messages).toHaveLength(1));
		await managerB.revoke();

		const third = dependencies();
		const { messageCaps: _thirdLedger, ...thirdDefaultDependencies } = third.values;
		const managerC = new RemoteQuestionnaireManager(settings, thirdDefaultDependencies);
		await managerC.offer(request);
		third.child.stdout.write("https://three.trycloudflare.com\n");
		await new Promise((resolve) => setImmediate(resolve));
		expect(third.messages).toHaveLength(0);
		await managerC.dispose();
	});

	it("contains server creation failures and releases all pending resources", async () => {
		const fake = dependencies({ createServer: vi.fn(async () => Promise.reject(new Error("bind failed"))) });
		const manager = new RemoteQuestionnaireManager(settings, fake.values);
		await expect(manager.offer(presentation)).resolves.toBeUndefined();
		expect(manager.active).toBe(false);
		expect(fake.values.spawn).not.toHaveBeenCalled();
		expect(fake.values.timers.clearTimeout).toHaveBeenCalledWith(0);
	});

	it("continues cleanup when process operations and orphan settlement throw", async () => {
		const fake = dependencies({
			processOps: {
				signalProcessGroupOrProcess: vi.fn(() => {
					throw new Error("signal failed");
				}),
				waitForExit: vi.fn(async () => {
					throw new Error("wait failed");
				}),
			},
			settleOrphan: vi.fn(() => {
				throw new Error("settle failed");
			}),
		});
		const manager = new RemoteQuestionnaireManager(settings, fake.values);
		await manager.offer(presentation);
		await expect(manager.dispose()).resolves.toBeUndefined();
		expect(fake.server.revoke).toHaveBeenCalledOnce();
		expect(fake.server.close).toHaveBeenCalledOnce();
	});

	it("coalesces stdout/stderr readiness and error/exit restart races without duplicate delivery", async () => {
		const firstChild = new FakeChild();
		const secondChild = new FakeChild();
		const fake = dependencies({ spawn: vi.fn(() => firstChild) });
		const manager = new RemoteQuestionnaireManager(settings, fake.values);
		await manager.offer(presentation);
		firstChild.stdout.write("https://one.trycloudflare.com\n");
		firstChild.stderr.write("https://one.trycloudflare.com\n");
		await vi.waitFor(() => expect(fake.messages).toHaveLength(1));
		firstChild.emit("error", new Error("failed"));
		firstChild.emit("exit", 1, null);
		await vi.waitFor(() => expect(fake.timers).toHaveLength(3));
		(fake.values.spawn as ReturnType<typeof vi.fn>).mockImplementation(() => secondChild);
		await fake.timers.at(-1)!();
		secondChild.stdout.write("https://two.trycloudflare.com\n");
		await new Promise((resolve) => setImmediate(resolve));
		expect(fake.values.spawn).toHaveBeenCalledTimes(2);
		expect(fake.messages).toHaveLength(2);
	});

	it("does not redeliver an original when exit races a pending send", async () => {
		const firstChild = new FakeChild();
		const secondChild = new FakeChild();
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const send = vi.fn(() => pending);
		const fake = dependencies({ message: { send }, spawn: vi.fn(() => firstChild) });
		const manager = new RemoteQuestionnaireManager(settings, fake.values);
		await manager.offer(presentation);
		firstChild.stdout.write("https://one.trycloudflare.com\n");
		await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
		firstChild.emit("exit", 1, null);
		await vi.waitFor(() => expect(fake.timers).toHaveLength(3));
		(fake.values.spawn as ReturnType<typeof vi.fn>).mockImplementation(() => secondChild);
		await fake.timers.at(-1)!();
		secondChild.stderr.write("https://two.trycloudflare.com\n");
		release();
		await new Promise((resolve) => setImmediate(resolve));
		expect(send).toHaveBeenCalledOnce();
	});

	it("restarts a hostname-less readiness timeout only through its bounded retry budget", async () => {
		const children = [new FakeChild(), new FakeChild(), new FakeChild()];
		const fake = dependencies({ spawn: vi.fn(() => children.shift()!) });
		const manager = new RemoteQuestionnaireManager(settings, fake.values);
		await manager.offer(presentation);
		for (let attempt = 0; attempt < 3; attempt++) {
			const readiness = fake.timers.at(-1)!;
			readiness();
			if (attempt < 2) {
				await vi.waitFor(() => expect(fake.timers).toHaveLength(3 + attempt * 2));
				await fake.timers.at(-1)!();
				await vi.waitFor(() => expect(fake.values.spawn).toHaveBeenCalledTimes(attempt + 2));
			}
		}
		await vi.waitFor(() => expect(fake.server.revoke).toHaveBeenCalledOnce());
		expect(fake.values.spawn).toHaveBeenCalledTimes(3);
		expect(manager.active).toBe(false);
		expect(fake.values.timers.clearTimeout).toHaveBeenCalled();
	});

	it("performs idempotent grace then forced identity-safe cleanup without touching local callbacks", async () => {
		const fake = dependencies({
			processOps: { signalProcessGroupOrProcess: vi.fn(), waitForExit: vi.fn(async () => false) },
		});
		const manager = new RemoteQuestionnaireManager(settings, fake.values);
		await manager.offer(presentation);
		await manager.dispose();
		expect(fake.values.processOps.signalProcessGroupOrProcess).toHaveBeenNthCalledWith(1, 123, "SIGTERM");
		expect(fake.values.processOps.signalProcessGroupOrProcess).toHaveBeenNthCalledWith(2, 123, "SIGKILL");
		expect(fake.values.settleOrphan).toHaveBeenCalledOnce();
		expect(fake.server.revoke).toHaveBeenCalledOnce();
		await manager.dispose();
		expect(fake.values.settleOrphan).toHaveBeenCalledOnce();
	});

	it("schedules remaining age and idle rechecks rather than permanently returning after activity", async () => {
		let monotonic = 0;
		const fake = dependencies({
			clock: { now: () => 1_000, monotonicNow: () => monotonic },
			readHidIdleNanoseconds: vi.fn(async () => 0n),
		});
		const manager = new RemoteQuestionnaireManager(settings, fake.values);
		await manager.offer(presentation);
		expect(fake.timers).toHaveLength(2); // expiry plus remaining presentation age
		monotonic = 300_000;
		await fake.timers[1]!();
		expect(fake.values.readHidIdleNanoseconds).toHaveBeenCalledOnce();
		expect(fake.timers).toHaveLength(3); // an idle recheck is scheduled after activity
	});

	it("builds only bounded Unicode-safe context and link disclosure", () => {
		const body = buildRemoteQuestionnaireMessage(
			{ ...presentation, firstPrompt: "😀".repeat(500) },
			"https://x.trycloudflare.com/r/a#b",
		);
		expect(body).toContain("prime · session · Deploy");
		expect(body).toContain("https://x.trycloudflare.com/r/a#b");
		expect(Array.from(body).length).toBeLessThan(600);
	});

	it("fails closed when orphan recording fails before public readiness, without leaking its child", async () => {
		const fake = dependencies({
			recordOrphan: vi.fn(() => {
				throw new Error("journal unavailable");
			}),
		});
		const manager = new RemoteQuestionnaireManager(settings, fake.values);
		await manager.offer(presentation);
		fake.child.stdout.write("https://one.trycloudflare.com\n");
		await new Promise((resolve) => setImmediate(resolve));
		expect(fake.server.setPublicHostname).not.toHaveBeenCalled();
		expect(fake.messages).toHaveLength(0);
		expect(fake.values.processOps.signalProcessGroupOrProcess).toHaveBeenCalledWith(fake.child.pid, "SIGTERM");
		expect(fake.values.processOps.waitForExit).toHaveBeenCalledWith(fake.child.pid, 1000);
		expect(fake.server.revoke).toHaveBeenCalledOnce();
		expect(fake.values.settleOrphan).not.toHaveBeenCalled();
	});

	it("ignores late stdout, stderr, error, and exit events from an old tunnel generation", async () => {
		const firstChild = new FakeChild();
		const secondChild = new FakeChild();
		const fake = dependencies();
		(fake.values.spawn as ReturnType<typeof vi.fn>)
			.mockImplementationOnce(() => firstChild)
			.mockImplementationOnce(() => secondChild);
		const manager = new RemoteQuestionnaireManager(settings, fake.values);
		await manager.offer(presentation);
		firstChild.emit("exit", 1, null);
		await vi.waitFor(() => expect(fake.timers).toHaveLength(3));
		await fake.timers.at(-1)!();
		await vi.waitFor(() => expect(fake.values.spawn).toHaveBeenCalledTimes(2));
		secondChild.stdout.write("https://two.trycloudflare.com\n");
		await vi.waitFor(() => expect(fake.messages).toHaveLength(1));
		firstChild.stdout.write("https://old-stdout.trycloudflare.com\n");
		firstChild.stderr.write("https://old-stderr.trycloudflare.com\n");
		firstChild.emit("error", new Error("late"));
		firstChild.emit("exit", 1, null);
		await new Promise((resolve) => setImmediate(resolve));
		expect(fake.server.setPublicHostname).toHaveBeenLastCalledWith("two.trycloudflare.com");
		expect(fake.messages).toHaveLength(1);
		expect(fake.values.spawn).toHaveBeenCalledTimes(2);
	});

	it("discovers a valid public hostname from stdout as well as stderr", async () => {
		const fake = dependencies();
		const manager = new RemoteQuestionnaireManager(settings, fake.values);
		await manager.offer(presentation);
		fake.child.stdout.write("INF https://stdout-host.trycloudflare.com ready\n");
		await vi.waitFor(() => expect(fake.messages).toHaveLength(1));
		expect(fake.server.setPublicHostname).toHaveBeenCalledWith("stdout-host.trycloudflare.com");
	});

	it("restarts exactly twice, then exhausts without restarting after revoke or dispose", async () => {
		const children = [new FakeChild(), new FakeChild(), new FakeChild(), new FakeChild()];
		const fake = dependencies({ spawn: vi.fn(() => children.shift()!) });
		const manager = new RemoteQuestionnaireManager(settings, fake.values);
		await manager.offer(presentation);
		for (let restart = 0; restart < 2; restart++) {
			const child = (fake.values.spawn as ReturnType<typeof vi.fn>).mock.results[restart]?.value as FakeChild;
			child.emit("exit", 1, null);
			await vi.waitFor(() => expect(fake.timers).toHaveLength(restart * 2 + 3));
			await fake.timers[restart * 2 + 2]!();
			await vi.waitFor(() => expect(fake.values.spawn).toHaveBeenCalledTimes(restart + 2));
		}
		const finalChild = (fake.values.spawn as ReturnType<typeof vi.fn>).mock.results[2]?.value as FakeChild;
		finalChild.emit("exit", 1, null);
		await new Promise((resolve) => setImmediate(resolve));
		expect(fake.values.spawn).toHaveBeenCalledTimes(3);
		await manager.revoke();
		await manager.dispose();
		expect(fake.values.spawn).toHaveBeenCalledTimes(3);
	});

	it("settles and closes on delivery failure without consuming the successful-original cap or scheduling restart", async () => {
		const firstChild = new FakeChild();
		const secondChild = new FakeChild();
		const send = vi.fn().mockRejectedValueOnce(new Error("Messages unavailable")).mockResolvedValueOnce(undefined);
		const fake = dependencies({ message: { send }, spawn: vi.fn(() => firstChild) });
		const manager = new RemoteQuestionnaireManager(settings, fake.values);
		await manager.offer(presentation);
		firstChild.stderr.write("https://one.trycloudflare.com\n");
		await vi.waitFor(() => expect(fake.values.settleOrphan).toHaveBeenCalledOnce());
		expect(fake.server.revoke).toHaveBeenCalledOnce();
		// The attempted original is reserved before Messages is awaited, so racing output
		// cannot invoke Messages twice after a failure.
		expect(manager.messageCaps.get(presentation.logicalRequestId)).toMatchObject({ original: true });
		expect(fake.timers).toHaveLength(2);
		(fake.values.spawn as ReturnType<typeof vi.fn>).mockImplementation(() => secondChild);
		await manager.offer(presentation);
		secondChild.stdout.write("https://two.trycloudflare.com\n");
		await new Promise((resolve) => setImmediate(resolve));
		expect(send).toHaveBeenCalledOnce();
	});

	it("does not activate a pending offer after the wall clock has jumped past expiry", async () => {
		let now = 1_000;
		let monotonic = 0;
		const fake = dependencies({ clock: { now: () => now, monotonicNow: () => monotonic } });
		const manager = new RemoteQuestionnaireManager(settings, fake.values);
		await manager.offer(presentation);
		now += settings.linkLifetimeHours * 3_600_000;
		monotonic = 300_001;
		await manager.consider();
		expect(fake.values.createServer).not.toHaveBeenCalled();
		expect(fake.values.spawn).not.toHaveBeenCalled();
		expect(fake.values.timers.clearTimeout).toHaveBeenCalledWith(0);
		expect(fake.values.timers.clearTimeout).toHaveBeenCalledWith(1);
	});

	it("does not publish or deliver a tunnel discovered after expiry", async () => {
		let now = 1_000;
		const fake = dependencies({ clock: { now: () => now, monotonicNow: () => 300_001 } });
		const manager = new RemoteQuestionnaireManager(settings, fake.values);
		await manager.offer(presentation);
		now += settings.linkLifetimeHours * 3_600_000;
		fake.child.stdout.write("https://expired.trycloudflare.com\n");
		await vi.waitFor(() => expect(fake.server.revoke).toHaveBeenCalledOnce());
		expect(fake.server.setPublicHostname).not.toHaveBeenCalled();
		expect(fake.messages).toHaveLength(0);
		expect(fake.values.settleOrphan).toHaveBeenCalledOnce();
	});

	it("cleans expired resources after a clock jump and cancels eligibility timers on revoke", async () => {
		let now = 1_000;
		const live = dependencies({ clock: { now: () => now, monotonicNow: () => 300_001 } });
		const activeManager = new RemoteQuestionnaireManager(settings, live.values);
		await activeManager.offer(presentation);
		now += settings.linkLifetimeHours * 3_600_000;
		await live.timers[0]!();
		await vi.waitFor(() => expect(live.values.settleOrphan).toHaveBeenCalledOnce());
		expect(live.server.revoke).toHaveBeenCalledOnce();
		expect(activeManager.active).toBe(false);

		const young = dependencies({ clock: { now: () => 1_000, monotonicNow: () => 0 } });
		const youngManager = new RemoteQuestionnaireManager(settings, young.values);
		await youngManager.offer(presentation);
		await youngManager.revoke();
		expect(young.values.timers.clearTimeout).toHaveBeenCalledWith(0);
		expect(young.values.timers.clearTimeout).toHaveBeenCalledWith(1);
	});
});

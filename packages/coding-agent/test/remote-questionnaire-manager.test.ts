import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
	buildRemoteQuestionnaireMessage,
	HID_IDLE_REQUIRED_NS,
	parseHidIdleNanoseconds,
	QuickTunnelUrlParser,
	RemoteQuestionnaireManager,
	type RemoteQuestionnaireManagerDependencies,
	readHidIdleNanoseconds,
	sendIMessage,
} from "../src/modes/interactive/remote-questionnaire-manager.js";

class FakeChild extends EventEmitter {
	pid = 123;
	stdout = new PassThrough();
	stderr = new PassThrough();
	kill = vi.fn();
}

function dependencies(overrides: Partial<RemoteQuestionnaireManagerDependencies> = {}) {
	const child = new FakeChild();
	const server = {
		url: "http://127.0.0.1:4444/r/route",
		routeId: "route",
		fragmentSecret: "secret",
		setPublicHostname: vi.fn(),
		revoke: vi.fn(),
		close: vi.fn(),
	};
	const messages: Array<{ recipient: string; body: string }> = [];
	const timers: Array<() => void> = [];
	const values: RemoteQuestionnaireManagerDependencies = {
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
		spawn: vi.fn(() => child),
		message: { send: vi.fn(async (recipient, body) => messages.push({ recipient, body })) },
		createServer: vi.fn(async () => server),
		journalPath: () => "/tmp/journal",
		recordOrphan: vi.fn(() => ({ processStartId: "child", ownerPid: 2, ownerProcessStartId: "owner" })),
		settleOrphan: vi.fn(),
		processOps: { signalProcessGroupOrProcess: vi.fn(), waitForExit: vi.fn(async () => true) },
		...overrides,
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

describe("RemoteQuestionnaireManager", () => {
	it("parses the exact IOHIDSystem HIDIdleTime property as a non-negative BigInt", () => {
		expect(parseHidIdleNanoseconds('"HIDIdleTime" = 300000000000\n')).toBe(300000000000n);
		expect(() => parseHidIdleNanoseconds("")).toThrow("HIDIdleTime");
		expect(() => parseHidIdleNanoseconds('"HIDIdleTime" = 1\n"HIDIdleTime" = 2')).toThrow("exactly once");
		expect(() => parseHidIdleNanoseconds('"HIDIdleTime" = -1')).toThrow("non-negative");
		expect(() => parseHidIdleNanoseconds('"HIDIdleTime" = 1.5')).toThrow("non-negative");
	});

	it("uses injected fixed-argv ioreg and rejects nonzero output", async () => {
		const child = new FakeChild();
		const spawn = vi.fn(() => child);
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
			spawn: () => failed,
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
			spawn: () => child,
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
		const spawn = vi.fn(() => child);
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
			spawn: () => failed,
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
			["tunnel", "--no-autoupdate", "--metrics", "127.0.0.1:0", "--url", fake.server.url],
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
		await vi.waitFor(() => expect(fake.timers).toHaveLength(2));
		await fake.timers[1]!();
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
			await vi.waitFor(() => expect(fake.timers).toHaveLength(restart + 2));
			await fake.timers[restart + 1]!();
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
		expect(manager.messageCaps.get(presentation.logicalRequestId)).toBeUndefined();
		expect(fake.timers).toHaveLength(1);
		(fake.values.spawn as ReturnType<typeof vi.fn>).mockImplementation(() => secondChild);
		await manager.offer(presentation);
		secondChild.stdout.write("https://two.trycloudflare.com\n");
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
		expect(manager.messageCaps.get(presentation.logicalRequestId)).toMatchObject({
			original: true,
			replacement: false,
		});
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

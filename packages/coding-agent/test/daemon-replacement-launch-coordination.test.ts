import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";

const launchMocks = vi.hoisted(() => ({
	spawn: vi.fn(),
	isShutdownAdmissionActive: vi.fn(async () => false),
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, spawn: launchMocks.spawn };
});

vi.mock("../src/cli/subprocess-launch.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		createCliSubprocessLaunchSpec: vi.fn(() => ({ command: "fake-prime-agent", args: [] })),
		createCliSubprocessEnv: vi.fn(() => ({ ...process.env })),
	};
});

vi.mock("../src/modes/daemon/daemon-supervisor-ownership.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, isDaemonShutdownAdmissionActive: launchMocks.isShutdownAdmissionActive };
});

class FakeCandidate extends EventEmitter {
	readonly unref = vi.fn();

	constructor(readonly pid: number = process.pid) {
		super();
	}
}

interface ReplacementLaunchHarness {
	shuttingDown: boolean;
	supervisorLaunchInProgress: boolean;
	canConnectToSupervisor: ReturnType<typeof vi.fn>;
	launchReplacementSupervisor(socketPath: string): Promise<void>;
}

const roots = new Set<string>();

function launchLockDirectory(socketPath: string): string {
	const key = createHash("sha256").update(socketPath).digest("hex").slice(0, 12);
	return join(dirname(socketPath), `.supervisor-launch-${key}.lock`);
}

function createHarness(
	root: string,
	isReady: () => boolean,
	isProcessAlive: (pid: number) => boolean = (pid) => pid === process.pid,
): ReplacementLaunchHarness {
	return Object.assign(Object.create(AgentDaemon.prototype), {
		shuttingDown: false,
		supervisorLaunchInProgress: false,
		options: { defaultSessionConfig: { cwd: root, agentDir: root } },
		canConnectToSupervisor: vi.fn(async () => isReady()),
		isProcessAlive: vi.fn(isProcessAlive),
		log: vi.fn(),
	}) as ReplacementLaunchHarness;
}

async function flushPromises(): Promise<void> {
	for (let index = 0; index < 5; index++) {
		await Promise.resolve();
	}
}

describe("replacement supervisor launch coordination", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		launchMocks.spawn.mockReset();
		launchMocks.isShutdownAdmissionActive.mockReset();
		launchMocks.isShutdownAdmissionActive.mockResolvedValue(false);
	});

	afterEach(() => {
		vi.useRealTimers();
		for (const root of roots) {
			rmSync(root, { recursive: true, force: true });
		}
		roots.clear();
	});

	it("keeps launch ownership for a live candidate beyond ten seconds until its socket is ready", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-replacement-launch-slow-test-"));
		roots.add(root);
		const socketPath = join(root, "supervisor.sock");
		let ready = false;
		const daemon = createHarness(root, () => ready);
		const contender = createHarness(root, () => false);
		const candidates: FakeCandidate[] = [];
		launchMocks.spawn.mockImplementation(() => {
			const candidate = new FakeCandidate();
			candidates.push(candidate);
			return candidate as unknown as ChildProcess;
		});

		const firstLaunch = daemon.launchReplacementSupervisor(socketPath);
		await flushPromises();
		expect(candidates).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(10_050);
		const ownershipSurvivedOldDeadline = daemon.supervisorLaunchInProgress;
		const lockSurvivedOldDeadline = existsSync(launchLockDirectory(socketPath));
		const competingLaunch = contender.launchReplacementSupervisor(socketPath);
		await competingLaunch;
		const launchCountWhileCandidateWasLive = launchMocks.spawn.mock.calls.length;

		ready = true;
		await vi.advanceTimersByTimeAsync(50);
		await Promise.all([firstLaunch, competingLaunch]);

		expect(ownershipSurvivedOldDeadline).toBe(true);
		expect(lockSurvivedOldDeadline).toBe(true);
		expect(launchCountWhileCandidateWasLive).toBe(1);
		expect(contender.supervisorLaunchInProgress).toBe(false);
		expect(daemon.supervisorLaunchInProgress).toBe(false);
		expect(existsSync(launchLockDirectory(socketPath))).toBe(false);
	});

	it("preserves candidate ownership when the launching worker shuts down", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-replacement-launch-shutdown-test-"));
		roots.add(root);
		const socketPath = join(root, "supervisor.sock");
		const candidatePid = 987_654;
		let ready = false;
		let contenderReady = false;
		const daemon = createHarness(root, () => ready);
		const contender = createHarness(
			root,
			() => contenderReady,
			(pid) => pid === candidatePid,
		);
		const candidates: FakeCandidate[] = [];
		launchMocks.spawn.mockImplementation(() => {
			const candidate = new FakeCandidate(candidates.length === 0 ? candidatePid : process.pid);
			candidates.push(candidate);
			return candidate as unknown as ChildProcess;
		});

		const firstLaunch = daemon.launchReplacementSupervisor(socketPath);
		await flushPromises();
		expect(candidates).toHaveLength(1);
		const lockPath = launchLockDirectory(socketPath);
		const ownerPids = readFileSync(join(lockPath, "pid"), "utf8").trim().split(/\s+/).map(Number);

		daemon.shuttingDown = true;
		await vi.advanceTimersByTimeAsync(50);
		const ownershipHeldDuringShutdown = daemon.supervisorLaunchInProgress;
		const competingLaunch = contender.launchReplacementSupervisor(socketPath);
		await flushPromises();
		const launchCountWhileCandidateWasLive = launchMocks.spawn.mock.calls.length;

		ready = true;
		contenderReady = true;
		await vi.advanceTimersByTimeAsync(50);
		await Promise.all([firstLaunch, competingLaunch]);

		expect(ownerPids).toEqual(expect.arrayContaining([process.pid, candidatePid]));
		expect(ownershipHeldDuringShutdown).toBe(true);
		expect(launchCountWhileCandidateWasLive).toBe(1);
		expect(contender.supervisorLaunchInProgress).toBe(false);
		expect(daemon.supervisorLaunchInProgress).toBe(false);
		expect(existsSync(lockPath)).toBe(false);
	});

	it("releases launch ownership when a candidate exits and allows a successful retry", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-replacement-launch-exit-test-"));
		roots.add(root);
		const socketPath = join(root, "supervisor.sock");
		let ready = false;
		const daemon = createHarness(root, () => ready);
		const candidates: FakeCandidate[] = [];
		launchMocks.spawn.mockImplementation(() => {
			const candidate = new FakeCandidate();
			candidates.push(candidate);
			return candidate as unknown as ChildProcess;
		});

		const failedLaunch = daemon.launchReplacementSupervisor(socketPath);
		await flushPromises();
		expect(candidates).toHaveLength(1);
		candidates[0]!.emit("exit", 1, null);
		await flushPromises();
		const releasedAfterExit = !daemon.supervisorLaunchInProgress;
		const removedLockAfterExit = !existsSync(launchLockDirectory(socketPath));

		await vi.advanceTimersByTimeAsync(10_050);
		await failedLaunch;
		const retry = daemon.launchReplacementSupervisor(socketPath);
		await flushPromises();
		expect(candidates).toHaveLength(2);
		ready = true;
		await vi.advanceTimersByTimeAsync(50);
		await retry;

		expect(releasedAfterExit).toBe(true);
		expect(removedLockAfterExit).toBe(true);
		expect(daemon.supervisorLaunchInProgress).toBe(false);
		expect(existsSync(launchLockDirectory(socketPath))).toBe(false);
	});

	it("handles an asynchronous spawn failure and releases launch ownership", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-replacement-launch-error-test-"));
		roots.add(root);
		const socketPath = join(root, "supervisor.sock");
		const daemon = createHarness(root, () => false);
		const candidate = new FakeCandidate();
		launchMocks.spawn.mockReturnValue(candidate as unknown as ChildProcess);

		const launch = daemon.launchReplacementSupervisor(socketPath);
		await flushPromises();
		let emittedError: unknown;
		try {
			candidate.emit("error", new Error("spawn failed"));
		} catch (error) {
			emittedError = error;
		}
		await flushPromises();
		const releasedAfterError = !daemon.supervisorLaunchInProgress;
		const removedLockAfterError = !existsSync(launchLockDirectory(socketPath));

		await vi.advanceTimersByTimeAsync(10_050);
		await launch;

		expect(emittedError).toBeUndefined();
		expect(releasedAfterError).toBe(true);
		expect(removedLockAfterError).toBe(true);
	});
});

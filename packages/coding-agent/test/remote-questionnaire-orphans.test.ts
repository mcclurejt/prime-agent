import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	getRemoteQuestionnaireOrphanJournalPath,
	REMOTE_QUESTIONNAIRE_ORPHAN_JOURNAL_FILENAME,
	type RemoteQuestionnaireOrphanProcessOps,
	reapRemoteQuestionnaireOrphans,
	recordRemoteQuestionnaireOrphan,
	settleRemoteQuestionnaireOrphan,
} from "../src/modes/interactive/remote-questionnaire-orphans.js";

const directories: string[] = [];

function makePath(): string {
	const directory = mkdtempSync(join(tmpdir(), "prime-remote-questionnaire-orphans-"));
	directories.push(directory);
	return join(directory, "remote-questionnaire-orphans.jsonl");
}

function processOps(startIds: Record<number, string | undefined>, alive: Set<number>) {
	const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
	const ops: RemoteQuestionnaireOrphanProcessOps = {
		getProcessStartId: (pid) => startIds[pid],
		isProcessAlive: (pid) => alive.has(pid),
		signalProcessGroupOrProcess: (pid, signal) => signals.push({ pid, signal }),
		waitForExit: async (pid) => {
			alive.delete(pid);
			return true;
		},
	};
	return { ops, signals };
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("remote questionnaire orphan journal", () => {
	it("records only child and owner process identities at the configured path with private mode", () => {
		const path = makePath();
		const { ops } = processOps({ 41: "child-start", 42: "owner-start" }, new Set([41, 42]));

		recordRemoteQuestionnaireOrphan(path, 41, { ownerPid: 42, processOps: ops });

		expect(statSync(path).mode & 0o777).toBe(0o600);
		const record = JSON.parse(readFileSync(path, "utf8"));
		expect(record).toEqual({
			version: 2,
			pid: 41,
			processStartId: "child-start",
			ownerPid: 42,
			ownerProcessStartId: "owner-start",
			active: true,
		});
		expect(Object.keys(record).sort()).toEqual([
			"active",
			"ownerPid",
			"ownerProcessStartId",
			"pid",
			"processStartId",
			"version",
		]);
	});

	it("fails closed before readiness when either identity cannot be recorded", () => {
		const path = makePath();
		const { ops } = processOps({ 41: undefined, 42: "owner-start" }, new Set([41, 42]));
		expect(() => recordRemoteQuestionnaireOrphan(path, 41, { ownerPid: 42, processOps: ops })).toThrow(
			"process identity",
		);
	});

	it("preserves live and interleaved records while compacting settled records", async () => {
		const path = makePath();
		const { ops } = processOps({ 1: "child-1", 2: "child-2", 11: "owner-1", 12: "owner-2" }, new Set([1, 2, 11, 12]));
		recordRemoteQuestionnaireOrphan(path, 1, { ownerPid: 11, processOps: ops });
		recordRemoteQuestionnaireOrphan(path, 2, { ownerPid: 12, processOps: ops });
		settleRemoteQuestionnaireOrphan(path, 1, {
			processStartId: "child-1",
			ownerPid: 11,
			ownerProcessStartId: "owner-1",
		});
		await reapRemoteQuestionnaireOrphans(path, { processOps: ops });

		expect(readFileSync(path, "utf8")).not.toContain('"pid":1');
		expect(readFileSync(path, "utf8")).toContain('"pid":2');
	});

	it("skips a live identity-matched owner, reaps only exact child identities for dead or mismatched owners, and refuses PID reuse", async () => {
		const path = makePath();
		const { ops, signals } = processOps(
			{
				1: "child-live",
				2: "child-dead-owner",
				3: "reused-child",
				11: "owner-live",
				12: "owner-dead",
				13: "owner-now-different",
			},
			new Set([1, 2, 3, 11, 13]),
		);
		writeFileSync(
			path,
			[
				{
					version: 2,
					pid: 1,
					processStartId: "child-live",
					ownerPid: 11,
					ownerProcessStartId: "owner-live",
					active: true,
				},
				{
					version: 2,
					pid: 2,
					processStartId: "child-dead-owner",
					ownerPid: 12,
					ownerProcessStartId: "owner-dead",
					active: true,
				},
				{
					version: 2,
					pid: 3,
					processStartId: "recorded-reused-child",
					ownerPid: 13,
					ownerProcessStartId: "recorded-owner-old",
					active: true,
				},
			]
				.map((record) => JSON.stringify(record))
				.join("\n"),
		);

		await reapRemoteQuestionnaireOrphans(path, { processOps: ops, graceMs: 0 });

		expect(signals).toEqual([{ pid: 2, signal: "SIGTERM" }]);
		const remaining = readFileSync(path, "utf8");
		expect(remaining).toContain('"pid":1');
		expect(remaining).not.toContain('"pid":2');
		expect(remaining).not.toContain('"pid":3');
	});

	it("uses a forced process-group cleanup only after grace expires and never sends job-control signals", async () => {
		const path = makePath();
		const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
		const ops: RemoteQuestionnaireOrphanProcessOps = {
			getProcessStartId: (pid) => ({ 5: "child", 15: "owner" })[pid],
			isProcessAlive: (pid) => pid === 5,
			signalProcessGroupOrProcess: (pid, signal) => signals.push({ pid, signal }),
			waitForExit: async () => false,
		};
		recordRemoteQuestionnaireOrphan(path, 5, { ownerPid: 15, processOps: ops });
		await reapRemoteQuestionnaireOrphans(path, { processOps: ops, graceMs: 0 });
		expect(signals).toEqual([
			{ pid: 5, signal: "SIGTERM" },
			{ pid: 5, signal: "SIGKILL" },
		]);
		expect(signals.some(({ signal }) => signal === "SIGTSTP")).toBe(false);
	});

	it("serializes concurrent records from independent presenter owners", async () => {
		const path = makePath();
		const startIds: Record<number, string> = {};
		const alive = new Set<number>();
		for (let index = 0; index < 12; index++) {
			startIds[index + 100] = `child-${index}`;
			startIds[index + 200] = `owner-${index}`;
			alive.add(index + 100);
			alive.add(index + 200);
		}
		const { ops } = processOps(startIds, alive);
		await Promise.all(
			Array.from({ length: 12 }, (_, index) =>
				Promise.resolve(
					recordRemoteQuestionnaireOrphan(path, index + 100, { ownerPid: index + 200, processOps: ops }),
				),
			),
		);
		expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(12);
	});

	it("tolerates corrupt or partial lines and uses the env-selected agent directory", async () => {
		const path = makePath();
		const { ops } = processOps({ 2: "child", 12: "owner" }, new Set([2, 12]));
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, 'not-json\n{"version":2\n');
		recordRemoteQuestionnaireOrphan(path, 2, { ownerPid: 12, processOps: ops });
		await reapRemoteQuestionnaireOrphans(path, { processOps: ops });
		expect(readFileSync(path, "utf8")).toContain('"pid":2');

		const prior = process.env.PRIME_AGENT_CODING_AGENT_DIR;
		process.env.PRIME_AGENT_CODING_AGENT_DIR = "/tmp/remote-questionnaire-agent-dir";
		expect(getRemoteQuestionnaireOrphanJournalPath()).toBe(
			join("/tmp/remote-questionnaire-agent-dir", REMOTE_QUESTIONNAIRE_ORPHAN_JOURNAL_FILENAME),
		);
		if (prior === undefined) delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
		else process.env.PRIME_AGENT_CODING_AGENT_DIR = prior;
	});
});

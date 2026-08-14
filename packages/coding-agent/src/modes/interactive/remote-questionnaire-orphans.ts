import { join } from "node:path";
import { getAgentDir } from "../../config.js";
import {
	appendOrphanProcessJournalRecord,
	type RemoteOrphanProcessRecord,
	readOrphanProcessJournal,
	rewriteOrphanProcessJournal,
	withLockedOrphanProcessJournalAsync,
} from "../../core/orphan-process-journal.js";
import { getProcessStartId } from "../../core/session-lease.js";
import { signalProcessGroupOrProcess } from "../../utils/child-process.js";

export const REMOTE_QUESTIONNAIRE_ORPHAN_JOURNAL_FILENAME = "remote-questionnaire-orphans.jsonl";
const DEFAULT_GRACE_MS = 1000;

export interface RemoteQuestionnaireOrphanProcessOps {
	getProcessStartId(pid: number): string | undefined;
	isProcessAlive(pid: number): boolean;
	signalProcessGroupOrProcess(pid: number, signal: NodeJS.Signals): void;
	waitForExit(pid: number, timeoutMs: number): Promise<boolean>;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (isProcessAlive(pid) && Date.now() < deadline) {
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
	}
	return !isProcessAlive(pid);
}

const defaultProcessOps: RemoteQuestionnaireOrphanProcessOps = {
	getProcessStartId,
	isProcessAlive,
	signalProcessGroupOrProcess,
	waitForExit,
};

export function getRemoteQuestionnaireOrphanJournalPath(): string {
	return join(getAgentDir(), REMOTE_QUESTIONNAIRE_ORPHAN_JOURNAL_FILENAME);
}

function requireProcessIdentity(pid: number, processOps: RemoteQuestionnaireOrphanProcessOps): string {
	if (!Number.isInteger(pid) || pid <= 0)
		throw new Error("Remote questionnaire process identity requires a positive PID");
	const startId = processOps.getProcessStartId(pid);
	if (!startId) throw new Error("Remote questionnaire process identity could not be recorded");
	return startId;
}

export function recordRemoteQuestionnaireOrphan(
	path: string,
	pid: number,
	options: { ownerPid?: number; processOps?: RemoteQuestionnaireOrphanProcessOps } = {},
): RemoteOrphanProcessRecord {
	const processOps = options.processOps ?? defaultProcessOps;
	const ownerPid = options.ownerPid ?? process.pid;
	const record: RemoteOrphanProcessRecord = {
		version: 2,
		pid,
		processStartId: requireProcessIdentity(pid, processOps),
		ownerPid,
		ownerProcessStartId: requireProcessIdentity(ownerPid, processOps),
		active: true,
	};
	appendOrphanProcessJournalRecord(path, record);
	return record;
}

export function settleRemoteQuestionnaireOrphan(
	path: string,
	pid: number,
	identity: Pick<RemoteOrphanProcessRecord, "processStartId" | "ownerPid" | "ownerProcessStartId">,
): void {
	appendOrphanProcessJournalRecord(path, {
		version: 2,
		pid,
		processStartId: identity.processStartId,
		ownerPid: identity.ownerPid,
		ownerProcessStartId: identity.ownerProcessStartId,
		active: false,
	});
}

function latestRemoteRecords(records: ReturnType<typeof readOrphanProcessJournal>): RemoteOrphanProcessRecord[] {
	const latest = new Map<string, RemoteOrphanProcessRecord>();
	for (const record of records) {
		if (record.version === 2) latest.set(`${record.ownerPid}:${record.pid}`, record);
	}
	return [...latest.values()];
}

function identityMatches(
	pid: number,
	expectedStartId: string,
	processOps: RemoteQuestionnaireOrphanProcessOps,
): boolean {
	return processOps.isProcessAlive(pid) && processOps.getProcessStartId(pid) === expectedStartId;
}

function ownerIsStillLive(record: RemoteOrphanProcessRecord, processOps: RemoteQuestionnaireOrphanProcessOps): boolean {
	if (!processOps.isProcessAlive(record.ownerPid)) return false;
	const currentStartId = processOps.getProcessStartId(record.ownerPid);
	return currentStartId === undefined || currentStartId === record.ownerProcessStartId;
}

/**
 * Reaps only a detached child whose recorded owner is gone or has a different
 * start identity. SIGTSTP is intentionally never handled or sent here: detached
 * tunnel cleanup is separate from terminal job-control suspension.
 */
export async function reapRemoteQuestionnaireOrphans(
	path: string = getRemoteQuestionnaireOrphanJournalPath(),
	options: { processOps?: RemoteQuestionnaireOrphanProcessOps; graceMs?: number } = {},
): Promise<void> {
	const processOps = options.processOps ?? defaultProcessOps;
	const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
	await withLockedOrphanProcessJournalAsync(path, async () => {
		const records = readOrphanProcessJournal(path);
		// This journal is shared with legacy v1 entries; remote reaping owns v2 only.
		const retained: ReturnType<typeof readOrphanProcessJournal> = records.filter((record) => record.version === 1);
		for (const record of latestRemoteRecords(records)) {
			if (!record.active) continue;
			if (ownerIsStillLive(record, processOps)) {
				retained.push(record);
				continue;
			}
			if (!identityMatches(record.pid, record.processStartId, processOps)) continue;
			processOps.signalProcessGroupOrProcess(record.pid, "SIGTERM");
			if (
				!(await processOps.waitForExit(record.pid, graceMs)) &&
				identityMatches(record.pid, record.processStartId, processOps)
			) {
				processOps.signalProcessGroupOrProcess(record.pid, "SIGKILL");
				await processOps.waitForExit(record.pid, graceMs);
			}
			if (identityMatches(record.pid, record.processStartId, processOps)) retained.push(record);
		}
		rewriteOrphanProcessJournal(path, retained);
	});
}

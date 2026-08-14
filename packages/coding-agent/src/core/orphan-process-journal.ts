import {
	chmodSync,
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { getProcessStartId } from "./session-lease.js";

export const ORPHAN_PROCESS_JOURNAL_ENV = "PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL";

interface OrphanProcessRecord {
	version: 1;
	pid: number;
	ownerPid: number;
	processStartId?: string;
	active: boolean;
	recordedAt: string;
}

export interface RemoteOrphanProcessRecord {
	version: 2;
	pid: number;
	processStartId: string;
	ownerPid: number;
	ownerProcessStartId: string;
	active: boolean;
}

export interface ActiveOrphanProcess {
	pid: number;
	processStartId: string;
}

function ensurePrivateJournal(path: string): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const descriptor = openSync(path, "a", 0o600);
	try {
		chmodSync(path, 0o600);
	} finally {
		closeSync(descriptor);
	}
}

function acquireLockWithRetry(path: string): () => void {
	let lastError: unknown;
	for (let attempt = 0; attempt < 10; attempt++) {
		try {
			return lockfile.lockSync(path, { realpath: false, stale: 30000 });
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ELOCKED" || attempt === 9) throw error;
			lastError = error;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
		}
	}
	throw (lastError as Error) ?? new Error(`Could not lock orphan process journal: ${path}`);
}

/**
 * Coordinates an explicit journal path. Unlike the legacy environment-selected
 * helpers, errors are deliberately exposed to the caller.
 */
export function withLockedOrphanProcessJournal<T>(path: string, action: () => T): T {
	ensurePrivateJournal(path);
	const release = acquireLockWithRetry(path);
	try {
		return action();
	} finally {
		release();
	}
}

export async function withLockedOrphanProcessJournalAsync<T>(path: string, action: () => Promise<T>): Promise<T> {
	ensurePrivateJournal(path);
	const release = acquireLockWithRetry(path);
	try {
		return await action();
	} finally {
		release();
	}
}

export function readOrphanProcessJournal(path: string): Array<OrphanProcessRecord | RemoteOrphanProcessRecord> {
	let contents: string;
	try {
		contents = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const records: Array<OrphanProcessRecord | RemoteOrphanProcessRecord> = [];
	for (const line of contents.split("\n")) {
		if (!line) continue;
		try {
			const record = JSON.parse(line) as Record<string, unknown>;
			const pid = record.pid;
			const ownerPid = record.ownerPid;
			if (
				record.version === 1 &&
				typeof pid === "number" &&
				Number.isInteger(pid) &&
				pid > 0 &&
				typeof ownerPid === "number" &&
				Number.isInteger(ownerPid) &&
				ownerPid > 0 &&
				typeof record.active === "boolean" &&
				typeof record.recordedAt === "string"
			) {
				records.push(record as unknown as OrphanProcessRecord);
			} else if (
				record.version === 2 &&
				typeof pid === "number" &&
				Number.isInteger(pid) &&
				pid > 0 &&
				typeof record.processStartId === "string" &&
				typeof ownerPid === "number" &&
				Number.isInteger(ownerPid) &&
				ownerPid > 0 &&
				typeof record.ownerProcessStartId === "string" &&
				typeof record.active === "boolean"
			) {
				records.push(record as unknown as RemoteOrphanProcessRecord);
			}
		} catch {
			// A crash can leave a final partial line. Invalid records are never actionable.
		}
	}
	return records;
}

/** Replaces an explicit journal privately and atomically while its caller holds the journal lock. */
export function rewriteOrphanProcessJournal(
	path: string,
	records: readonly (OrphanProcessRecord | RemoteOrphanProcessRecord)[],
): void {
	ensurePrivateJournal(path);
	const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(
			temporaryPath,
			records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""),
			{
				mode: 0o600,
			},
		);
		chmodSync(temporaryPath, 0o600);
		renameSync(temporaryPath, path);
		chmodSync(path, 0o600);
	} finally {
		rmSync(temporaryPath, { force: true });
	}
}

/** Appends an explicit record with a lock and private atomic rewrite. */
export function appendOrphanProcessJournalRecord(path: string, record: RemoteOrphanProcessRecord): void {
	withLockedOrphanProcessJournal(path, () => {
		const records = readOrphanProcessJournal(path);
		rewriteOrphanProcessJournal(path, [...records, record]);
	});
}

export function recordOrphanProcessState(pid: number, active: boolean): void {
	const path = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
	if (!path || !Number.isInteger(pid) || pid <= 0) return;
	const processStartId = active ? getProcessStartId(pid) : undefined;
	const record: OrphanProcessRecord = {
		version: 1,
		pid,
		ownerPid: process.pid,
		...(processStartId ? { processStartId } : {}),
		active,
		recordedAt: new Date().toISOString(),
	};
	try {
		const descriptor = openSync(path, "a", 0o600);
		try {
			writeSync(descriptor, `${JSON.stringify(record)}\n`);
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
	} catch {
		// Process tracking must not make a successfully spawned command fail.
	}
}

export function readActiveOrphanProcesses(path: string, ownerPid: number): ActiveOrphanProcess[] {
	const latest = new Map<number, OrphanProcessRecord>();
	for (const record of readOrphanProcessJournal(path)) {
		if (record.version === 1 && record.ownerPid === ownerPid) latest.set(record.pid, record);
	}
	return [...latest.values()]
		.filter(
			(record): record is OrphanProcessRecord & { processStartId: string } =>
				record.active && typeof record.processStartId === "string",
		)
		.map((record) => ({ pid: record.pid, processStartId: record.processStartId }));
}

export function isOrphanProcessIdentityCurrent(orphan: ActiveOrphanProcess): boolean {
	return getProcessStartId(orphan.pid) === orphan.processStartId;
}

export function clearOrphanProcessJournal(path: string): void {
	rmSync(path, { force: true });
}

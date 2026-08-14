import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import {
	DEFAULT_REMOTE_QUESTIONNAIRE_DELAY_MINUTES,
	type RemoteQuestionnaireSettings,
} from "../../core/settings-manager.js";
import {
	getRemoteQuestionnaireOrphanJournalPath,
	type RemoteQuestionnaireOrphanProcessOps,
	recordRemoteQuestionnaireOrphan,
	settleRemoteQuestionnaireOrphan,
} from "./remote-questionnaire-orphans.js";
import { RemoteQuestionnaireServer } from "./remote-questionnaire-server.js";

export const HID_IDLE_REQUIRED_NS = 300_000_000_000n;
export const REMOTE_QUESTIONNAIRE_PRESENTATION_DELAY_MS = DEFAULT_REMOTE_QUESTIONNAIRE_DELAY_MINUTES * 60_000;
export const QUICK_TUNNEL_MAX_OUTPUT_BYTES = 64 * 1024;
export const APPLESCRIPT_TIMEOUT_MS = 10_000;
const MAX_RESTARTS = 2;
const RESTART_DELAY_MS = 1_000;
const IOSCRIPT =
	'on run argv\nset recipientAddress to item 1 of argv\nset messageBody to item 2 of argv\ntell application "Messages"\nset targetService to first service whose service type = iMessage\nsend messageBody to buddy recipientAddress of targetService\nend tell\nend run';
const TUNNEL_URL = /https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com)(?=[/\s]|$)/giu;

export interface RemoteQuestionnaireClock {
	now(): number;
	monotonicNow(): number;
}
export interface RemoteQuestionnaireTimer {
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(timer: unknown): void;
}
export interface RemoteQuestionnaireMessage {
	send(recipient: string, body: string): Promise<void>;
}
export interface RemoteQuestionnaireServerHandle {
	readonly url: string;
	readonly routeId: string;
	readonly fragmentSecret: string;
	setPublicHostname(hostname: string): void;
	revoke(message?: string): Promise<void>;
	close(): Promise<void>;
}
export interface RemoteQuestionnaireChild extends Pick<ChildProcess, "pid" | "stdout" | "stderr"> {
	on(event: "error", listener: (error: Error) => void): this;
	on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}
export interface RemoteQuestionnaireManagerDependencies {
	platform: NodeJS.Platform;
	supportsRichQuestionnaire: boolean;
	clock: RemoteQuestionnaireClock;
	timers: RemoteQuestionnaireTimer;
	readHidIdleNanoseconds(): Promise<bigint>;
	spawn(command: string, args: readonly string[], options: SpawnOptions): RemoteQuestionnaireChild;
	message: RemoteQuestionnaireMessage;
	createServer(expiresAt: number): Promise<RemoteQuestionnaireServerHandle>;
	journalPath(): string;
	recordOrphan(path: string, pid: number): { processStartId: string; ownerPid: number; ownerProcessStartId: string };
	settleOrphan(
		path: string,
		pid: number,
		identity: { processStartId: string; ownerPid: number; ownerProcessStartId: string },
	): void;
	processOps: Pick<RemoteQuestionnaireOrphanProcessOps, "signalProcessGroupOrProcess" | "waitForExit">;
}
export interface RemoteQuestionnairePresentation {
	logicalRequestId: string;
	title?: string;
	projectLabel?: string;
	sessionLabel?: string;
	questionCount: number;
	firstPrompt?: string;
	presentedAtMonotonic: number;
}
interface MessageCap {
	original: boolean;
	replacement: boolean;
	originalSucceeded: boolean;
	hostname?: string;
}

const defaultDependencies: RemoteQuestionnaireManagerDependencies = {
	platform: process.platform,
	supportsRichQuestionnaire: true,
	clock: { now: () => Date.now(), monotonicNow: () => performance.now() },
	timers: { setTimeout, clearTimeout },
	readHidIdleNanoseconds,
	spawn: (command, args, options) => nodeSpawn(command, args, options),
	message: { send: sendIMessage },
	createServer: async (expiresAt) => RemoteQuestionnaireServer.create({ expiresAt }),
	journalPath: getRemoteQuestionnaireOrphanJournalPath,
	recordOrphan: (path, pid) => recordRemoteQuestionnaireOrphan(path, pid),
	settleOrphan: settleRemoteQuestionnaireOrphan,
	processOps: {
		signalProcessGroupOrProcess: (pid, signal) => {
			try {
				process.kill(-pid, signal);
			} catch {
				try {
					process.kill(pid, signal);
				} catch {}
			}
		},
		waitForExit: async (pid, timeoutMs) => {
			const until = Date.now() + timeoutMs;
			while (Date.now() < until) {
				try {
					process.kill(pid, 0);
				} catch {
					return true;
				}
				await new Promise<void>((r) => setTimeout(r, 20));
			}
			try {
				process.kill(pid, 0);
				return false;
			} catch {
				return true;
			}
		},
	},
};

/** Strict parser for the fixed, read-only IOHIDSystem command output. */
export function parseHidIdleNanoseconds(output: string): bigint {
	const matches = [...output.matchAll(/^\s*(?:\|\s*)?"HIDIdleTime"\s*=\s*(\S+)\s*$/gmu)];
	if (matches.length === 0) throw new Error("IOHIDSystem output is missing HIDIdleTime");
	if (matches.length !== 1) throw new Error("IOHIDSystem output must contain HIDIdleTime exactly once");
	const value = matches[0]?.[1];
	if (!value || !/^\d+$/u.test(value)) throw new Error("HIDIdleTime must be a non-negative integer");
	try {
		return BigInt(value);
	} catch {
		throw new Error("HIDIdleTime is not representable");
	}
}

/** Bounded, chunk-safe parser for cloudflared's default announcement on either stream. */
export class QuickTunnelUrlParser {
	private remainder = "";
	private bytes = 0;
	private found: string | undefined;
	push(chunk: string | Buffer): string | undefined {
		const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
		this.bytes += Buffer.byteLength(text);
		if (this.bytes > QUICK_TUNNEL_MAX_OUTPUT_BYTES) throw new Error("cloudflared output exceeded discovery limit");
		const prefixLength = this.remainder.length;
		const combined = this.remainder + text;
		for (const match of combined.matchAll(TUNNEL_URL)) {
			const hostname = match[1]?.toLowerCase();
			const end = (match.index ?? 0) + match[0].length;
			if (!hostname || end <= prefixLength) continue;
			if (this.found && this.found !== hostname) throw new Error("cloudflared announced multiple tunnel hostnames");
			this.found = hostname;
		}
		this.remainder = combined.slice(-2048);
		return this.found;
	}
}

export function buildRemoteQuestionnaireMessage(
	presentation: Omit<RemoteQuestionnairePresentation, "presentedAtMonotonic">,
	url: string,
): string {
	const firstPrompt = truncateSafeText(presentation.firstPrompt ?? "", 280);
	const labels = [presentation.projectLabel, presentation.sessionLabel, presentation.title]
		.filter(Boolean)
		.map((x) => truncateSafeText(x!, 120));
	return [
		"Remote questionnaire available.",
		labels.join(" · "),
		`${presentation.questionCount} question${presentation.questionCount === 1 ? "" : "s"}.`,
		firstPrompt,
		url,
	]
		.filter(Boolean)
		.join("\n");
}

export class RemoteQuestionnaireManager {
	private readonly dependencies: RemoteQuestionnaireManagerDependencies;
	private readonly caps = new Map<string, MessageCap>();
	private presentation: RemoteQuestionnairePresentation | undefined;
	private server: RemoteQuestionnaireServerHandle | undefined;
	private child: RemoteQuestionnaireChild | undefined;
	private childIdentity: { processStartId: string; ownerPid: number; ownerProcessStartId: string } | undefined;
	private childGeneration = 0;
	private startFlight: Promise<void> | undefined;
	private restartTimer: unknown;
	private eligibilityTimer: unknown;
	private expiryTimer: unknown;
	private expiresAt: number | undefined;
	private restarts = 0;
	private disposed = false;

	constructor(
		private readonly settings: Required<Omit<RemoteQuestionnaireSettings, "cloudflaredPath">> &
			Pick<RemoteQuestionnaireSettings, "cloudflaredPath">,
		dependencies: Partial<RemoteQuestionnaireManagerDependencies> = {},
	) {
		this.dependencies = {
			...defaultDependencies,
			...dependencies,
			clock: dependencies.clock ?? defaultDependencies.clock,
			timers: dependencies.timers ?? defaultDependencies.timers,
			message: dependencies.message ?? defaultDependencies.message,
			processOps: dependencies.processOps ?? defaultDependencies.processOps,
		};
	}

	get active(): boolean {
		return this.server !== undefined;
	}
	get messageCaps(): ReadonlyMap<string, Readonly<MessageCap>> {
		return this.caps;
	}

	async offer(presentation: RemoteQuestionnairePresentation): Promise<void> {
		if (!this.canActivate() || this.disposed) return;
		if (this.presentation && this.presentation.logicalRequestId !== presentation.logicalRequestId)
			await this.revoke();
		this.presentation = presentation;
		this.restarts = 0;
		this.expiresAt = this.dependencies.clock.now() + this.settings.linkLifetimeHours * 3_600_000;
		this.scheduleExpiry();
		await this.consider();
	}
	async consider(): Promise<void> {
		if (!this.presentation || this.disposed) return;
		if (this.expiresAt !== undefined && this.dependencies.clock.now() >= this.expiresAt) {
			await this.revoke();
			return;
		}
		if (!this.canActivate() || this.server) return;
		const remainingAge =
			this.settings.delayMinutes * 60_000 -
			(this.dependencies.clock.monotonicNow() - this.presentation.presentedAtMonotonic);
		if (remainingAge > 0) {
			this.scheduleEligibility(remainingAge);
			return;
		}
		let idle: bigint;
		try {
			idle = await this.dependencies.readHidIdleNanoseconds();
		} catch {
			this.scheduleEligibility(30_000);
			return;
		}
		if (idle < HID_IDLE_REQUIRED_NS) {
			this.scheduleEligibility(30_000);
			return;
		}
		await this.start();
	}
	async revoke(): Promise<void> {
		await this.cleanup(true);
		this.presentation = undefined;
		this.expiresAt = undefined;
	}
	async dispose(): Promise<void> {
		this.disposed = true;
		await this.cleanup(true);
		this.presentation = undefined;
		this.expiresAt = undefined;
	}

	private scheduleEligibility(delayMs: number): void {
		if (this.eligibilityTimer !== undefined) this.dependencies.timers.clearTimeout(this.eligibilityTimer);
		this.eligibilityTimer = this.dependencies.timers.setTimeout(
			() => {
				this.eligibilityTimer = undefined;
				void this.consider();
			},
			Math.max(0, delayMs),
		);
	}
	private scheduleExpiry(): void {
		if (this.expiryTimer !== undefined) this.dependencies.timers.clearTimeout(this.expiryTimer);
		if (this.expiresAt === undefined) return;
		const remaining = this.expiresAt - this.dependencies.clock.now();
		this.expiryTimer = this.dependencies.timers.setTimeout(
			() => {
				this.expiryTimer = undefined;
				if (this.expiresAt !== undefined && this.dependencies.clock.now() >= this.expiresAt) void this.revoke();
				else this.scheduleExpiry();
			},
			Math.max(0, remaining),
		);
	}

	private canActivate(): boolean {
		return (
			this.dependencies.platform === "darwin" &&
			this.dependencies.supportsRichQuestionnaire &&
			this.settings.enabled === true &&
			isRecipient(this.settings.recipient) &&
			this.settings.delayMinutes > 0 &&
			this.settings.linkLifetimeHours > 0
		);
	}

	private async start(): Promise<void> {
		if (this.startFlight) return this.startFlight;
		this.startFlight = this.startInternal().finally(() => {
			this.startFlight = undefined;
		});
		return this.startFlight;
	}
	private async startInternal(): Promise<void> {
		const presentation = this.presentation;
		if (!presentation || this.disposed) return;
		const server =
			this.server ?? (await this.dependencies.createServer(this.expiresAt ?? this.dependencies.clock.now()));
		if (this.disposed || presentation !== this.presentation) {
			if (server !== this.server) await server.close();
			return;
		}
		this.server = server;
		const generation = ++this.childGeneration;
		let child: RemoteQuestionnaireChild;
		try {
			child = this.dependencies.spawn(
				this.settings.cloudflaredPath ?? "cloudflared",
				["tunnel", "--no-autoupdate", "--metrics", "127.0.0.1:0", "--url", server.url],
				{ detached: true, shell: false, stdio: ["ignore", "pipe", "pipe"] },
			);
			if (!child.pid) throw new Error("cloudflared did not supply a PID");
			this.child = child;
			this.childIdentity = this.dependencies.recordOrphan(this.dependencies.journalPath(), child.pid);
		} catch {
			await this.cleanup(true);
			return;
		}
		const parser = new QuickTunnelUrlParser();
		const ready = (chunk: string | Buffer) => {
			if (generation !== this.childGeneration || !this.server) return;
			try {
				const hostname = parser.push(chunk);
				if (hostname) void this.onReady(hostname, generation);
			} catch {
				void this.restart(generation);
			}
		};
		child.stdout?.on("data", ready);
		child.stderr?.on("data", ready);
		child.on("error", () => void this.restart(generation));
		child.on("exit", () => void this.restart(generation));
	}
	private async onReady(hostname: string, generation: number): Promise<void> {
		if (generation !== this.childGeneration || !this.server || !this.presentation) return;
		if (this.expiresAt !== undefined && this.dependencies.clock.now() >= this.expiresAt) {
			await this.revoke();
			return;
		}
		this.server.setPublicHostname(hostname);
		this.restarts = 0;
		const cap = this.caps.get(this.presentation.logicalRequestId) ?? {
			original: false,
			replacement: false,
			originalSucceeded: false,
		};
		const replacement = cap.original && cap.originalSucceeded && !cap.replacement && cap.hostname !== hostname;
		if (cap.original && !replacement) return;
		const url = `https://${hostname}/r/${this.server.routeId}#${this.server.fragmentSecret}`;
		try {
			await this.dependencies.message.send(
				this.settings.recipient,
				buildRemoteQuestionnaireMessage(this.presentation, url),
			);
			if (generation !== this.childGeneration) return;
			if (replacement) cap.replacement = true;
			else {
				cap.original = true;
				cap.originalSucceeded = true;
			}
			cap.hostname = hostname;
			this.caps.set(this.presentation.logicalRequestId, cap);
		} catch {
			await this.cleanup(true);
		}
	}
	private async restart(generation: number): Promise<void> {
		if (generation !== this.childGeneration || this.disposed || !this.presentation) return;
		await this.cleanup(false);
		if (this.restarts++ >= MAX_RESTARTS) return;
		this.restartTimer = this.dependencies.timers.setTimeout(() => {
			this.restartTimer = undefined;
			void this.start();
		}, RESTART_DELAY_MS * this.restarts);
	}
	private async cleanup(closeServer: boolean): Promise<void> {
		if (this.restartTimer !== undefined) {
			this.dependencies.timers.clearTimeout(this.restartTimer);
			this.restartTimer = undefined;
		}
		if (closeServer && this.eligibilityTimer !== undefined) {
			this.dependencies.timers.clearTimeout(this.eligibilityTimer);
			this.eligibilityTimer = undefined;
		}
		if (closeServer && this.expiryTimer !== undefined) {
			this.dependencies.timers.clearTimeout(this.expiryTimer);
			this.expiryTimer = undefined;
		}
		const child = this.child;
		const identity = this.childIdentity;
		this.child = undefined;
		this.childIdentity = undefined;
		++this.childGeneration;
		if (child?.pid) {
			this.dependencies.processOps.signalProcessGroupOrProcess(child.pid, "SIGTERM");
			if (!(await this.dependencies.processOps.waitForExit(child.pid, 1000))) {
				this.dependencies.processOps.signalProcessGroupOrProcess(child.pid, "SIGKILL");
				await this.dependencies.processOps.waitForExit(child.pid, 1000);
			}
			if (identity) this.dependencies.settleOrphan(this.dependencies.journalPath(), child.pid, identity);
		}
		if (this.server && closeServer) {
			const server = this.server;
			this.server = undefined;
			await server.revoke();
		} else if (!child && closeServer) this.server = undefined;
	}
}

export interface RemoteQuestionnaireIoregDependencies {
	spawn(
		command: string,
		args: readonly string[],
		options: SpawnOptions,
	): Pick<ChildProcess, "stdout" | "stderr" | "kill"> & {
		once(event: "error" | "exit", listener: (...args: never[]) => void): unknown;
	};
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(timer: unknown): void;
}
export async function readHidIdleNanoseconds(
	dependencies: Partial<RemoteQuestionnaireIoregDependencies> = {},
): Promise<bigint> {
	const spawn = dependencies.spawn ?? ((command, args, options) => nodeSpawn(command, args, options));
	const setTimer = dependencies.setTimeout ?? setTimeout;
	const clearTimer = dependencies.clearTimeout ?? clearTimeout;
	return new Promise((resolve, reject) => {
		const child = spawn("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-d", "4", "-r"], {
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		let timedOut = false;
		const timer = setTimer(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, 5_000);
		child.stdout?.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
		});
		child.once("error", (error: Error) => {
			clearTimer(timer);
			reject(error);
		});
		child.once("exit", (code: number | null) => {
			clearTimer(timer);
			if (timedOut) return reject(new Error("ioreg timed out"));
			if (code !== 0) return reject(new Error("ioreg exited nonzero"));
			try {
				resolve(parseHidIdleNanoseconds(output));
			} catch (error) {
				reject(error);
			}
		});
	});
}
export interface RemoteQuestionnaireMessageDependencies {
	spawn(
		command: string,
		args: readonly string[],
		options: SpawnOptions,
	): Pick<ChildProcess, "kill"> & { once(event: "error" | "exit", listener: (...args: never[]) => void): unknown };
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(timer: unknown): void;
}
export async function sendIMessage(
	recipient: string,
	body: string,
	dependencies: Partial<RemoteQuestionnaireMessageDependencies> = {},
): Promise<void> {
	if (!isRecipient(recipient)) throw new TypeError("Invalid Messages recipient");
	const spawn = dependencies.spawn ?? ((command, args, options) => nodeSpawn(command, args, options));
	const setTimer = dependencies.setTimeout ?? setTimeout;
	const clearTimer = dependencies.clearTimeout ?? clearTimeout;
	const child = spawn("/usr/bin/osascript", ["-e", IOSCRIPT, recipient, truncateSafeText(body, 1500)], {
		shell: false,
		stdio: "ignore",
	});
	await new Promise<void>((resolve, reject) => {
		const timer = setTimer(() => {
			child.kill("SIGKILL");
			reject(new Error("osascript timed out"));
		}, APPLESCRIPT_TIMEOUT_MS);
		child.once("error", (error: Error) => {
			clearTimer(timer);
			reject(error);
		});
		child.once("exit", (code: number | null) => {
			clearTimer(timer);
			code === 0 ? resolve() : reject(new Error("osascript failed"));
		});
	});
}
function isRecipient(value: string): boolean {
	return value.trim().length > 0 && value.trim().length <= 256 && !/[\p{Cc}]/u.test(value);
}
function truncateSafeText(value: string, limit: number): string {
	return Array.from(value.replace(/[\p{Cc}]/gu, " ").trim())
		.slice(0, limit)
		.join("");
}

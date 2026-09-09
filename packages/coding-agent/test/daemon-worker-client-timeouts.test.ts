import { spawn } from "node:child_process";
import { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonWorkerClient } from "../src/modes/daemon/daemon-worker-client.js";
import type { DaemonWorkerFrameHeader } from "../src/modes/daemon/daemon-worker-protocol.js";
import type { PrivateFrame } from "../src/modes/session-worker/private-framing.js";

interface ClientInternals {
	pending: Map<string, unknown>;
	handleFrame(frame: PrivateFrame<DaemonWorkerFrameHeader>): void;
	notifyClosed(socket: Socket, error: Error): void;
}

function accessInternals(client: DaemonWorkerClient): ClientInternals {
	return client as unknown as ClientInternals;
}

function installTransport(client: DaemonWorkerClient, send: () => Promise<void>): Socket {
	const socket = new Socket();
	Object.assign(client, {
		socket,
		channel: {
			send,
			close: () => undefined,
		},
	});
	return socket;
}

function request(client: DaemonWorkerClient, timeoutMs: number) {
	return client.requestWorker({ type: "worker_sync_agent_peers", peers: [] }, timeoutMs);
}

async function runReproduction(script: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
	const environment = { ...process.env };
	delete environment.FORCE_COLOR;
	delete environment.NO_COLOR;
	return await new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			["--unhandled-rejections=strict", "--import", "tsx", "--input-type=module", "--eval", script],
			{ cwd: process.cwd(), env: environment, stdio: ["ignore", "pipe", "pipe"] },
		);
		let stdout = "";
		let stderr = "";
		const timeout = setTimeout(() => {
			child.kill();
			reject(new Error("worker request reproduction did not exit"));
		}, 2000);
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timeout);
			resolve({ code, stdout, stderr });
		});
	});
}

function requestFailureReproduction(transport: string, command: string): string {
	return `
import { DaemonWorkerClient } from "./src/modes/daemon/daemon-worker-client.ts";
const client = new DaemonWorkerClient("unused-no-socket");
Object.assign(client, {
  socket: { destroyed: false },
  channel: { send: ${transport} },
});
let request;
try {
  request = client.requestWorker(${command}, 10);
} catch (error) {
  console.error("SYNC_THROW", error.message);
  process.exit(2);
}
request.catch((error) => {
  console.log("ASYNC_CAUGHT", error.message);
  console.log("PENDING", client.pending.size);
});
setTimeout(() => console.log("SURVIVED"), 50);
`;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("DaemonWorkerClient request timeouts", () => {
	it("rejects a blocked send and observes its late failure without an unhandled rejection", async () => {
		const result = await runReproduction(
			requestFailureReproduction(
				`() => new Promise((_, reject) => setTimeout(() => reject(new Error("late write failure")), 30))`,
				`{ type: "worker_sync_agent_peers", peers: [] }`,
			),
		);

		expect(result.code).toBe(0);
		expect(result.stdout).toBe(
			"ASYNC_CAUGHT Timed out waiting for daemon worker response to worker_sync_agent_peers\nPENDING 0\nSURVIVED\n",
		);
		expect(result.stderr).not.toContain("late write failure");
	});

	it("returns a rejected promise when command serialization throws synchronously", async () => {
		const result = await runReproduction(
			requestFailureReproduction(
				`() => Promise.resolve()`,
				`(() => {
  const circular = { type: "worker_sync_agent_peers", peers: [] };
  circular.self = circular;
  return circular;
})()`,
			),
		);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("ASYNC_CAUGHT");
		expect(result.stdout).toContain("PENDING 0\nSURVIVED\n");
		expect(result.stderr).not.toContain("SYNC_THROW");
	});

	it("returns a rejected promise when send throws synchronously", async () => {
		const result = await runReproduction(
			requestFailureReproduction(
				`() => { throw new Error("synchronous write failure"); }`,
				`{ type: "worker_sync_agent_peers", peers: [] }`,
			),
		);

		expect(result).toMatchObject({ code: 0, stderr: expect.not.stringContaining("SYNC_THROW") });
		expect(result.stdout).toBe("ASYNC_CAUGHT synchronous write failure\nPENDING 0\nSURVIVED\n");
	});

	it("rejects send failures and removes the pending request", async () => {
		const client = new DaemonWorkerClient("unused-no-socket");
		installTransport(client, () => Promise.reject(new Error("write failed")));

		await expect(request(client, 1000)).rejects.toThrow("write failed");
		expect(accessInternals(client).pending.size).toBe(0);
	});

	it("times out an ordinary sent request and ignores its late response", async () => {
		vi.useFakeTimers();
		const client = new DaemonWorkerClient("unused-no-socket");
		installTransport(client, () => Promise.resolve());
		const lateFrames: PrivateFrame<DaemonWorkerFrameHeader>[] = [];
		client.onFrame((frame) => lateFrames.push(frame));
		const pending = request(client, 25);
		const rejection = expect(pending).rejects.toThrow(
			"Timed out waiting for daemon worker response to worker_sync_agent_peers",
		);

		await vi.advanceTimersByTimeAsync(25);
		await rejection;
		expect(accessInternals(client).pending.size).toBe(0);

		const lateFrame: PrivateFrame<DaemonWorkerFrameHeader> = {
			header: { kind: "outbound", outboundType: "response", requestId: "worker_1" },
			payload: Buffer.from('{"type":"response","command":"worker_sync_agent_peers","success":true}'),
		};
		accessInternals(client).handleFrame(lateFrame);
		expect(lateFrames).toEqual([lateFrame]);
		expect(accessInternals(client).pending.size).toBe(0);
	});

	it("rejects and removes pending requests when explicitly closed", async () => {
		const client = new DaemonWorkerClient("unused-no-socket");
		installTransport(client, () => new Promise<void>(() => undefined));
		const pending = request(client, 1000);

		client.close();

		await expect(pending).rejects.toThrow("Daemon worker client closed");
		expect(accessInternals(client).pending.size).toBe(0);
	});

	it("rejects and removes pending requests when the socket disconnects", async () => {
		const client = new DaemonWorkerClient("unused-no-socket");
		const socket = installTransport(client, () => new Promise<void>(() => undefined));
		const closed = vi.fn();
		client.onClose(closed);
		const pending = request(client, 1000);
		const disconnect = new Error("worker disconnected");

		accessInternals(client).notifyClosed(socket, disconnect);

		await expect(pending).rejects.toBe(disconnect);
		expect(accessInternals(client).pending.size).toBe(0);
		expect(closed).toHaveBeenCalledWith(disconnect);
	});
});

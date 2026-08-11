import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonWorkerClient } from "../src/modes/daemon/daemon-worker-client.js";
import type { DaemonWorkerFrameHeader } from "../src/modes/daemon/daemon-worker-protocol.js";
import { encodePrivateFrame, type PrivateFrame } from "../src/modes/session-worker/private-framing.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

describe("DaemonWorkerClient questionnaire frames", () => {
	it("delivers decoded worker questionnaire frames to supervisor listeners", async () => {
		const directory = await mkdtemp(join(tmpdir(), "daemon-worker-questionnaire-"));
		cleanup.push(() => rm(directory, { recursive: true, force: true }));
		const socketPath = join(directory, "worker.sock");
		const encoded = encodePrivateFrame(
			{ kind: "questionnaire_broker", messageType: "presenter_needed" } satisfies DaemonWorkerFrameHeader,
			Buffer.from('{"type":"presenter_needed"}'),
		);
		const server = createServer((socket) => {
			// Split the frame so this exercises the real channel decoder, not direct dispatch.
			socket.write(encoded.subarray(0, 7));
			socket.write(encoded.subarray(7));
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, resolve);
		});
		cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

		const client = new DaemonWorkerClient(socketPath);
		cleanup.push(() => client.close());
		client.onFrame(() => {
			throw new Error("supervisor listener failed");
		});
		const received = new Promise<PrivateFrame<DaemonWorkerFrameHeader>>((resolve) => client.onFrame(resolve));
		await client.connect();

		await expect(received).resolves.toMatchObject({
			header: { kind: "questionnaire_broker", messageType: "presenter_needed" },
		});
	});
});

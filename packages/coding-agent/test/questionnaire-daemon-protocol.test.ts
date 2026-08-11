import { describe, expect, it } from "vitest";
import {
	DAEMON_COMMAND_COMPATIBILITY,
	DAEMON_DEFAULT_SERVER_CAPABILITIES,
	DAEMON_OUTBOUND_COMPATIBILITY,
	DAEMON_SCHEMA_REVISION,
	type DaemonCommand,
	type DaemonOutbound,
	getDaemonCommandCompatibilities,
	getDaemonOutboundCompatibilities,
	normalizeDaemonClientCapabilities,
} from "../src/modes/daemon/daemon-protocol.js";

describe("questionnaire daemon wire gates", () => {
	it("advertises questionnaire_v1 while keeping broker commands and targeted events capability-gated", () => {
		expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).toContain("questionnaire_v1");
		expect(DAEMON_COMMAND_COMPATIBILITY.questionnaire_presentability.capability).toBe("questionnaire_v1");
		expect(DAEMON_COMMAND_COMPATIBILITY.questionnaire_offer_response.capability).toBe("questionnaire_v1");
		expect(DAEMON_COMMAND_COMPATIBILITY.questionnaire_withdraw_ack.capability).toBe("questionnaire_v1");
		expect(DAEMON_COMMAND_COMPATIBILITY.questionnaire_checkpoint.capability).toBe("questionnaire_v1");
		expect(DAEMON_COMMAND_COMPATIBILITY.questionnaire_submit.capability).toBe("questionnaire_v1");
		expect(DAEMON_COMMAND_COMPATIBILITY.questionnaire_dismiss.capability).toBe("questionnaire_v1");
		expect(DAEMON_COMMAND_COMPATIBILITY.questionnaire_presentation_error.capability).toBe("questionnaire_v1");
		expect(DAEMON_OUTBOUND_COMPATIBILITY.questionnaire_offer.capability).toBe("questionnaire_v1");
		expect(DAEMON_OUTBOUND_COMPATIBILITY.questionnaire_withdraw.capability).toBe("questionnaire_v1");
		expect(DAEMON_OUTBOUND_COMPATIBILITY.questionnaire_presentation_snapshot.capability).toBe("questionnaire_v1");
	});

	it("requires schema 18 and questionnaire_v2 for v2 CAS while retaining the v1 gate", () => {
		expect(DAEMON_SCHEMA_REVISION).toBe(18);
		expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).toEqual(
			expect.arrayContaining(["extension_ui", "questionnaire_v1", "questionnaire_v2"]),
		);
		const command: DaemonCommand = {
			type: "questionnaire_checkpoint",
			activeSessionId: "session-a",
			lease: {
				supervisorGeneration: "generation-a",
				logicalRequestId: "request-a",
				offerId: "offer-a",
				leaseEpoch: 1,
				logicalClientId: "logical-a",
				connectionId: "connection-a",
				mode: "rich",
				questionnaireVersion: 2,
			},
			baseRevision: 0,
			clientMutationId: "mutation-v2",
			completeDraft: {
				version: 2,
				currentStep: { kind: "review" },
				states: [{ questionId: "q", kind: "short-text", value: "answer", note: "private note" }],
			},
		};
		expect(getDaemonCommandCompatibilities(command)).toContainEqual({
			minProtocol: 7,
			minSchemaRevision: 18,
			capability: "questionnaire_v2",
		});
		expect(
			getDaemonOutboundCompatibilities({
				type: "questionnaire_offer",
				activeSessionId: "session-a",
				lease: command.lease,
			}),
		).toContainEqual({ minProtocol: 7, minSchemaRevision: 18, capability: "questionnaire_v2" });
		expect(DAEMON_COMMAND_COMPATIBILITY.questionnaire_checkpoint).toEqual({
			minProtocol: 7,
			minSchemaRevision: 16,
			capability: "questionnaire_v1",
		});
		const server = new Set(DAEMON_DEFAULT_SERVER_CAPABILITIES);
		expect(normalizeDaemonClientCapabilities(["questionnaire_v2"], true, server)).not.toContain("questionnaire_v2");
		expect(
			normalizeDaemonClientCapabilities(["extension_ui", "questionnaire_v1", "questionnaire_v2"], false, server),
		).toContain("questionnaire_v2");
	});

	it("keeps offer and withdraw payloads content-free", () => {
		const lease = {
			supervisorGeneration: "generation-a",
			logicalRequestId: "request-a",
			offerId: "offer-a",
			leaseEpoch: 1,
			logicalClientId: "logical-a",
			connectionId: "connection-a",
			mode: "rich" as const,
		};
		const commands: DaemonCommand[] = [
			{ type: "questionnaire_presentability", activeSessionId: "session-a", presentable: true },
			{ type: "questionnaire_offer_response", activeSessionId: "session-a", lease, response: "accepted" },
			{ type: "questionnaire_withdraw_ack", activeSessionId: "session-a", lease },
		];
		const outbounds: DaemonOutbound[] = [
			{ type: "questionnaire_offer", activeSessionId: "session-a", lease },
			{ type: "questionnaire_withdraw", activeSessionId: "session-a", lease },
		];

		const serialized = JSON.stringify({ commands, outbounds });
		expect(serialized).not.toMatch(/prompt|draft|answer/i);
	});

	it("types CAS mutations and private targeted presentation snapshots under the same gate", () => {
		const lease = {
			supervisorGeneration: "generation-a",
			logicalRequestId: "request-a",
			offerId: "offer-a",
			leaseEpoch: 1,
			logicalClientId: "logical-a",
			connectionId: "connection-a",
			mode: "rich" as const,
		};
		const completeDraft = {
			version: 1 as const,
			currentStep: { kind: "review" as const },
			states: [{ questionId: "q", kind: "short-text" as const, value: "private draft" }],
		};
		const mutations: DaemonCommand[] = [
			{
				type: "questionnaire_checkpoint",
				activeSessionId: "session-a",
				lease,
				baseRevision: 0,
				clientMutationId: "mutation-a",
				completeDraft,
			},
			{
				type: "questionnaire_submit",
				activeSessionId: "session-a",
				lease,
				baseRevision: 0,
				clientMutationId: "mutation-b",
				completeDraft,
			},
			{ type: "questionnaire_dismiss", activeSessionId: "session-a", lease },
			{ type: "questionnaire_presentation_error", activeSessionId: "session-a", lease },
		];
		const presentation: DaemonOutbound = {
			type: "questionnaire_presentation_snapshot",
			activeSessionId: "session-a",
			lease,
			authoritativeRevision: 0,
			request: { version: 1, questions: [{ id: "q", kind: "short-text", prompt: "Private prompt" }] },
			draft: completeDraft,
		};

		expect(mutations).toHaveLength(4);
		expect(presentation.type).toBe("questionnaire_presentation_snapshot");
	});
});

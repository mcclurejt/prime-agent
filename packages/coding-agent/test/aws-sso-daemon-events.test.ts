import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.js";
import type { AgentConnectionSessionEvent } from "../src/modes/agent-connection/types.js";
import {
	DAEMON_OUTBOUND_COMPATIBILITY,
	DAEMON_PROTOCOL_VERSION,
	DAEMON_SCHEMA_REVISION,
	type DaemonOutbound,
	getDaemonOutboundCompatibilities,
} from "../src/modes/daemon/daemon-protocol.js";

/**
 * The AWS SSO refresh events are additive: a new daemon emits them to any
 * client, and a client that predates them ignores them. Adding them therefore
 * bumps DAEMON_SCHEMA_REVISION without a protocol bump or capability gate.
 */

const START_EVENT: Extract<AgentConnectionSessionEvent, { type: "aws_sso_refresh_start" }> = {
	type: "aws_sso_refresh_start",
	profile: "bedrock",
	reason: "expired",
};

const END_EVENT: Extract<AgentConnectionSessionEvent, { type: "aws_sso_refresh_end" }> = {
	type: "aws_sso_refresh_end",
	profile: "bedrock",
	status: "refreshed",
};

function sessionEvent(event: AgentConnectionSessionEvent): DaemonOutbound {
	return { type: "session_event", activeSessionId: "active-1", event };
}

describe("aws sso refresh wire compatibility", () => {
	it("was introduced at schema revision 19 on protocol 7", () => {
		expect(DAEMON_PROTOCOL_VERSION).toBe(7);
		expect(DAEMON_SCHEMA_REVISION).toBeGreaterThanOrEqual(19);
	});

	it("carries the events over the ungated session_event channel", () => {
		expect(DAEMON_OUTBOUND_COMPATIBILITY.session_event).toEqual({ minProtocol: DAEMON_PROTOCOL_VERSION });
		for (const event of [START_EVENT, END_EVENT]) {
			expect(getDaemonOutboundCompatibilities(sessionEvent(event))).toEqual([
				{ minProtocol: DAEMON_PROTOCOL_VERSION },
			]);
		}
	});

	it("needs neither a schema-revision floor nor a capability, so older clients still receive them", () => {
		for (const event of [START_EVENT, END_EVENT]) {
			for (const compatibility of getDaemonOutboundCompatibilities(sessionEvent(event))) {
				expect(compatibility.minSchemaRevision).toBeUndefined();
				expect(compatibility.capability).toBeUndefined();
				expect(DAEMON_SCHEMA_REVISION - 1).toBeGreaterThanOrEqual(compatibility.minSchemaRevision ?? 0);
			}
		}
	});

	it("is ignored without error by a client handler that predates the events", () => {
		// Mirrors the interactive handler shape: a switch with no default branch.
		const handled: string[] = [];
		const oldClientHandler = (event: AgentSessionEvent): void => {
			switch (event.type) {
				case "auto_retry_start":
					handled.push("auto_retry_start");
					break;
				case "auth_stale":
					handled.push("auth_stale");
					break;
			}
		};

		expect(() => {
			oldClientHandler(START_EVENT as AgentSessionEvent);
			oldClientHandler(END_EVENT as AgentSessionEvent);
			oldClientHandler({ type: "auth_stale", provider: "amazon-bedrock" });
		}).not.toThrow();
		expect(handled).toEqual(["auth_stale"]);
	});
});

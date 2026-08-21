import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AwsSsoRefresher, AwsSsoRefreshOutcome, AwsSsoRefreshReason } from "../../src/core/aws-sso-refresh.js";
import { createHarness, getAssistantTexts, type Harness } from "./harness.js";

/**
 * An expired AWS SSO session used to fail four times in a row (one attempt plus
 * three identical auto-retries) with no remediation. It is now refreshed once
 * and the turn is retried, and an unrecoverable session fails exactly once.
 */

const SSO_EXPIRED_ERROR =
	"Provider authentication failed (aws_sso_token_expired): Token is expired. To refresh this SSO session run 'aws sso login' with the corresponding profile.";

interface StubRefresher extends AwsSsoRefresher {
	calls: AwsSsoRefreshReason[];
}

function stubRefresher(outcomes: AwsSsoRefreshOutcome[]): StubRefresher {
	const calls: AwsSsoRefreshReason[] = [];
	return {
		calls,
		async ensureFresh(reason) {
			calls.push(reason);
			return outcomes[Math.min(calls.length - 1, outcomes.length - 1)];
		},
	};
}

describe("automatic AWS SSO refresh", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function createSsoHarness(refresher?: AwsSsoRefresher): Promise<Harness> {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
			awsSsoRefresher: refresher,
		});
		harnesses.push(harness);
		return harness;
	}

	it("refreshes the session once and retries the failed turn", async () => {
		const refresher = stubRefresher([{ status: "refreshed", profile: "bedrock" }]);
		const harness = await createSsoHarness(refresher);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: SSO_EXPIRED_ERROR }),
			fauxAssistantMessage("recovered after sign-in"),
		]);

		await harness.session.prompt("test");

		expect(refresher.calls).toEqual(["expired"]);
		expect(harness.eventsOfType("aws_sso_refresh_start")).toMatchObject([{ profile: "bedrock", reason: "expired" }]);
		expect(harness.eventsOfType("aws_sso_refresh_end")).toMatchObject([{ profile: "bedrock", status: "refreshed" }]);
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual([1]);
		expect(harness.faux.state.callCount).toBe(2);
		expect(getAssistantTexts(harness)).toContain("recovered after sign-in");
	});

	it("fails once instead of retrying when the session cannot be restored", async () => {
		const refresher = stubRefresher([
			{
				status: "timeout",
				profile: "bedrock",
				message:
					'AWS SSO sign-in for profile "bedrock" did not complete within 180s. Run: aws sso login --profile bedrock',
			},
		]);
		const harness = await createSsoHarness(refresher);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: SSO_EXPIRED_ERROR })]);

		await harness.session.prompt("test");

		expect(refresher.calls).toEqual(["expired"]);
		// One request, no retry storm.
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(harness.eventsOfType("aws_sso_refresh_end")).toMatchObject([{ status: "timeout" }]);
		const errors = harness.session.messages.filter(
			(message) => message.role === "assistant" && message.stopReason === "error",
		);
		expect(errors).toHaveLength(1);
		expect(harness.eventsOfType("aws_sso_refresh_end")[0].message).toContain("aws sso login --profile bedrock");
	});

	it("reports the failure once when no refresher is wired", async () => {
		const harness = await createSsoHarness();
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: SSO_EXPIRED_ERROR })]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(harness.eventsOfType("aws_sso_refresh_start")).toEqual([]);
	});

	it("retries normally when the credentials turn out not to be SSO-backed", async () => {
		const refresher = stubRefresher([{ status: "not_sso" }]);
		const harness = await createSsoHarness(refresher);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: SSO_EXPIRED_ERROR }),
			fauxAssistantMessage("recovered without a sign-in"),
		]);

		await harness.session.prompt("test");

		expect(harness.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual([1]);
		expect(getAssistantTexts(harness)).toContain("recovered without a sign-in");
	});

	it("stops recovering after the bounded number of attempts", async () => {
		const refresher = stubRefresher([{ status: "refreshed", profile: "bedrock" }]);
		const harness = await createSsoHarness(refresher);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: SSO_EXPIRED_ERROR }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: SSO_EXPIRED_ERROR }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: SSO_EXPIRED_ERROR }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: SSO_EXPIRED_ERROR }),
			fauxAssistantMessage("never reached"),
		]);

		await harness.session.prompt("test");

		// Two recoveries, then the third failure is reported instead of looping.
		expect(refresher.calls).toEqual(["expired", "expired"]);
		expect(harness.faux.state.callCount).toBe(3);
		expect(getAssistantTexts(harness)).not.toContain("never reached");
	});

	it("ignores unrelated provider failures", async () => {
		const refresher = stubRefresher([{ status: "refreshed", profile: "bedrock" }]);
		const harness = await createSsoHarness(refresher);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Provider overloaded (overloaded_error, 529)" }),
			fauxAssistantMessage("recovered after backoff"),
		]);

		await harness.session.prompt("test");

		expect(refresher.calls).toEqual([]);
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual([1]);
		expect(getAssistantTexts(harness)).toContain("recovered after backoff");
	});
});

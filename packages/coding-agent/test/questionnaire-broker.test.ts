import { afterEach, describe, expect, it, vi } from "vitest";
import {
	QuestionnaireBroker,
	type QuestionnaireBrokerCallbacks,
	type QuestionnairePresenter,
	type QuestionnaireWorkerOfferNeed,
} from "../src/modes/daemon/questionnaire-broker.js";

function presenter(
	connectionId: string,
	activeSessionId: string,
	capabilities: QuestionnairePresenter["capabilities"] = ["extension_ui", "questionnaire_v1"],
): QuestionnairePresenter {
	return {
		logicalClientId: `logical-${connectionId}`,
		connectionId,
		activeSessionId,
		capabilities,
		presentable: true,
	};
}

function need(
	workerId: string,
	activeSessionId: string,
	createdAt: number,
	overrides: Partial<QuestionnaireWorkerOfferNeed> = {},
): QuestionnaireWorkerOfferNeed {
	return {
		workerId,
		activeSessionId,
		supervisorGeneration: "generation-a",
		logicalRequestId: `request-${workerId}`,
		offerId: `offer-${workerId}`,
		leaseEpoch: 1,
		createdAt,
		mode: "undecided",
		...overrides,
	};
}

function harness(): {
	broker: QuestionnaireBroker;
	callbacks: QuestionnaireBrokerCallbacks;
	offers: Array<{ connectionId: string; lease: unknown }>;
	results: Array<{ workerId: string; result: unknown }>;
	withdraws: Array<{ connectionId: string; lease: unknown }>;
} {
	const offers: Array<{ connectionId: string; lease: unknown }> = [];
	const results: Array<{ workerId: string; result: unknown }> = [];
	const withdraws: Array<{ connectionId: string; lease: unknown }> = [];
	const callbacks: QuestionnaireBrokerCallbacks = {
		deliverOffer: (connectionId, _activeSessionId, lease) => offers.push({ connectionId, lease }),
		deliverWithdraw: (connectionId, _activeSessionId, lease) => withdraws.push({ connectionId, lease }),
		onOfferResult: (workerId, result) => results.push({ workerId, result }),
		onLeaseRevoked: vi.fn(),
		onWithdrawn: vi.fn(),
	};
	return { broker: new QuestionnaireBroker("generation-a", callbacks), callbacks, offers, results, withdraws };
}

function acceptedLease(offers: Array<{ connectionId: string; lease: unknown }>, index = 0) {
	return offers[index]!.lease as {
		supervisorGeneration: string;
		logicalRequestId: string;
		offerId: string;
		leaseEpoch: number;
		logicalClientId: string;
		connectionId: string;
		mode: "rich" | "legacy";
	};
}

afterEach(() => vi.useRealTimers());

describe("QuestionnaireBroker", () => {
	it("prefers rich presenters and targets exactly one immutable connection", () => {
		const { broker, offers } = harness();
		broker.synchronizePresenters([
			presenter("legacy", "session-a", ["extension_ui"]),
			presenter("rich", "session-a"),
		]);

		broker.offer(need("worker-a", "session-a", 1));

		expect(offers).toHaveLength(1);
		expect(offers[0]!.connectionId).toBe("rich");
		expect(acceptedLease(offers)).toMatchObject({
			connectionId: "rich",
			logicalClientId: "logical-rich",
			mode: "rich",
		});
	});

	it("enforces one global focus lease per connection without head-of-line blocking", () => {
		const { broker, offers } = harness();
		broker.synchronizePresenters([
			presenter("shared", "session-a"),
			presenter("shared", "session-b"),
			presenter("other", "session-c"),
		]);
		broker.offer(need("worker-a", "session-a", 1));
		broker.offer(need("worker-b", "session-b", 2));
		broker.offer(need("worker-c", "session-c", 3));

		expect(offers.map((offer) => [offer.connectionId, acceptedLease([offer]).logicalRequestId])).toEqual([
			["shared", "request-worker-a"],
			["other", "request-worker-c"],
		]);
	});

	it("skips an older request with no eligible presenter and offers another ready session", () => {
		const { broker, offers } = harness();
		broker.synchronizePresenters([presenter("available", "session-b")]);
		broker.offer(need("worker-a", "session-a", 1));
		broker.offer(need("worker-b", "session-b", 2));

		expect(offers).toHaveLength(1);
		expect(acceptedLease(offers).logicalRequestId).toBe("request-worker-b");
	});

	it("keeps duplicate logical client IDs distinct by socket incarnation", () => {
		const { broker, offers } = harness();
		const first = { ...presenter("connection-a", "session-a"), logicalClientId: "duplicate" };
		const second = { ...presenter("connection-b", "session-b"), logicalClientId: "duplicate" };
		broker.synchronizePresenters([first, second]);
		broker.offer(need("worker-a", "session-a", 1));
		broker.offer(need("worker-b", "session-b", 2));

		expect(offers.map((offer) => offer.connectionId)).toEqual(["connection-a", "connection-b"]);
	});

	it("accepts only the socket-derived exact offer stamp and rejects stale responses", () => {
		const { broker, offers, results } = harness();
		broker.synchronizePresenters([presenter("connection-a", "session-a")]);
		broker.offer(need("worker-a", "session-a", 1));
		const lease = acceptedLease(offers);

		expect(broker.respondToOffer("connection-a", "session-b", lease, "accepted")).toBe("stale");
		expect(broker.respondToOffer("connection-b", "session-a", lease, "accepted")).toBe("stale");
		expect(broker.respondToOffer("connection-a", "session-a", { ...lease, leaseEpoch: 2 }, "accepted")).toBe("stale");
		expect(results).toEqual([]);
		expect(broker.respondToOffer("connection-a", "session-a", lease, "accepted")).toBe("accepted");
		expect(results).toEqual([{ workerId: "worker-a", result: { status: "accepted", lease } }]);
	});

	it("treats exact queued, pending, and accepted offer retries idempotently", () => {
		const { broker, offers, results } = harness();
		const original = need("worker-a", "session-a", 1);
		broker.offer(original);
		broker.offer(original);
		broker.synchronizePresenters([presenter("connection-a", "session-a")]);
		expect(offers).toHaveLength(1);
		expect(results).toEqual([]);

		broker.offer(original);
		expect(offers).toHaveLength(1);
		expect(results).toEqual([]);
		const lease = acceptedLease(offers);
		broker.respondToOffer("connection-a", "session-a", lease, "accepted");
		results.length = 0;

		broker.offer(original);
		expect(results).toEqual([{ workerId: "worker-a", result: { status: "accepted", lease } }]);
	});

	it("uses the five-second timeout only to reject a lost offer and release capacity", () => {
		vi.useFakeTimers();
		const { broker, offers, results } = harness();
		broker.synchronizePresenters([presenter("connection-a", "session-a")]);
		broker.offer(need("worker-a", "session-a", 1));

		vi.advanceTimersByTime(4_999);
		expect(results).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(results).toEqual([
			{
				workerId: "worker-a",
				result: { status: "rejected", reason: "timeout", offer: acceptedLease(offers) },
			},
		]);

		broker.offer(
			need("worker-b", "session-a", 2, {
				logicalRequestId: "request-worker-b",
				offerId: "offer-worker-b",
			}),
		);
		expect(offers).toHaveLength(2);
	});

	it("revokes accepted leases on client loss without claiming a terminal answer", () => {
		const { broker, callbacks, offers } = harness();
		broker.synchronizePresenters([presenter("connection-a", "session-a")]);
		broker.offer(need("worker-a", "session-a", 1));
		const lease = acceptedLease(offers);
		broker.respondToOffer("connection-a", "session-a", lease, "accepted");

		broker.disconnect("connection-a");

		expect(callbacks.onLeaseRevoked).toHaveBeenCalledWith("worker-a", lease, "client_lost");
		expect(broker.validateLeaseMessage("connection-a", "session-a", lease)).toBe(false);
	});

	it("routes transient presentation only to the active lease and never caches the payload", () => {
		const { broker, offers } = harness();
		broker.synchronizePresenters([presenter("connection-a", "session-a"), presenter("connection-b", "session-a")]);
		broker.offer(need("worker-a", "session-a", 1));
		const lease = acceptedLease(offers);
		broker.respondToOffer("connection-a", "session-a", lease, "accepted");
		const delivered: Array<{ connectionId: string; payload: unknown }> = [];
		const payload = { private: "questionnaire prompt and draft" };

		expect(
			broker.routeToLease("worker-a", "session-a", lease, (connectionId) =>
				delivered.push({ connectionId, payload }),
			),
		).toBe(true);
		expect(delivered).toEqual([{ connectionId: "connection-a", payload }]);
		expect(broker.routeToLease("worker-a", "session-a", { ...lease, offerId: "stale" }, () => {})).toBe(false);
		expect(JSON.stringify(broker.debugContentFreeState())).not.toContain("questionnaire prompt and draft");
	});

	it("keeps capacity until an exact withdraw ACK, then permits the next fair offer", () => {
		const { broker, callbacks, offers, withdraws } = harness();
		broker.synchronizePresenters([presenter("connection-a", "session-a"), presenter("connection-a", "session-b")]);
		broker.offer(need("worker-a", "session-a", 1));
		const lease = acceptedLease(offers);
		broker.respondToOffer("connection-a", "session-a", lease, "accepted");
		broker.offer(need("worker-b", "session-b", 2));

		expect(broker.withdraw("worker-a", lease)).toBe(true);
		expect(withdraws).toEqual([{ connectionId: "connection-a", lease }]);
		expect(broker.leaseForMessage("connection-a", "session-a", lease)).toBeUndefined();
		expect(broker.leaseForMessage("connection-a", "session-a", lease, true)).toEqual(lease);
		expect(broker.acknowledgeWithdraw("connection-a", "session-a", { ...lease, leaseEpoch: 2 })).toBe("stale");
		expect(offers).toHaveLength(1);
		expect(broker.acknowledgeWithdraw("connection-a", "session-a", lease)).toBe("accepted");
		expect(callbacks.onWithdrawn).toHaveBeenCalledWith("worker-a", lease);
		expect(broker.leaseForMessage("connection-a", "session-a", lease, true)).toBeUndefined();
		expect(offers).toHaveLength(2);
		expect(acceptedLease(offers, 1).logicalRequestId).toBe("request-worker-b");
	});

	it("revokes a lease when its exact session loses presentability even if the socket remains attached elsewhere", () => {
		const { broker, callbacks, offers } = harness();
		broker.synchronizePresenters([presenter("connection-a", "session-a"), presenter("connection-a", "session-b")]);
		broker.offer(need("worker-a", "session-b", 1));
		const lease = acceptedLease(offers);
		broker.respondToOffer("connection-a", "session-b", lease, "accepted");

		broker.synchronizePresenters([presenter("connection-a", "session-a")]);

		expect(callbacks.onLeaseRevoked).toHaveBeenCalledWith("worker-a", lease, "presentability_lost");
	});

	it("ignores wrong-generation offers and excludes non-presentable attachments", () => {
		const { broker, offers, results } = harness();
		broker.synchronizePresenters([{ ...presenter("connection-a", "session-a"), presentable: false }]);
		broker.offer(need("worker-a", "session-a", 1, { supervisorGeneration: "generation-old" }));

		expect(offers).toEqual([]);
		expect(results).toEqual([
			{
				workerId: "worker-a",
				result: {
					status: "rejected",
					reason: "stale_generation",
					offer: expect.objectContaining({ supervisorGeneration: "generation-old" }),
				},
			},
		]);
	});
});

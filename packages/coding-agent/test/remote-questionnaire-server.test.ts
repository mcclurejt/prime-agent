import { type RequestOptions, request } from "node:http";
import { createConnection } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteQuestionnairePage } from "../src/modes/interactive/remote-questionnaire-page.js";
import {
	RemoteQuestionnaireServer,
	type RemoteQuestionnaireServerDependencies,
} from "../src/modes/interactive/remote-questionnaire-server.js";

interface Response {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}

function send(
	url: string,
	options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Response> {
	return new Promise((resolve, reject) => {
		const target = new URL(url);
		const requestOptions: RequestOptions = {
			hostname: target.hostname,
			port: target.port,
			path: target.pathname,
			method: options.method ?? "GET",
			headers: options.headers,
		};
		const req = request(requestOptions, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk: string) => {
				body += chunk;
			});
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
		});
		req.on("error", reject);
		if (options.body) req.write(options.body);
		req.end();
	});
}

function cookie(response: Response): string {
	const value = response.headers["set-cookie"];
	if (!Array.isArray(value) || value.length !== 1) throw new Error("Expected one session cookie");
	return value[0].split(";", 1)[0]!;
}

function bootstrap(server: RemoteQuestionnaireServer, secret = server.fragmentSecret): Promise<Response> {
	return send(`${server.url}/bootstrap`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ secret }),
	});
}

const servers: RemoteQuestionnaireServer[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function create(
	dependencies?: Partial<RemoteQuestionnaireServerDependencies>,
): Promise<RemoteQuestionnaireServer> {
	const server = await RemoteQuestionnaireServer.create(dependencies);
	servers.push(server);
	return server;
}

describe("RemoteQuestionnaireServer", () => {
	it("binds only an ephemeral IPv4 loopback address and keeps generic preview GET allocation-free", async () => {
		const server = await create();
		expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/r\/[A-Za-z0-9_-]{22}$/);
		expect(server.fragmentSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const before = server.debugState();
		const preview = await send(server.url);
		expect(preview.status).toBe(200);
		expect(preview.body).toContain("history.replaceState");
		expect(preview.body).toContain("<noscript>");
		expect(preview.body).not.toContain(server.fragmentSecret);
		expect(server.debugState()).toEqual(before);
		expect((await send(`${server.url}-unknown`)).status).toBe(404);
	});

	it("exchanges a separate fragment secret exactly once with a secure scoped cookie and CSRF token", async () => {
		const server = await create();
		const secret = server.fragmentSecret;
		const first = await bootstrap(server, secret);
		expect(first.status).toBe(200);
		expect(first.headers["set-cookie"]).toEqual([
			expect.stringMatching(new RegExp(`HttpOnly; Secure; SameSite=Strict; Path=/r/${server.routeId}$`)),
		]);
		expect(JSON.parse(first.body)).toEqual({ csrf: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
		expect((await bootstrap(server, secret)).status).toBe(401);
		expect((await bootstrap(server, "0".repeat(43))).status).toBe(401);
	});

	it("accepts only the current exact public hostname or loopback host and rejects present cross-site provenance", async () => {
		const server = await create();
		server.setPublicHostname("blue-forest.trycloudflare.com");
		const publicUrl = server.url.replace(/127\.0\.0\.1:\d+/u, "blue-forest.trycloudflare.com");
		const accepted = await send(server.url, { headers: { host: "blue-forest.trycloudflare.com" } });
		expect(accepted.status).toBe(200);
		expect((await send(server.url, { headers: { host: "old.trycloudflare.com" } })).status).toBe(421);
		expect(
			await send(`${server.url}/bootstrap`, {
				method: "POST",
				headers: {
					host: "blue-forest.trycloudflare.com",
					origin: "https://attacker.invalid",
					"content-type": "application/json",
				},
				body: JSON.stringify({ secret: server.fragmentSecret }),
			}),
		).toMatchObject({ status: 403 });
		expect(
			await send(`${server.url}/bootstrap`, {
				method: "POST",
				headers: {
					host: "blue-forest.trycloudflare.com",
					origin: `https://${new URL(publicUrl).hostname}`,
					"sec-fetch-site": "cross-site",
					"content-type": "application/json",
				},
				body: JSON.stringify({ secret: server.fragmentSecret }),
			}),
		).toMatchObject({ status: 403 });
		expect((await bootstrap(server)).status).toBe(200);
		server.setPublicHostname("new-forest.trycloudflare.com");
		expect((await send(server.url, { headers: { host: "blue-forest.trycloudflare.com" } })).status).toBe(421);
	});

	it("enforces exact routes, methods, content type and body size without CORS", async () => {
		const server = await create();
		expect((await send(`${server.url}/bootstrap`)).status).toBe(405);
		expect((await send(server.url, { method: "PUT" })).status).toBe(405);
		expect((await send(`${server.url}/bootstrap`, { method: "POST", body: "{}" })).status).toBe(415);
		expect(
			(
				await send(`${server.url}/bootstrap`, {
					method: "POST",
					headers: { "content-type": "application/json; charset=utf-8" },
					body: "{}",
				})
			).status,
		).toBe(415);
		expect(
			(
				await send(`${server.url}/bootstrap`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "x".repeat(1024 * 1024 + 1),
				})
			).status,
		).toBe(413);
		const response = await send(server.url);
		expect(response.headers["access-control-allow-origin"]).toBeUndefined();
		expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
		expect(response.headers["strict-transport-security"]).toBeDefined();
	});

	it("caps sessions, serializes authenticated mutations, and uses constant-time session and CSRF gates", async () => {
		let release: (() => void) | undefined;
		const mutation = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const server = await create({ onMutation: mutation });
		const first = await bootstrap(server);
		const firstPayload = JSON.parse(first.body) as { csrf: string };
		const sessionCookie = cookie(first);
		const secondPromise = send(`${server.url}/mutate`, {
			method: "POST",
			headers: { cookie: sessionCookie, "x-csrf-token": firstPayload.csrf, "content-type": "application/json" },
			body: JSON.stringify({ action: "next" }),
		});
		await vi.waitFor(() => expect(mutation).toHaveBeenCalledOnce());
		const statusWhileMutating = await send(`${server.url}/status`, { headers: { cookie: sessionCookie } });
		expect(statusWhileMutating.status).toBe(200);
		release?.();
		expect((await secondPromise).status).toBe(204);
		expect(
			(
				await send(`${server.url}/mutate`, {
					method: "POST",
					headers: { cookie: sessionCookie, "x-csrf-token": "wrong", "content-type": "application/json" },
					body: "{}",
				})
			).status,
		).toBe(403);
		expect((await send(`${server.url}/status`, { headers: { cookie: "remote_questionnaire=wrong" } })).status).toBe(
			401,
		);
	});

	it("makes expiry, stale, terminal and revoke inert, with status as event-delivery fallback", async () => {
		let now = 10_000;
		const server = await create({ clock: { now: () => now }, expiresAt: 11_000 });
		const response = await bootstrap(server);
		const sessionCookie = cookie(response);
		expect((await send(`${server.url}/status`, { headers: { cookie: sessionCookie } })).body).toContain('"active"');
		now = 11_001;
		expect((await send(`${server.url}/status`, { headers: { cookie: sessionCookie } })).body).toContain('"expired"');
		expect(server.status).toBe("expired");
		server.setStale("Changed elsewhere");
		expect(server.status).toBe("expired");
		const terminal = await create();
		const terminalSession = await bootstrap(terminal);
		terminal.setTerminal("Answered elsewhere");
		expect((await send(`${terminal.url}/status`, { headers: { cookie: cookie(terminalSession) } })).body).toContain(
			'"terminal"',
		);
		await terminal.revoke();
		expect(terminal.status).toBe("revoked");
		expect(await terminal.close()).toBeUndefined();
		expect(await terminal.close()).toBeUndefined();
	});
	it("renders an authenticated progressive form and forwards strict page actions through the serialized callback", async () => {
		const onMutation = vi.fn(() => ({ kind: "accepted" as const }));
		const page = new RemoteQuestionnairePage({
			version: 2,
			title: "Release gate",
			questions: [{ id: "approve", kind: "confirm", prompt: "Approve release?", yesLabel: "Approve" }],
		});
		const server = await create({ page, onMutation });
		const bootstrapped = await bootstrap(server);
		const csrf = (JSON.parse(bootstrapped.body) as { csrf: string }).csrf;
		const sessionCookie = cookie(bootstrapped);
		const form = await send(server.url, { headers: { cookie: sessionCookie } });
		expect(form.status).toBe(200);
		expect(form.body).toContain("<fieldset");
		expect(form.body).toContain('name="csrf"');
		expect(form.body).toContain("Approve release?");
		const answered = await send(`${server.url}/mutate`, {
			method: "POST",
			headers: { cookie: sessionCookie, "x-csrf-token": csrf, "content-type": "application/json" },
			body: JSON.stringify({ action: "answer-confirm", questionId: "approve", selection: "yes" }),
		});
		expect(answered.status).toBe(204);
		expect(onMutation).toHaveBeenCalledWith(
			expect.objectContaining({
				page: expect.objectContaining({ action: "answer-confirm", questionId: "approve" }),
			}),
		);
		expect(page.model.responses()[0]).toMatchObject({ status: "answered", value: true });
		expect(
			(
				await send(`${server.url}/mutate`, {
					method: "POST",
					headers: { cookie: sessionCookie, "x-csrf-token": csrf, "content-type": "application/json" },
					body: JSON.stringify({ action: "answer-confirm", questionId: "approve", selection: "invalid" }),
				})
			).status,
		).toBe(400);
	});

	it("renders ordered Review rows, notes, exact Edit actions, and an explicit submit only on Review", async () => {
		const page = new RemoteQuestionnairePage({
			version: 2,
			submitLabel: "Submit decision",
			questions: [
				{ id: "first", kind: "confirm", prompt: "First?" },
				{ id: "second", kind: "short-text", prompt: "Second?" },
			],
		});
		page.answerConfirm("first", "yes");
		page.updateNote("first", "Checked");
		page.goToReview();
		const server = await create({ page });
		const boot = await bootstrap(server);
		const headers = {
			cookie: cookie(boot),
			"x-csrf-token": (JSON.parse(boot.body) as { csrf: string }).csrf,
			"content-type": "application/json",
		};
		const review = await send(server.url, { headers: { cookie: cookie(boot) } });
		expect(review.body).toContain("Review");
		expect(review.body.indexOf("First?")).toBeLessThan(review.body.indexOf("Second?"));
		expect(review.body).toContain("Yes");
		expect(review.body).toContain("Unanswered");
		expect(review.body).toContain("Checked");
		expect(review.body).toContain("Submit decision");
		expect(
			(
				await send(`${server.url}/mutate`, {
					method: "POST",
					headers,
					body: JSON.stringify({ action: "edit", questionId: "second" }),
				})
			).status,
		).toBe(204);
		expect(page.model.currentStep).toEqual({ kind: "question", questionId: "second" });
		expect(
			(await send(`${server.url}/mutate`, { method: "POST", headers, body: JSON.stringify({ action: "submit" }) }))
				.status,
		).toBe(422);
	});

	it("renders and persists a v2 per-question note without changing the answer", async () => {
		const page = new RemoteQuestionnairePage({
			version: 2,
			questions: [{ id: "decision", kind: "confirm", prompt: "Proceed?" }],
		});
		page.answerConfirm("decision", "yes");
		page.updateNote("decision", "Initial note");
		const server = await create({ page });
		const boot = await bootstrap(server);
		const csrf = (JSON.parse(boot.body) as { csrf: string }).csrf;
		const cookieValue = cookie(boot);
		const headers = { cookie: cookieValue, "x-csrf-token": csrf, "content-type": "application/json" };
		expect((await send(server.url, { headers: { cookie: cookieValue } })).body).toContain("Initial note");
		expect(
			(
				await send(`${server.url}/mutate`, {
					method: "POST",
					headers,
					body: JSON.stringify({ action: "update-note", questionId: "decision", text: "Updated note" }),
				})
			).status,
		).toBe(204);
		expect(page.model.responses()[0]).toMatchObject({ status: "answered", value: true, note: "Updated note" });
		expect((await send(server.url, { headers: { cookie: cookieValue } })).body).toContain("Updated note");
		page.goToReview();
		expect((await send(server.url, { headers: { cookie: cookieValue } })).body).toContain("Updated note");
	});

	it("renders rich v2 text as inert escaped text and keeps previews alt-only", async () => {
		const page = new RemoteQuestionnairePage({
			version: 2,
			questions: [
				{
					id: "choice",
					kind: "single-select",
					prompt: "Pick",
					context: "<img onerror=alert(1)> [bad](javascript:alert(1))",
					recommendation: { choiceId: "a", rationale: "Use <b>A</b>" },
					choices: [
						{
							id: "a",
							label: "A",
							description: "Description",
							detail: "Detail [file](file:///secret)",
							preview: {
								title: "Preview",
								markdown: "<script>x</script> [data](data:text/html,x)",
								alt: "Required alternative",
							},
						},
					],
				},
			],
		});
		const server = await create({ page });
		const boot = await bootstrap(server);
		const html = (await send(server.url, { headers: { cookie: cookie(boot) } })).body;
		expect(html).toContain("&lt;img");
		expect(html).toContain("Use &lt;b&gt;A&lt;/b&gt;");
		expect(html).toContain("Description");
		expect(html).toContain("Detail");
		expect(html).toContain("Preview");
		expect(html).toContain("Required alternative");
		expect(html).not.toContain("<script>");
		expect(html).not.toMatch(/<(?:img|a)\b/iu);
		expect(html).not.toContain("javascript:");
		expect(html).not.toContain("data:text");
		expect(html).not.toContain("file://");
	});

	it("atomically replaces seeded multi-select choices and custom Other without losing notes", async () => {
		const page = new RemoteQuestionnairePage({
			version: 2,
			questions: [
				{
					id: "regions",
					kind: "multi-select",
					prompt: "Regions",
					choices: [
						{ id: "east", label: "East" },
						{ id: "west", label: "West" },
					],
					other: { label: "Other" },
				},
			],
		});
		page.toggleMultiChoice("regions", "east");
		page.updateNote("regions", "Keep note");
		const server = await create({ page });
		const boot = await bootstrap(server);
		const csrf = (JSON.parse(boot.body) as { csrf: string }).csrf;
		const cookieValue = cookie(boot);
		let html = (await send(server.url, { headers: { cookie: cookieValue } })).body;
		expect(html).toMatch(/value="east"[^>]*checked/);
		expect(html).toContain('value="west"');
		const headers = { cookie: cookieValue, "x-csrf-token": csrf, "content-type": "application/json" };
		expect(
			(
				await send(`${server.url}/mutate`, {
					method: "POST",
					headers,
					body: JSON.stringify({
						action: "set-multi",
						questionId: "regions",
						choiceIds: ["west"],
						otherSelected: true,
						otherText: "central",
					}),
				})
			).status,
		).toBe(204);
		expect(page.model.getState("regions")).toMatchObject({
			choiceIds: ["west"],
			otherSelected: true,
			otherText: "central",
			note: "Keep note",
		});
		page.goToReview();
		html = (await send(server.url, { headers: { cookie: cookieValue } })).body;
		expect(html).toContain("west, central");
		expect(
			(
				await send(`${server.url}/mutate`, {
					method: "POST",
					headers,
					body: JSON.stringify({
						action: "set-multi",
						questionId: "regions",
						choiceIds: ["bad"],
						otherSelected: false,
						otherText: "",
					}),
				})
			).status,
		).toBe(422);
	});
});

function rawRequest(port: number, payload: string): Promise<{ response: string; error?: NodeJS.ErrnoException }> {
	return new Promise((resolve) => {
		const socket = createConnection({ host: "127.0.0.1", port });
		let received = "";
		let error: NodeJS.ErrnoException | undefined;
		socket.setEncoding("utf8");
		socket.setTimeout(5_000, () => socket.destroy(new Error("Timed out waiting for loopback response")));
		socket.on("connect", () => socket.end(payload));
		socket.on("data", (chunk: string) => {
			received += chunk;
		});
		socket.on("error", (reason: NodeJS.ErrnoException) => {
			error = reason;
		});
		socket.on("close", () => resolve({ response: received, error }));
	});
}

function openSocket(port: number): Promise<ReturnType<typeof createConnection>> {
	return new Promise((resolve, reject) => {
		const socket = createConnection({ host: "127.0.0.1", port });
		socket.once("connect", () => resolve(socket));
		socket.once("error", reject);
	});
}

describe("RemoteQuestionnaireServer adversarial loopback contracts", () => {
	it("normalizes the explicit form multi-select clear sentinel, rejects omission, and rejects a wrong-kind action", async () => {
		const page = new RemoteQuestionnairePage({
			version: 2,
			questions: [
				{ id: "regions", kind: "multi-select", prompt: "Regions", choices: [{ id: "east", label: "East" }] },
				{ id: "confirm", kind: "confirm", prompt: "Continue?" },
			],
		});
		page.toggleMultiChoice("regions", "east");
		const server = await create({ page });
		const boot = await bootstrap(server);
		const headers = {
			cookie: cookie(boot),
			"x-csrf-token": (JSON.parse(boot.body) as { csrf: string }).csrf,
			"content-type": "application/x-www-form-urlencoded",
		};
		const form = await send(server.url, { headers: { cookie: headers.cookie } });
		expect(form.body).toContain('type="hidden" name="choiceIds" value=""');
		expect(
			(
				await send(`${server.url}/mutate`, {
					method: "POST",
					headers,
					body: "action=set-multi&questionId=regions&choiceIds=&otherSelected=false&otherText=",
				})
			).status,
		).toBe(204);
		expect(page.model.getState("regions")).toMatchObject({ choiceIds: [] });
		expect(
			(
				await send(`${server.url}/mutate`, {
					method: "POST",
					headers,
					body: "action=set-multi&questionId=regions&otherSelected=false&otherText=",
				})
			).status,
		).toBe(400);
		expect(
			(
				await send(`${server.url}/mutate`, {
					method: "POST",
					headers,
					body: "action=set-multi&questionId=confirm&choiceIds=&otherSelected=false&otherText=",
				})
			).status,
		).toBe(422);
	});

	it("rejects actual oversized raw headers and transport bodies", async () => {
		const server = await create();
		const port = new URL(server.url).port;
		const headerResponse = await rawRequest(
			Number(port),
			`GET /r/${server.routeId} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nX-Large: ${"x".repeat(16 * 1024 + 1)}\r\nConnection: close\r\n\r\n`,
		);
		expect(headerResponse.response).toMatch(/^HTTP\/1\.1 431 /);
		const bodyResponse = await send(`${server.url}/bootstrap`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "x".repeat(1024 * 1024 + 1),
		});
		expect(bodyResponse.status).toBe(413);
	});

	it("enforces the 16-socket and 32-requests-per-socket caps on live loopback sockets", async () => {
		const server = await create();
		const port = Number(new URL(server.url).port);
		const sockets = await Promise.all(Array.from({ length: 16 }, () => openSocket(port)));
		const overflow = await openSocket(port);
		await new Promise((resolve) => overflow.once("close", resolve));
		expect(overflow.destroyed).toBe(true);
		for (const socket of sockets) socket.destroy();

		const requests = Array.from(
			{ length: 33 },
			() => `GET /r/${server.routeId} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: keep-alive\r\n\r\n`,
		).join("");
		const responses = await rawRequest(port, requests);
		expect([...responses.response.matchAll(/HTTP\/1\.1 (\d+)/gu)].map((match) => Number(match[1]))).toEqual([
			...Array.from({ length: 32 }, () => 200),
			429,
		]);
	});

	it("shares one authenticated cookie across four tabs, serializes interleaved writes, and survives terminal notice failure", async () => {
		const page = new RemoteQuestionnairePage({
			version: 2,
			questions: [{ id: "answer", kind: "short-text", prompt: "Answer" }],
		});
		const notice = vi.fn(() => {
			throw new Error("observer disconnected");
		});
		const server = await create({
			page,
			onTerminalEvent: notice,
			onMutation: ({ page: action }) =>
				action.action === "submit" ? { kind: "terminal", message: "Accepted elsewhere" } : { kind: "accepted" },
		});
		const boot = await bootstrap(server);
		const headers = {
			cookie: cookie(boot),
			"x-csrf-token": (JSON.parse(boot.body) as { csrf: string }).csrf,
			"content-type": "application/json",
		};
		const tabs = await Promise.all(
			Array.from({ length: 4 }, () => send(server.url, { headers: { cookie: headers.cookie } })),
		);
		expect(tabs.every((tab) => tab.status === 200)).toBe(true);
		expect(server.debugState().sessionCount).toBe(1);
		const first = send(`${server.url}/mutate`, {
			method: "POST",
			headers,
			body: JSON.stringify({ action: "update-text", questionId: "answer", text: "first" }),
		});
		const second = send(`${server.url}/mutate`, {
			method: "POST",
			headers,
			body: JSON.stringify({ action: "update-text", questionId: "answer", text: "last" }),
		});
		expect([(await first).status, (await second).status]).toEqual([204, 204]);
		expect((await send(server.url, { headers: { cookie: headers.cookie } })).body).toContain('value="last"');
		page.goToReview();
		expect(
			(await send(`${server.url}/mutate`, { method: "POST", headers, body: JSON.stringify({ action: "submit" }) }))
				.status,
		).toBe(200);
		expect(notice).toHaveBeenCalledWith({ status: "terminal", message: "Accepted elsewhere" });
		expect((await send(`${server.url}/status`, { headers: { cookie: headers.cookie } })).body).toContain(
			'"terminal"',
		);
		expect(
			(await send(`${server.url}/mutate`, { method: "POST", headers, body: JSON.stringify({ action: "next" }) }))
				.body,
		).toContain('"terminal"');
	});
});

import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";
import { type IncomingMessage, createServer as nodeCreateServer, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type {
	RemoteQuestionnairePage,
	RemoteQuestionnairePageAction,
	RemoteQuestionnairePageView,
} from "./remote-questionnaire-page.js";
import { renderSafeQuestionnaireMarkdown } from "./remote-questionnaire-page.js";

const MAX_HEADER_BYTES = 16 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_SOCKETS = 16;
const MAX_REQUESTS_PER_SOCKET = 32;
const SESSION_COOKIE = "remote_questionnaire";
const TOKEN_BYTES = 32;
const ROUTE_BYTES = 16;
const BOOTSTRAP_SCRIPT = `const secret=location.hash.slice(1);const showError=()=>{const alert=document.createElement("p");alert.setAttribute("role","alert");alert.textContent="Unable to establish session. Keep this link open and retry.";document.body.prepend(alert)};if(secret){fetch(location.pathname+"/bootstrap",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({secret}),credentials:"same-origin"}).then(r=>{if(r.ok){history.replaceState(null,"",location.pathname);location.reload()}else showError()}).catch(showError)}`;
const STATUS_POLL_SCRIPT = `setInterval(()=>fetch(location.pathname+"/status",{credentials:"same-origin"}).then(r=>r.json()).then(s=>{if(["terminal","stale","revoked","expired"].includes(s.status))location.reload()}).catch(()=>{}),3000)`;

export type RemoteQuestionnaireStatus = "active" | "stale" | "terminal" | "revoked" | "expired";

export interface RemoteQuestionnaireClock {
	now(): number;
}

export type RemoteQuestionnaireMutationResult =
	| { kind: "accepted" }
	| { kind: "suspended"; message?: string }
	| { kind: "stale"; message?: string }
	| { kind: "terminal"; message?: string };

export interface RemoteQuestionnaireMutationContext {
	sessionId: string;
	page: RemoteQuestionnairePageAction;
}

export interface RemoteQuestionnaireServerDependencies {
	clock: RemoteQuestionnaireClock;
	randomBytes(size: number): Buffer;
	createServer(listener: (request: IncomingMessage, response: ServerResponse) => void): Server;
	onMutation(
		context: RemoteQuestionnaireMutationContext,
	): Promise<RemoteQuestionnaireMutationResult | undefined> | RemoteQuestionnaireMutationResult | undefined;
	onTerminalEvent(event: { status: "terminal"; message?: string }): Promise<void> | void;
}

export interface RemoteQuestionnaireServerOptions {
	expiresAt?: number;
	page?: RemoteQuestionnairePage;
	presentation?: { projectLabel?: string; sessionLabel?: string };
	onMutation?: RemoteQuestionnaireServerDependencies["onMutation"];
}

interface Session {
	id: string;
	csrf: string;
}

const defaultDependencies: RemoteQuestionnaireServerDependencies = {
	clock: { now: () => Date.now() },
	randomBytes: nodeRandomBytes,
	createServer: (listener) => nodeCreateServer({ maxHeaderSize: MAX_HEADER_BYTES }, listener),
	onMutation: () => undefined,
	onTerminalEvent: () => undefined,
};

const PAGE_CSS = `:root{color-scheme:light dark;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body{margin:0;background:Canvas;color:CanvasText}main{max-width:42rem;margin:auto;padding:clamp(1rem,4vw,2rem)}fieldset{border:1px solid GrayText;border-radius:.5rem;margin:1rem 0;padding:1rem}label,button,input,textarea{font:inherit}label{display:block;margin:.75rem 0}input,textarea{box-sizing:border-box;min-height:2.75rem;width:100%}button{min-height:2.75rem;margin:.25rem;padding:.5rem .75rem}button:focus-visible,input:focus-visible,textarea:focus-visible{outline:3px solid Highlight;outline-offset:2px}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}`;
const scriptHash = createScriptHash(BOOTSTRAP_SCRIPT);
const statusPollScriptHash = createScriptHash(STATUS_POLL_SCRIPT);
const pageStyleHash = createScriptHash(PAGE_CSS);
const SECURITY_HEADERS = {
	"cache-control": "no-store",
	"content-security-policy": `default-src 'none'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'none'; script-src 'sha256-${scriptHash}' 'sha256-${statusPollScriptHash}'; style-src 'sha256-${pageStyleHash}'`,
	"cross-origin-opener-policy": "same-origin",
	"cross-origin-resource-policy": "same-origin",
	"permissions-policy": "accelerometer=(), camera=(), geolocation=(), microphone=(), payment=(), usb=()",
	"referrer-policy": "no-referrer",
	"strict-transport-security": "max-age=31536000; includeSubDomains",
	"x-content-type-options": "nosniff",
	"x-frame-options": "DENY",
} as const;

/** Loopback-only, fragment-bootstrap session boundary. It has no questionnaire or transport authority. */
export class RemoteQuestionnaireServer {
	readonly routeId: string;
	readonly fragmentSecret: string;
	private readonly route: string;
	private readonly sessions = new Map<string, Session>();
	private readonly sockets = new Set<Socket>();
	private readonly requestsPerSocket = new WeakMap<Socket, number>();
	private readonly dependencies: RemoteQuestionnaireServerDependencies;
	private readonly expiresAt: number | undefined;
	private page: RemoteQuestionnairePage | undefined;
	private publicHostname: string | undefined;
	private statusValue: RemoteQuestionnaireStatus = "active";
	private suspended = false;
	private statusMessage: string | undefined;
	private bootstrapConsumed = false;
	private closed = false;
	private mutationTail: Promise<void> = Promise.resolve();

	private constructor(
		private readonly server: Server,
		private readonly port: number,
		dependencies: RemoteQuestionnaireServerDependencies,
		expiresAt: number | undefined,
		page: RemoteQuestionnairePage | undefined,
		private readonly presentation: { projectLabel?: string; sessionLabel?: string } | undefined,
	) {
		this.dependencies = dependencies;
		this.expiresAt = expiresAt;
		this.page = page;
		this.routeId = token(dependencies.randomBytes, ROUTE_BYTES);
		this.fragmentSecret = token(dependencies.randomBytes, TOKEN_BYTES);
		this.route = `/r/${this.routeId}`;
	}

	get url(): string {
		return `http://127.0.0.1:${this.port}${this.route}`;
	}

	get status(): RemoteQuestionnaireStatus {
		this.refreshExpiry();
		return this.statusValue;
	}

	static async create(
		options: Partial<RemoteQuestionnaireServerDependencies> & RemoteQuestionnaireServerOptions = {},
	): Promise<RemoteQuestionnaireServer> {
		const dependencies: RemoteQuestionnaireServerDependencies = {
			...defaultDependencies,
			...options,
			clock: options.clock ?? defaultDependencies.clock,
			randomBytes: options.randomBytes ?? defaultDependencies.randomBytes,
			createServer: options.createServer ?? defaultDependencies.createServer,
			onMutation: options.onMutation ?? defaultDependencies.onMutation,
		};
		let instance: RemoteQuestionnaireServer | undefined;
		const server = dependencies.createServer((request, response) => instance?.handle(request, response));
		configureServer(server);
		await listenLoopback(server);
		const address = server.address();
		if (!address || typeof address === "string" || address.address !== "127.0.0.1") {
			await closeServer(server);
			throw new Error("Remote questionnaire server did not bind 127.0.0.1");
		}
		instance = new RemoteQuestionnaireServer(
			server,
			address.port,
			dependencies,
			options.expiresAt,
			options.page,
			options.presentation,
		);
		instance.attachSocketGuards();
		return instance;
	}

	/** Replaces authoritative page state after a same-request reconnect rebind. */
	setPage(page: RemoteQuestionnairePage): void {
		if (this.statusValue === "active" || this.statusValue === "stale") this.page = page;
	}

	setPublicHostname(hostname: string): void {
		if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/u.test(hostname)) {
			throw new TypeError("Remote questionnaire public hostname must be an exact trycloudflare.com hostname");
		}
		this.publicHostname = hostname;
	}

	setStale(message?: string): void {
		if (this.status === "active") this.setStatus("stale", message);
	}

	setTerminal(message?: string): void {
		if (this.status !== "active" && this.status !== "stale") return;
		this.setStatus("terminal", message);
		void Promise.resolve()
			.then(() => this.dependencies.onTerminalEvent({ status: "terminal", message }))
			.catch(ignoreError);
	}

	async revoke(message?: string): Promise<void> {
		if (this.statusValue !== "expired") this.setStatus("revoked", message);
		await this.close();
	}

	/** Test-only state excluding secrets, sessions, and questionnaire data. */
	debugState(): {
		routeId: string;
		sessionCount: number;
		bootstrapConsumed: boolean;
		status: RemoteQuestionnaireStatus;
	} {
		return {
			routeId: this.routeId,
			sessionCount: this.sessions.size,
			bootstrapConsumed: this.bootstrapConsumed,
			status: this.status,
		};
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.sessions.clear();
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
		await closeServer(this.server);
	}

	private attachSocketGuards(): void {
		this.server.on("connection", (socket) => {
			if (this.sockets.size >= MAX_SOCKETS) {
				socket.destroy();
				return;
			}
			this.sockets.add(socket);
			socket.on("error", ignoreError);
			socket.on("close", () => this.sockets.delete(socket));
		});
	}

	private handle(request: IncomingMessage, response: ServerResponse): undefined {
		response.on("error", ignoreError);
		request.on("error", ignoreError);
		for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
		const socket = request.socket;
		const requestCount = (this.requestsPerSocket.get(socket) ?? 0) + 1;
		this.requestsPerSocket.set(socket, requestCount);
		if (!this.acceptsHost(request.headers.host)) return this.respond(response, 421);
		const authenticated = this.authenticate(request);
		if (requestCount > MAX_REQUESTS_PER_SOCKET && !authenticated) return this.respond(response, 429);
		const target = parseTarget(request.url);
		if (!target) return this.respond(response, 404);
		if (this.refreshExpiry()) {
			if (target.pathname === this.route && target.search === "") return this.terminalShell(response);
			return this.respondStatus(response, authenticated);
		}
		if (target.pathname === this.route && target.search === "") {
			if (request.method !== "GET") return this.methodNotAllowed(response, "GET");
			if (this.status !== "active" && this.status !== "stale") return this.terminalShell(response);
			return authenticated && this.page ? this.pageShell(response, authenticated) : this.shell(response);
		}
		if (target.pathname === `${this.route}/bootstrap` && target.search === "") {
			if (request.method !== "POST") return this.methodNotAllowed(response, "POST");
			return this.bootstrap(request, response);
		}
		if (target.pathname === `${this.route}/status` && target.search === "") {
			if (request.method !== "GET") return this.methodNotAllowed(response, "GET");
			return authenticated ? this.respondStatus(response, authenticated) : this.respond(response, 401);
		}
		if (target.pathname === `${this.route}/mutate` && target.search === "") {
			if (request.method !== "POST") return this.methodNotAllowed(response, "POST");
			return this.mutate(request, response);
		}
		return this.respond(response, 404);
	}

	private shell(response: ServerResponse): undefined {
		response.setHeader("content-type", "text/html; charset=utf-8");
		response.end(
			`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Questionnaire</title><noscript>This questionnaire requires JavaScript to establish its secure session.</noscript><script>${BOOTSTRAP_SCRIPT}</script>`,
		);
	}

	private pageShell(response: ServerResponse, session: Session, alert = ""): undefined {
		const page = this.page;
		const view = page?.view();
		if (!page || !view) return this.shell(response);
		response.setHeader("content-type", "text/html; charset=utf-8");
		if (this.statusValue === "stale") {
			response.end(this.stalePageShell(view.title, session.csrf));
			return undefined;
		}
		if (this.statusValue !== "active" || this.suspended) {
			response.end(this.terminalPageShell(view.title));
			return undefined;
		}
		const currentStep = view.currentStep;
		const questionIndex =
			currentStep.kind === "question"
				? view.questions.findIndex((question) => question.id === currentStep.questionId)
				: -1;
		const progress =
			questionIndex >= 0
				? `<p>Question ${questionIndex + 1} of ${view.questions.length}</p>`
				: `<p>Review ${view.questions.length} questions</p>`;
		const current =
			currentStep.kind === "review"
				? renderReview(page, session.csrf, this.route)
				: renderQuestion(
						view.questions.find((question) => question.id === currentStep.questionId),
						session.csrf,
						page,
						this.route,
					);
		response.end(
			`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(view.title ?? "Questionnaire")}</title><style>${PAGE_CSS}</style><main><header><p>Secure questionnaire</p><p>${[
				this.presentation?.projectLabel,
				this.presentation?.sessionLabel,
			]
				.filter((label): label is string => Boolean(label))
				.map(escapeHtml)
				.join(
					" · ",
				)}</p><h1>${escapeHtml(view.title ?? "Questionnaire")}</h1>${progress}</header>${alert}${current}${renderNoteForm(page, session.csrf, this.route)}<form method="post" action="${this.route}/mutate"><input type="hidden" name="csrf" value="${session.csrf}"><button name="action" value="previous">Previous</button><button name="action" value="next">Next</button><button name="action" value="review">Review</button>${view.currentStep.kind === "review" ? `<button name="action" value="submit">${escapeHtml(view.submitLabel)}</button>` : ""}</form></main><script>${STATUS_POLL_SCRIPT}</script>`,
		);
		return undefined;
	}

	private terminalShell(response: ServerResponse): undefined {
		response.setHeader("content-type", "text/html; charset=utf-8");
		response.end(this.terminalPageShell(this.page?.view().title));
		return undefined;
	}

	private stalePageShell(title: string | undefined, csrf: string): string {
		return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title ?? "Questionnaire")}</title><main><h1>${escapeHtml(title ?? "Questionnaire")}</h1><p role="alert">${escapeHtml(this.statusMessage ?? "The questionnaire changed.")}</p><form method="post" action="${this.route}/mutate"><input type="hidden" name="csrf" value="${csrf}"><button name="action" value="reload">Reload latest</button></form></main>`;
	}

	private terminalPageShell(title: string | undefined): string {
		const status = this.statusMessage ?? (this.statusValue === "terminal" ? "Answered elsewhere." : this.statusValue);
		return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title ?? "Questionnaire")}</title><main><h1>${escapeHtml(title ?? "Questionnaire")}</h1><p role="status">${escapeHtml(status)}</p></main>`;
	}

	private bootstrap(request: IncomingMessage, response: ServerResponse): undefined {
		if (!this.acceptsProvenance(request)) return this.respond(response, 403);
		if (request.headers["content-type"] !== "application/json") return this.respond(response, 415);
		void this.readJsonBody(request).then((body) => {
			if (!body.ok) return this.respond(response, body.status);
			const secret = readSecret(body.value);
			if (secret === undefined || this.bootstrapConsumed || !constantTimeTokenEquals(secret, this.fragmentSecret)) {
				return this.respond(response, 401);
			}
			this.bootstrapConsumed = true;
			const session: Session = {
				id: token(this.dependencies.randomBytes, TOKEN_BYTES),
				csrf: token(this.dependencies.randomBytes, TOKEN_BYTES),
			};
			this.sessions.set(session.id, session);
			response.setHeader("content-type", "application/json; charset=utf-8");
			response.setHeader(
				"set-cookie",
				`${SESSION_COOKIE}=${session.id}; HttpOnly; Secure; SameSite=Strict; Path=${this.route}`,
			);
			this.respond(response, 200, JSON.stringify({ csrf: session.csrf }));
		});
	}

	private mutate(request: IncomingMessage, response: ServerResponse): undefined {
		if (!this.acceptsProvenance(request)) return this.respond(response, 403);
		const contentType = request.headers["content-type"];
		const isForm = contentType === "application/x-www-form-urlencoded";
		if (contentType !== "application/json" && !isForm) return this.respond(response, 415);
		const session = this.authenticate(request);
		if (!session) return this.respond(response, 401);
		void this.readJsonBody(request).then(async (body) => {
			if (!body.ok) return this.respond(response, body.status);
			const csrf = request.headers["x-csrf-token"] ?? readCsrf(body.value);
			if (typeof csrf !== "string" || !constantTimeTokenEquals(csrf, session.csrf))
				return this.respond(response, 403);
			const action = parsePageAction(body.value);
			if (!action) {
				if (isForm && isIncompleteBrowserAnswer(body.value))
					return this.respondValidation(response, session, "Select an answer before saving.", true);
				return this.respond(response, 400);
			}
			if (
				action.action === "submit" &&
				(!this.page || this.page.model.currentStep.kind !== "review" || this.page.view().submitted)
			)
				return this.respondValidation(response, session, "Review the questionnaire before submitting.", isForm);
			if (isForm && isEmptyOtherAnswer(action))
				return this.respondValidation(response, session, "Enter an Other answer before saving.", true);
			if (
				(this.status !== "active" || this.suspended) &&
				!(this.statusValue === "stale" && action.action === "reload")
			)
				return this.respondMutationStatus(response, session, isForm);
			const prior = this.mutationTail;
			let release: (() => void) | undefined;
			this.mutationTail = new Promise<void>((resolve) => {
				release = resolve;
			});
			await prior;
			try {
				if (
					(this.status !== "active" || this.suspended) &&
					!(this.statusValue === "stale" && action.action === "reload")
				)
					return this.respondMutationStatus(response, session, isForm);
				const result = (await this.dependencies.onMutation({ sessionId: session.id, page: action })) ?? {
					kind: "accepted" as const,
				};
				if (result.kind === "suspended") return this.respondSuspended(result.message, response, session, isForm);
				if (result.kind === "stale") return this.setStaleResult(result.message, response, session, isForm);
				if (result.kind === "terminal") {
					this.setTerminal(result.message);
					return this.respondMutationStatus(response, session, isForm);
				}
				if (action.action === "reload") {
					this.setActive();
					return isForm ? this.redirectToPage(response) : this.respond(response, 204);
				}
				if (this.page) {
					try {
						if (action.action === "submit") this.page.submit();
						else {
							const mutation = this.page.apply(action);
							if (!mutation.accepted)
								return this.respondValidation(
									response,
									session,
									mutation.message ?? "Unable to save answer.",
									isForm,
								);
						}
					} catch {
						return this.respondValidation(response, session, "Unable to save answer.", isForm);
					}
				}
				return isForm ? this.redirectToPage(response) : this.respond(response, 204);
			} catch {
				return this.respond(response, 503);
			} finally {
				release?.();
			}
		});
	}

	private redirectToPage(response: ServerResponse): undefined {
		response.setHeader("location", this.route);
		response.setHeader("content-type", "text/html; charset=utf-8");
		return this.respond(
			response,
			303,
			'<!doctype html><html lang="en"><title>Continuing</title><p>Continuing…</p></html>',
		);
	}

	private respondValidation(response: ServerResponse, session: Session, message: string, isForm: boolean): undefined {
		if (!isForm) return this.respond(response, 422, JSON.stringify({ message }));
		response.statusCode = 422;
		response.setHeader("content-type", "text/html; charset=utf-8");
		return this.page
			? this.pageShell(response, session, `<p role="alert">${escapeHtml(message)}</p>`)
			: this.respond(response, 422);
	}

	private authenticate(request: IncomingMessage): Session | undefined {
		const sessionIds = parseCookies(request.headers.cookie, SESSION_COOKIE);
		let matched: Session | undefined;
		for (const sessionId of sessionIds) {
			for (const session of this.sessions.values()) {
				if (constantTimeTokenEquals(sessionId, session.id)) matched = session;
			}
		}
		return matched;
	}

	private acceptsHost(host: string | undefined): boolean {
		return host === `127.0.0.1:${this.port}` || (this.publicHostname !== undefined && host === this.publicHostname);
	}

	private acceptsProvenance(request: IncomingMessage): boolean {
		const origin = request.headers.origin;
		if (origin !== undefined && origin !== this.allowedOrigin(request.headers.host)) return false;
		const fetchSite = request.headers["sec-fetch-site"];
		return fetchSite === undefined || fetchSite === "same-origin";
	}

	private allowedOrigin(host: string | undefined): string | undefined {
		if (host === `127.0.0.1:${this.port}`) return `http://${host}`;
		if (this.publicHostname !== undefined && host === this.publicHostname) return `https://${host}`;
		return undefined;
	}

	private refreshExpiry(): boolean {
		if (
			this.statusValue === "active" &&
			this.expiresAt !== undefined &&
			this.dependencies.clock.now() >= this.expiresAt
		) {
			this.setStatus("expired");
		}
		return this.statusValue === "expired";
	}

	setActive(): void {
		if (this.statusValue === "active" || this.statusValue === "stale") {
			this.statusValue = "active";
			this.statusMessage = undefined;
			this.suspended = false;
		}
	}

	setSuspended(message?: string): void {
		if (this.statusValue === "active") {
			this.suspended = true;
			this.statusMessage = message;
		}
	}

	private respondSuspended(
		message: string | undefined,
		response: ServerResponse,
		session: Session,
		isForm: boolean,
	): undefined {
		this.setSuspended(message);
		return this.respondMutationStatus(response, session, isForm);
	}

	private setStaleResult(
		message: string | undefined,
		response: ServerResponse,
		session: Session,
		isForm: boolean,
	): undefined {
		this.setStale(message);
		return isForm ? this.pageShell(response, session) : this.respondStatus(response, session);
	}

	private setStatus(status: RemoteQuestionnaireStatus, message?: string): void {
		this.statusValue = status;
		this.statusMessage = message;
		if (status === "revoked") this.sessions.clear();
	}

	private respondMutationStatus(response: ServerResponse, session: Session, isForm: boolean): undefined {
		return isForm ? this.pageShell(response, session) : this.respondStatus(response, session);
	}

	private respondStatus(response: ServerResponse, _session: Session | undefined): undefined {
		response.setHeader("content-type", "application/json; charset=utf-8");
		this.respond(
			response,
			200,
			JSON.stringify({
				status: this.suspended ? "suspended" : this.statusValue,
				...(this.statusMessage ? { message: this.statusMessage } : {}),
			}),
		);
	}

	private methodNotAllowed(response: ServerResponse, allow: string): undefined {
		response.setHeader("allow", allow);
		this.respond(response, 405);
	}

	private respond(response: ServerResponse, status: number, body?: string): undefined {
		if (response.writableEnded || response.destroyed) return undefined;
		response.statusCode = status;
		response.end(body);
		return undefined;
	}

	private async readJsonBody(
		request: IncomingMessage,
	): Promise<{ ok: true; value: unknown } | { ok: false; status: number }> {
		const contentLength = request.headers["content-length"];
		if (
			typeof contentLength === "string" &&
			(!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)
		) {
			request.resume();
			return { ok: false, status: 413 };
		}
		return new Promise((resolve) => {
			const chunks: Buffer[] = [];
			let length = 0;
			let finished = false;
			const finish = (result: { ok: true; value: unknown } | { ok: false; status: number }) => {
				if (finished) return;
				finished = true;
				resolve(result);
			};
			request.on("data", (chunk: Buffer) => {
				length += chunk.byteLength;
				if (length > MAX_BODY_BYTES) {
					request.resume();
					finish({ ok: false, status: 413 });
				} else chunks.push(chunk);
			});
			request.on("aborted", () => finish({ ok: false, status: 400 }));
			request.on("error", () => finish({ ok: false, status: 400 }));
			request.on("end", () => {
				if (finished) return;
				try {
					const raw = Buffer.concat(chunks).toString("utf8");
					const value =
						request.headers["content-type"] === "application/x-www-form-urlencoded"
							? formBody(new URLSearchParams(raw))
							: (JSON.parse(raw) as unknown);
					finish({ ok: true, value });
				} catch {
					finish({ ok: false, status: 400 });
				}
			});
		});
	}
}

function configureServer(server: Server): void {
	server.maxHeadersCount = 64;
	server.requestTimeout = 30_000;
	server.headersTimeout = 10_000;
	server.keepAliveTimeout = 5_000;
	server.on("error", ignoreError);
}

function listenLoopback(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		const rejectOnce = (error: Error) => {
			server.off("error", rejectOnce);
			reject(error);
		};
		server.once("error", rejectOnce);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", rejectOnce);
			resolve();
		});
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

function formBody(params: URLSearchParams): Record<string, unknown> {
	const value: Record<string, unknown> = {};
	for (const [key, item] of params) {
		if (key !== "choiceIds") value[key] = key === "otherSelected" ? item === "true" : item;
	}
	const choiceIds = params.getAll("choiceIds");
	if (choiceIds.length > 0) value.choiceIds = choiceIds.filter((choiceId) => choiceId !== "");
	return value;
}

function parseTarget(rawUrl: string | undefined): URL | undefined {
	try {
		return new URL(rawUrl ?? "/", "http://127.0.0.1");
	} catch {
		return undefined;
	}
}

function parseCookies(header: string | undefined, name: string): string[] {
	if (!header) return [];
	return header.split(";").flatMap((part) => {
		const [key, ...value] = part.trim().split("=");
		return key === name ? [value.join("=")] : [];
	});
}

function readSecret(value: unknown): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	return Object.keys(record).length === 1 && typeof record.secret === "string" ? record.secret : undefined;
}

function token(randomBytes: RemoteQuestionnaireServerDependencies["randomBytes"], size: number): string {
	return randomBytes(size).toString("base64url");
}

function constantTimeTokenEquals(actual: string, expected: string): boolean {
	const expectedBytes = Buffer.from(expected, "base64url");
	const actualBytes = Buffer.from(actual, "base64url");
	const padded = Buffer.alloc(expectedBytes.byteLength);
	actualBytes.copy(padded, 0, 0, padded.byteLength);
	return (
		actualBytes.byteLength === expectedBytes.byteLength &&
		padded.toString("base64url") === actual &&
		timingSafeEqual(padded, expectedBytes)
	);
}

function createScriptHash(script: string): string {
	return createHash("sha256").update(script).digest("base64");
}

function ignoreError(): void {}

function renderNoteForm(page: RemoteQuestionnairePage | undefined, csrf: string, route: string): string {
	if (!page || page.model.request.version !== 2 || page.model.currentStep.kind === "review") return "";
	const questionId = page.model.currentStep.questionId;
	const note = page.model.getNote(questionId);
	return `<form method="post" action="${route}/mutate"><fieldset><legend>Note</legend><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="questionId" value="${escapeHtml(questionId)}"><label>Note<textarea name="text" rows="3">${escapeHtml(note)}</textarea></label><button name="action" value="update-note">Save note</button></fieldset></form>`;
}

function renderReview(page: RemoteQuestionnairePage, csrf: string, route: string): string {
	const view = page.view();
	const rows = view.questions
		.map((question, index) => {
			const response = view.responses[index]!;
			const state = page.model.getState(question.id);
			const value = response.status === "unanswered" ? "Unanswered" : formatResponse(response);
			const note = "note" in state && state.note ? `<p>Note: ${escapeHtml(state.note)}</p>` : "";
			return `<li><strong>${escapeHtml(question.label ?? question.prompt)}</strong><p>${escapeHtml(value)}</p>${note}<form method="post" action="${route}/mutate"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="questionId" value="${escapeHtml(question.id)}"><button name="action" value="edit">Edit</button></form></li>`;
		})
		.join("");
	return `<section aria-labelledby="review-title"><h2 id="review-title">Review</h2><ol>${rows}</ol></section>`;
}

function formatResponse(response: RemoteQuestionnairePageView["responses"][number]): string {
	if (response.status === "unanswered") return "Unanswered";
	if (response.kind === "confirm") {
		if ("value" in response) return response.value ? "Yes" : "No";
		return response.otherText;
	}
	if (response.kind === "single-select") {
		if ("choiceId" in response) return response.choiceId;
		return response.otherText;
	}
	if (response.kind === "multi-select")
		return [...response.choiceIds, ...(response.otherText ? [response.otherText] : [])].join(", ");
	return response.value;
}

function renderQuestion(
	question: RemoteQuestionnairePage["model"]["request"]["questions"][number] | undefined,
	csrf: string,
	page?: RemoteQuestionnairePage,
	route = "",
): string {
	if (!question) return "<p>Question unavailable.</p>";
	const field = `<input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="questionId" value="${escapeHtml(question.id)}">`;
	const context =
		"context" in question && question.context
			? `<section><h2>Context</h2><p>${inertRich(question.context)}</p></section>`
			: "";
	const recommendation =
		"recommendation" in question && question.recommendation
			? `<aside><strong>Recommendation${question.recommendation.choiceId ? `: ${escapeHtml(question.recommendation.choiceId)}` : ""}</strong><p>${inertRich(question.recommendation.rationale)}</p></aside>`
			: "";
	const prompt = `<legend>${escapeHtml(question.label ?? question.prompt)}</legend><p>${escapeHtml(question.prompt)}</p>${context}${recommendation}`;
	switch (question.kind) {
		case "confirm": {
			const state = page?.model.getState(question.id);
			const selected = state?.kind === "confirm" ? state : undefined;
			return `<form method="post" action="${route}/mutate"><fieldset>${prompt}${field}<label><input type="radio" name="selection" value="yes"${selected?.selection === "yes" ? " checked" : ""}>${escapeHtml(question.yesLabel ?? "Yes")}</label><label><input type="radio" name="selection" value="no"${selected?.selection === "no" ? " checked" : ""}>${escapeHtml(question.noLabel ?? "No")}</label>${question.other ? `<label><input type="radio" name="selection" value="other"${selected?.selection === "other" ? " checked" : ""}>${escapeHtml(question.other.label ?? "Other")}</label><label>Other<input name="text" value="${escapeHtml(selected?.otherText ?? "")}"></label>` : '<input type="hidden" name="text" value="">'}<button name="action" value="answer-confirm">Save answer</button></fieldset></form>`;
		}
		case "single-select": {
			const state = page?.model.getState(question.id);
			const selected = state?.kind === "single-select" ? state : undefined;
			return `<form method="post" action="${route}/mutate"><fieldset>${prompt}${field}${question.choices.map((choice) => renderChoice(choice, selected?.selection?.kind === "choice" && selected.selection.choiceId === choice.id)).join("")}${question.other ? `<label><input type="radio" name="choiceId" value=""${selected?.selection?.kind === "other" ? " checked" : ""}>${escapeHtml(question.other.label ?? "Other")}</label><label>Other<input name="text" value="${escapeHtml(selected?.otherText ?? "")}"></label>` : ""}<button name="action" value="answer-single">Save answer</button></fieldset></form>`;
		}
		case "multi-select": {
			const state = page?.model.getState(question.id);
			const selected = state?.kind === "multi-select" ? state : undefined;
			return `<form method="post" action="${route}/mutate"><fieldset>${prompt}${field}<input type="hidden" name="choiceIds" value="">${question.choices.map((choice) => `<label><input type="checkbox" name="choiceIds" value="${escapeHtml(choice.id)}"${selected?.choiceIds.includes(choice.id) ? " checked" : ""}>${escapeHtml(choice.label)}</label>`).join("")}<label><input type="checkbox" name="otherSelected" value="true"${selected?.otherSelected ? " checked" : ""}>Other</label><label>Other text<input name="otherText" value="${escapeHtml(selected?.otherText ?? "")}"></label><button name="action" value="set-multi">Save choices</button></fieldset></form>`;
		}
		case "short-text":
		case "multiline-text": {
			const state = page?.model.getState(question.id);
			const value = state?.kind === question.kind ? escapeHtml(state.value) : "";
			return `<form method="post" action="${route}/mutate"><fieldset>${prompt}${field}<label>Answer${question.kind === "multiline-text" ? `<textarea name="text" rows="5">${value}</textarea>` : `<input name="text" value="${value}">`}</label><button name="action" value="update-text">Save answer</button></fieldset></form>`;
		}
	}
}

function renderChoice(
	choice: {
		id: string;
		label: string;
		description?: string;
		detail?: string;
		preview?: { title?: string; markdown: string; alt: string };
	},
	checked = false,
): string {
	const description = choice.description ? `<p>${inertRich(choice.description)}</p>` : "";
	const detail = choice.detail ? `<p>${inertRich(choice.detail)}</p>` : "";
	const preview = choice.preview
		? `<section aria-label="${escapeHtml(choice.preview.alt)}"><strong>${escapeHtml(choice.preview.title ?? "Preview")}</strong><p>${inertRich(choice.preview.markdown)}</p><p>${escapeHtml(choice.preview.alt)}</p></section>`
		: "";
	return `<label><input type="radio" name="choiceId" value="${escapeHtml(choice.id)}"${checked ? " checked" : ""}>${escapeHtml(choice.label)}</label>${description}${detail}${preview}`;
}

function inertRich(value: string): string {
	return renderSafeQuestionnaireMarkdown(value);
}

function readCsrf(value: unknown): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const csrf = (value as Record<string, unknown>).csrf;
	return typeof csrf === "string" ? csrf : undefined;
}

function isEmptyOtherAnswer(action: RemoteQuestionnairePageAction): boolean {
	return (
		(action.action === "answer-confirm" && action.selection === "other" && !action.text?.trim()) ||
		(action.action === "answer-single" && action.selection.kind === "other" && !action.text?.trim())
	);
}

function isIncompleteBrowserAnswer(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).filter((key) => key !== "csrf");
	if (typeof record.questionId !== "string") return false;
	if (record.action === "answer-confirm")
		return record.selection === undefined && typeof record.text === "string" && keys.length === 3;
	return (
		record.action === "answer-single" &&
		record.choiceId === undefined &&
		(record.text === undefined || typeof record.text === "string") &&
		(keys.length === 2 || keys.length === 3)
	);
}

function parsePageAction(value: unknown): RemoteQuestionnairePageAction | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const { csrf: _csrf, ...actionRecord } = record;
	const action = actionRecord.action;
	const questionId = actionRecord.questionId;
	const text = actionRecord.text;
	if (action === "next" || action === "previous" || action === "review" || action === "submit" || action === "reload")
		return Object.keys(actionRecord).length === 1 ? { action } : undefined;
	if (typeof questionId !== "string") return undefined;
	if (action === "edit") return Object.keys(actionRecord).length === 2 ? { action, questionId } : undefined;
	if (
		action === "answer-confirm" &&
		(actionRecord.selection === "yes" || actionRecord.selection === "no" || actionRecord.selection === "other")
	)
		return actionRecord.selection === "other"
			? typeof text === "string"
				? { action, questionId, selection: actionRecord.selection, text }
				: undefined
			: text === undefined || typeof text === "string"
				? { action, questionId, selection: actionRecord.selection }
				: undefined;
	if (action === "answer-single") {
		if (typeof actionRecord.choiceId !== "string" || (text !== undefined && typeof text !== "string"))
			return undefined;
		return actionRecord.choiceId === ""
			? { action, questionId, selection: { kind: "other" }, ...(typeof text === "string" ? { text } : {}) }
			: { action, questionId, selection: { kind: "choice", choiceId: actionRecord.choiceId } };
	}
	if (
		action === "set-multi" &&
		Array.isArray(actionRecord.choiceIds) &&
		actionRecord.choiceIds.every((id) => typeof id === "string") &&
		(actionRecord.otherSelected === undefined || typeof actionRecord.otherSelected === "boolean") &&
		typeof actionRecord.otherText === "string"
	)
		return {
			action,
			questionId,
			choiceIds: actionRecord.choiceIds,
			otherSelected: actionRecord.otherSelected === true,
			otherText: actionRecord.otherText,
		};
	if (action === "toggle-multi" && typeof actionRecord.choiceId === "string")
		return { action, questionId, choiceId: actionRecord.choiceId };
	if ((action === "set-other" || action === "update-text" || action === "update-note") && typeof text === "string")
		return { action, questionId, text };
	return undefined;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

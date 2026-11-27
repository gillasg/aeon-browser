import { initialSession, paceOnChallenge, sessionRefresher } from "./client-helpers.js";
import { directWall, pageAfterWall } from "./page-retry.js";
import { originMatches } from "../filter.js";
import { breakingChanges, responseChanges } from "../diff.js";
import { extractEmbedded, hiddenInputs, inlineScriptTokens, metaTags } from "../infer/html.js";
import { getPointer } from "../infer/schema.js";
import { readOverrides, siteHome, siteName } from "../registry.js";
import { loadCurrentModel } from "../model-refresh.js";
import {
  readTransportPreferences,
  recordTransportPreference,
  type TransportNote,
} from "../transport-preference.js";
import type { Operation, PageEndpoint, SecurityScheme, SiteModel } from "../types.js";
import { BrowserNotConnected, type Bridge } from "./bridge.js";
import { finishRead, WriteThroughApi } from "./errors.js";
import { RateLimiter, retryDelay, shouldRetryRead, sleep } from "./limits.js";
import { isDnsFailure, isFetchFailure, isNetworkRefusal, isOk } from "./outcome.js";
import { buildRequest, type Params, type RuntimeRequest, type RuntimeResponse } from "./request.js";
import { fillMissingInputs } from "./resolve-missing.js";
import type { SessionFile } from "./session.js";
import { stopsRetry } from "./net-guard.js";
import { DirectTransport, PageTransport, type CallContext, type Transport } from "./transports.js";
import { chooseTransport, rememberedTransport } from "./transport-choice.js";
import { pageExtractExpression } from "./page-extract.js";
import { runAction, type ActionResult, type SiteAction } from "./actions.js";
import {
  channelStartExpression,
  channelStopExpression,
  type ChannelOptions,
  type ChannelResult,
} from "./channels.js";
import { docsExpression, docsTargets, type SiteDocs } from "./docs.js";
import { paginate, type PaginateOptions } from "./paginate.js";
import { applyPaceNotes, exportPaced, takePace } from "../pace.js";
import { readSiteFacts } from "../site-notes.js";
import { isRung0Paused } from "../circuit-breaker.js";
import { type BudgetKind, humanBudget } from "../human-budget.js";
export {
  BadRequest,
  Challenged,
  HttpError,
  SignedOut,
  WriteThroughApi,
  errorKind,
  type ErrorKind,
} from "./errors.js";

// The runtime: `const api = await siteMapper("shop.example")`, then `await api.searchProducts({ q })`
// or `for await (const item of api.paginate.searchProducts({ q }))`.

export interface SiteMapperOptions {
  /** auto (default): the page whenever a browser is connected, else direct. */
  transport?: "auto" | "page" | "direct";
  model?: SiteModel;
  session?: SessionFile | false;
  /** Requests per second and parallel calls for this site. Default 5 and 4. */
  rateLimit?: { perSecond?: number; concurrency?: number };
  retries?: number;
  bridge?: () => Promise<Bridge>;
  /**
   * Renews an exported session that expired or was refused, from the user's browser (default:
   * on whenever a session was exported). Calls then keep running without the browser.
   */
  refreshSession?: (() => Promise<SessionFile | undefined>) | false;
  /** Custom transports (for tests or other runtimes). */
  transports?: { page?: Transport; direct?: Transport };
  signers?: Record<string, string>;
  /** Saved multi-step actions (default: the site's overrides). */
  actions?: Record<string, SiteAction>;
  /** The signed-in account, for the per-(site, account) breaker and budget. Default "default". */
  account?: string;
}

const SESSION_FRESH_MS = 12 * 3600_000;
const REFRESH_EVERY_MS = 10 * 60_000;

export class SiteClient {
  readonly site: string;
  private readonly limiter: RateLimiter;
  private readonly page: Transport;
  private readonly direct: Transport;
  private readonly cache = new Map<string, { value: string; at: number }>();
  private refreshedAt = 0;
  private prefs?: Record<string, TransportNote>;

  constructor(
    readonly model: SiteModel,
    private readonly options: Omit<SiteMapperOptions, "session"> & { session?: SessionFile },
  ) {
    this.site = model.site;
    this.limiter = new RateLimiter(
      options.rateLimit?.perSecond ?? 5,
      options.rateLimit?.concurrency ?? 4,
    );
    this.page = options.transports?.page ?? new PageTransport(options.bridge);
    this.direct = options.transports?.direct ?? new DirectTransport(options.session);
  }

  get operations(): Operation[] {
    return this.model.operations;
  }

  operation(id: string): Operation {
    const operation = this.model.operations.find((op) => op.id === id);
    if (!operation)
      throw new Error(
        `${this.site} has no operation ${id}. Known: ${this.model.operations.map((op) => op.id).join(", ")}`,
      );
    return operation;
  }

  /** Where the site calls this operation from: its tab is opened there. */
  home(operation: { origin: string; pageUrls?: string[] }): string {
    const page = operation.pageUrls?.[0];
    if (page) return new URL(page).origin + "/";
    const main = this.model.origins.find((origin) => originMatches(new URL(origin), this.site));
    return main ? main + "/" : siteHome(this.site);
  }

  private schemes(operation: Operation): SecurityScheme[] {
    return this.model.security.filter((scheme) => operation.security.includes(scheme.name));
  }

  private chooseTransport(operation: Operation, request: RuntimeRequest): Promise<Transport> {
    return chooseTransport({
      mode: this.options.transport ?? "auto",
      page: this.page,
      direct: this.direct,
      pageHeaders: Boolean(request.pageHeaders?.length),
      paused: isRung0Paused(this.site, this.options.account),
      needsBrowser: () => this.needsBrowser(operation),
      preferred: () => this.preferredTransport(operation.id),
    });
  }

  /** True when only the browser can make the call: a signer, or auth with no fresh session. */
  private async needsBrowser(operation: Operation): Promise<boolean> {
    if (operation.signing || this.options.signers?.[operation.id]) return true;
    const schemes = this.schemes(operation);
    const needsBrowserState = schemes.some(
      (s) => s.type !== "apiKey" || (s.source && s.source.kind !== "constant"),
    );
    if (!needsBrowserState) return false;
    const session = this.options.session;
    if (session && Date.now() - Date.parse(session.savedAt) >= SESSION_FRESH_MS)
      await this.refreshSession();
    const fresh =
      this.options.session &&
      Date.now() - Date.parse(this.options.session.savedAt) < SESSION_FRESH_MS;
    return !fresh;
  }

  private async preferredTransport(id: string): Promise<TransportNote["transport"] | undefined> {
    this.prefs ??= await readTransportPreferences(this.site).catch(
      () => ({}) as Record<string, TransportNote>,
    );
    return this.prefs[id]?.transport;
  }

  private async rememberTransport(
    id: string,
    transport: TransportNote["transport"],
  ): Promise<void> {
    // The map is the source of truth in memory; an unchanged answer writes nothing. Only a move
    // to the page is remembered: stealth wins over the few milliseconds direct would save.
    if (!rememberedTransport(transport) || this.prefs?.[id]?.transport === transport) return;
    this.prefs = { ...(this.prefs ?? {}), [id]: { transport, at: new Date().toISOString() } };
    await recordTransportPreference(this.site, id, transport).catch(() => undefined);
  }

  /** Renews the exported session from the browser (at most every 10 minutes); true when renewed. */
  private async refreshSession(): Promise<boolean> {
    const refresh = this.options.refreshSession;
    if (!refresh || !this.options.session || Date.now() - this.refreshedAt < REFRESH_EVERY_MS)
      return false;
    this.refreshedAt = Date.now();
    const renewed = await refresh().catch(() => undefined);
    if (!renewed) return false;
    this.options.session = renewed;
    (this.direct as Partial<DirectTransport>).useSession?.(renewed);
    return true;
  }

  /** Auth values that come from another operation's response (a token endpoint). */
  private async responseAuth(
    operation: Operation,
    params: Params,
    depth: number,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    for (const scheme of this.schemes(operation)) {
      if (
        scheme.source?.kind !== "response" ||
        scheme.source.operationId === operation.id ||
        !scheme.key
      )
        continue;
      const value = await this.cached(`auth:${scheme.name}`, async () => {
        const source = scheme.source as { operationId: string; pointer: string };
        const response = await this.request(source.operationId, params, depth + 1);
        return String(getPointer(response.json, source.pointer.replace(/\*/g, "0")) ?? "");
      });
      if (!value) continue;
      if (scheme.type === "bearer") headers.authorization = `Bearer ${value}`;
      else if (scheme.in === "header") headers[scheme.key] = value;
    }
    return headers;
  }

  /** CSRF tokens kept in a page's meta tag, hidden input or inline script, for calls made outside the browser. */
  private async metaAuth(
    operation: Operation,
    transport: Transport,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    if (transport.name !== "direct") return headers;
    for (const scheme of this.schemes(operation)) {
      const source = scheme.source;
      if (!source || !scheme.key || scheme.in !== "header") continue;
      if (
        source.kind !== "meta" &&
        source.kind !== "hidden-input" &&
        source.kind !== "inline-script"
      )
        continue;
      const name = source.name;
      const read =
        source.kind === "meta"
          ? metaTags
          : source.kind === "hidden-input"
            ? hiddenInputs
            : inlineScriptTokens;
      const value = await this.cached(`${source.kind}:${name}`, async () => {
        const page = await transport.send(
          {
            operationId: "page",
            origin: operation.origin,
            method: "GET",
            url: this.home(operation),
            headers: { accept: "text/html" },
          },
          { auth: [], home: this.home(operation) },
        );
        return read(page.text ?? "")[name] ?? "";
      });
      if (value) headers[scheme.key] = value;
    }
    return headers;
  }

  private async cached(key: string, load: () => Promise<string>): Promise<string> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
    const value = await load();
    this.cache.set(key, { value, at: Date.now() });
    return value;
  }

  private context(operation: Operation): CallContext {
    const context: CallContext = { auth: this.schemes(operation), home: this.home(operation) };
    if (operation.signing) context.via = operation.signing.via;
    const signer = this.options.signers?.[operation.id];
    if (signer) context.signer = signer;
    return context;
  }

  private async send(
    transport: Transport,
    request: RuntimeRequest,
    context: CallContext,
    readOnly: boolean,
  ): Promise<RuntimeResponse> {
    // A write is sent once. A read can retry on a transient status.
    const retries = readOnly ? (this.options.retries ?? 3) : 0;
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.budgeted(readOnly ? "read" : "write", transport, () =>
          this.limiter.run(() => transport.send(request, context)),
        );
        if (this.wallToPage(transport, readOnly, response)) return response;
        if (!shouldRetryRead(readOnly, response, attempt, retries)) return response;
        await sleep(retryDelay(attempt, response.headers["retry-after"]));
      } catch (error) {
        if (stopsRetry(readOnly, error, attempt, retries)) throw error;
        await sleep(retryDelay(attempt));
      }
    }
  }

  /** I-4: on a site that tripped the breaker, calls queue inside the human volume budget. */
  private async budgeted<T>(kind: BudgetKind, transport: Transport, work: () => Promise<T>) {
    const account = this.options.account;
    if (!isRung0Paused(this.site, account)) return work();
    const run = () => humanBudget.run(this.site, { kind }, work, account);
    if (transport !== this.page) return run();
    return humanBudget.run(this.site, { kind: "lane" }, run, account);
  }

  private async prepare(
    operation: Operation,
    params: Params,
    depth: number,
  ): Promise<RuntimeRequest> {
    let built = buildRequest(operation, params);
    if (built.missing.length)
      built = buildRequest(
        operation,
        await fillMissingInputs(operation, params, built.missing, depth, this),
      );
    return built.request;
  }

  /** Sends; when the browser is gone and the mode allows it, falls back to a direct call. */
  private async sendWithFallback(
    transport: Transport,
    request: RuntimeRequest,
    context: CallContext,
    readOnly: boolean,
  ): Promise<{ response: RuntimeResponse; transport: Transport }> {
    try {
      const response = await this.send(transport, request, context, readOnly);
      if (!this.wallToPage(transport, readOnly, response)) return { response, transport };
      const paged = await pageAfterWall(response, this.page, () =>
        this.send(this.page, request, context, readOnly),
      );
      return paged ?? { response, transport };
    } catch (error) {
      const pageRetry = await this.retryPageFetch(transport, error, request, context, readOnly);
      if (pageRetry) return pageRetry;
      const directRetry = await this.retryDirectRefusal(
        transport,
        error,
        request,
        context,
        readOnly,
      );
      if (directRetry) return directRetry;
      return this.retryBrowserOffline(transport, error, request, context, readOnly);
    }
  }

  /** An extension in the page (an ad blocker wrapping fetch) made the request fail. */
  private async retryPageFetch(
    transport: Transport,
    error: unknown,
    request: RuntimeRequest,
    context: CallContext,
    readOnly: boolean,
  ): Promise<{ response: RuntimeResponse; transport: Transport } | undefined> {
    if (!readOnly || transport === this.direct || !isFetchFailure(error)) return undefined;
    const response = await this.send(this.direct, request, context, readOnly);
    response.notes = [
      ...(response.notes ?? []),
      "The page could not make this request (a fetch error, often an ad blocker), so it was retried directly.",
    ];
    return { response, transport: this.direct };
  }

  /** A direct call refused below HTTP (reset, TLS, timeout) may work in Chrome. */
  private async retryDirectRefusal(
    transport: Transport,
    error: unknown,
    request: RuntimeRequest,
    context: CallContext,
    readOnly: boolean,
  ): Promise<{ response: RuntimeResponse; transport: Transport } | undefined> {
    if (
      !readOnly ||
      transport !== this.direct ||
      (this.options.transport ?? "auto") !== "auto" ||
      !isNetworkRefusal(error) ||
      isDnsFailure(error)
    )
      return undefined;
    try {
      const response = await this.send(this.page, request, context, readOnly);
      response.notes = [
        ...(response.notes ?? []),
        "Plain HTTP was refused before an answer (reset/TLS), so the call went through the browser.",
      ];
      return { response, transport: this.page };
    } catch {
      return undefined;
    }
  }

  /** The browser is gone: a read may still work directly. */
  private async retryBrowserOffline(
    transport: Transport,
    error: unknown,
    request: RuntimeRequest,
    context: CallContext,
    readOnly: boolean,
  ): Promise<{ response: RuntimeResponse; transport: Transport }> {
    const canFallBack = readOnly && transport !== this.direct && this.options.transport !== "page";
    if (!(error instanceof BrowserNotConnected) || !canFallBack) throw error;
    return {
      response: await this.send(this.direct, request, context, readOnly),
      transport: this.direct,
    };
  }

  /** After a 401/403: retry in the page (auto mode), or renew a token and retry. Reads only. */
  private async retryAuth(
    operation: Operation,
    params: Params,
    depth: number,
    sent: { request: RuntimeRequest; context: CallContext; transport: Transport },
    readOnly: boolean,
  ): Promise<{ response: RuntimeResponse; transport: Transport } | undefined> {
    if (!readOnly) return undefined;
    this.clearAuthCache();
    const refreshed = await this.retryAfterRefresh(sent, readOnly);
    if (refreshed) return refreshed;
    if (this.options.transport === "direct") return undefined;
    if (this.canRetryInPage(sent))
      return {
        response: await this.send(this.page, sent.request, sent.context, readOnly),
        transport: this.page,
      };
    if (!this.schemes(operation).some((s) => s.refresh)) return undefined;
    Object.assign(sent.request.headers, await this.responseAuth(operation, params, depth));
    return {
      response: await this.send(sent.transport, sent.request, sent.context, readOnly),
      transport: sent.transport,
    };
  }

  private clearAuthCache(): void {
    for (const key of [...this.cache.keys()]) if (key.startsWith("auth:")) this.cache.delete(key);
  }

  private async retryAfterRefresh(
    sent: { request: RuntimeRequest; context: CallContext; transport: Transport },
    readOnly: boolean,
  ): Promise<{ response: RuntimeResponse; transport: Transport } | undefined> {
    if (sent.transport !== this.direct) return undefined;
    if (!(await this.refreshSession())) return undefined;
    const retried = await this.send(this.direct, sent.request, sent.context, readOnly);
    return retried.status !== 401 && retried.status !== 403
      ? { response: retried, transport: this.direct }
      : undefined;
  }

  /** A direct read walled by a 429 or challenge in auto mode: the page retries it, no backoff. */
  private wallToPage(transport: Transport, readOnly: boolean, response: RuntimeResponse): boolean {
    return readOnly && this.canRetryInPage({ transport }) && directWall(response);
  }

  private canRetryInPage(sent: { transport: Transport }): boolean {
    return sent.transport === this.direct && (this.options.transport ?? "auto") === "auto";
  }

  /** The full response (status, headers, body) for an operation. Reads only. */
  async request(id: string, params: Params = {}, depth = 0): Promise<RuntimeResponse> {
    const operation = this.operation(id);
    if (operation.role !== "read") throw new WriteThroughApi(id);
    return this.exchange(operation, params, depth, true);
  }

  /**
   * Sends a write (an operation that changes state) once, from the site's own tab, with no
   * retries. The runtime never decides on its own that a write may go through the API: callers
   * do (site-to-api's live learning allows a write only after the page has proven it).
   */
  async write(id: string, params: Params = {}): Promise<RuntimeResponse> {
    const operation = this.operation(id);
    if (operation.role === "auth") throw new WriteThroughApi(id);
    await takePace(this.site);
    const response = await this.exchange(operation, params, 0, false);
    paceOnChallenge(this.site, response, this.options.account);
    return response;
  }

  private async exchange(
    operation: Operation,
    params: Params,
    depth: number,
    readOnly: boolean,
  ): Promise<RuntimeResponse> {
    const request = await this.prepare(operation, params, depth);
    // Writes go out from the site's tab, as the page itself sent them (signing, cookies, origin).
    const chosen = readOnly ? await this.chooseTransport(operation, request) : this.page;
    Object.assign(
      request.headers,
      await this.responseAuth(operation, params, depth),
      await this.metaAuth(operation, chosen),
    );
    const context = this.context(operation);
    const first = await this.sendWithFallback(chosen, request, context, readOnly);
    const outcome = await this.settle(
      operation,
      params,
      depth,
      { request, context },
      first,
      readOnly,
    );
    if (readOnly) await this.recordOutcome(operation, chosen, outcome);
    return outcome.response;
  }

  /** Auth and drift retries, so the caller sees the answer that settled. */
  private async settle(
    operation: Operation,
    params: Params,
    depth: number,
    sent: { request: RuntimeRequest; context: CallContext },
    first: { response: RuntimeResponse; transport: Transport },
    readOnly: boolean,
  ): Promise<Outcome> {
    let response = first.response;
    let transport = first.transport;
    let drifted = false;
    if (readOnly && isOk(response)) {
      const changes = responseChanges(this.model, operation, response.json);
      drifted = breakingChanges(changes);
      const retried = await this.retryDrift(sent, first, changes, readOnly);
      if (retried) ({ response, transport } = retried);
    }
    let authRetried = false;
    if (response.status === 401 || response.status === 403) {
      const retried = await this.retryAuth(
        operation,
        params,
        depth,
        { ...sent, transport },
        readOnly,
      );
      if (retried) {
        ({ response, transport } = retried);
        authRetried = true;
      }
    }
    return { response, transport, drifted, authRetried };
  }

  /**
   * A direct read whose shape no longer matches the recorded one is retried once through the
   * page, which sees the site's current headers, cookies and signing. The page answer wins only
   * when it is a success: a page refusal is worse than the direct answer already in hand, so the
   * direct answer is kept (marked unverified) instead of becoming SignedOut.
   */
  private async retryDrift(
    sent: { request: RuntimeRequest; context: CallContext },
    first: { response: RuntimeResponse; transport: Transport },
    changes: string[],
    readOnly: boolean,
  ): Promise<{ response: RuntimeResponse; transport: Transport } | undefined> {
    if (
      !readOnly ||
      !breakingChanges(changes) ||
      first.transport !== this.direct ||
      (this.options.transport ?? "auto") !== "auto" ||
      !isOk(first.response)
    )
      return undefined;
    const note = `The direct answer did not match the recorded shape (${changes.slice(0, 3).join("; ")}).`;
    try {
      const response = await this.send(this.page, sent.request, sent.context, readOnly);
      if (!isOk(response)) {
        first.response.notes = [
          ...(first.response.notes ?? []),
          `${note} The browser retry answered ${response.status}, so the direct answer is kept, unverified.`,
        ];
        return undefined;
      }
      response.notes = [...(response.notes ?? []), `${note} The call was retried in the browser.`];
      return { response, transport: this.page };
    } catch {
      first.response.notes = [...(first.response.notes ?? []), `${note} The browser retry failed.`];
      return undefined;
    }
  }

  /**
   * Learns the transport that answered. A transport error, a skipped tier or an offline browser
   * leaves the preference alone; a success, a changed shape or a 401/403 moves it.
   */
  private async recordOutcome(
    operation: Operation,
    chosen: Transport,
    outcome: Outcome,
  ): Promise<void> {
    if ((this.options.transport ?? "auto") !== "auto") return;
    const { response, transport, drifted, authRetried } = outcome;
    if (response.status === 401 || response.status === 403) {
      await this.rememberTransport(operation.id, "page");
      return;
    }
    if (!isOk(response)) return;
    if (transport === chosen) {
      await this.rememberTransport(operation.id, transport.name);
      return;
    }
    if (drifted || authRetried) await this.rememberTransport(operation.id, transport.name);
  }

  /** The operation's data; throws HttpError on 4xx/5xx. */
  async call(id: string, params: Params = {}, options?: { pace?: boolean }): Promise<unknown> {
    // An export already took a token for this row. A second take would halve the printed rate.
    if (options?.pace !== false) await takePace(this.site);
    const response = await this.request(id, params);
    const wall = paceOnChallenge(this.site, response, this.options.account);
    return finishRead(id, response, wall, { operation: this.operation(id), params });
  }

  /** The site's saved multi-step actions (overrides.actions). */
  get actions(): Record<string, SiteAction> {
    return this.options.actions ?? {};
  }

  /** Runs a saved multi-step action: each step's result feeds the next (see actions.ts). */
  async action(name: string, inputs: Params = {}): Promise<ActionResult> {
    const action = this.actions[name];
    if (!action)
      throw new Error(
        `${this.site} has no action ${name}. Known: ${Object.keys(this.actions).join(", ") || "none"}`,
      );
    return runAction(this, action, inputs, name);
  }

  /** Talks to one of the site's live channels (WebSocket or event stream) from its page. */
  async channel(id: string, options: ChannelOptions = {}): Promise<ChannelResult> {
    const channel = this.model.channels.find((item) => item.id === id);
    if (!channel)
      throw new Error(
        `${this.site} has no channel ${id}. Known: ${this.model.channels.map((c) => c.id).join(", ") || "none"}`,
      );
    const transport = this.page as Partial<PageTransport>;
    if (!transport.inPage) throw new Error("Channels need the browser");
    const inPage = transport.inPage.bind(transport);
    const host = this.model.operations[0] ?? { origin: siteHome(this.site).replace(/\/$/, "") };
    const home = this.home(host);
    const key = `${id}-${Date.now()}`;
    await inPage(home, channelStartExpression(channel, key, options));
    await sleep(Math.min(Math.max(options.seconds ?? 10, 1), 120) * 1000);
    const result = (await inPage(home, channelStopExpression(key))) as Omit<
      ChannelResult,
      "channel" | "url"
    >;
    return { channel: id, url: channel.url, ...result };
  }

  /** The site's published API documents and GraphQL schemas, read from its page (see docs.ts). */
  async docs(): Promise<SiteDocs> {
    const transport = this.page as Partial<PageTransport>;
    if (!transport.inPage) throw new Error("Reading a site's API documents needs the browser");
    const host = this.model.operations[0] ?? { origin: siteHome(this.site).replace(/\/$/, "") };
    return (await transport.inPage.call(
      transport,
      this.home(host),
      docsExpression(docsTargets(this.model)),
    )) as SiteDocs;
  }

  paginate(id: string, params: Params = {}, options: PaginateOptions = {}): AsyncIterable<unknown> {
    return paginate(this, this.operation(id), params, options);
  }

  pageEndpoint(id: string): PageEndpoint | undefined {
    return this.model.pages.find((page) => page.id === id);
  }

  private pageUrl(page: PageEndpoint, params: Record<string, string>): string {
    let path = page.path;
    for (const param of page.params) {
      const value = params[param.name];
      if (value === undefined) throw new Error(`${page.id} needs ${param.name}`);
      path = path.replace(`{${param.name}}`, encodeURIComponent(value));
    }
    return page.origin + path;
  }

  /** A server-rendered page's data: its embedded state, or fields read with its CSS extractor. */
  async fetchPage(id: string, params: Record<string, string> = {}): Promise<unknown> {
    await takePace(this.site);
    const page = this.pageEndpoint(id);
    if (!page) throw new Error(`${this.site} has no page endpoint ${id}`);
    const url = this.pageUrl(page, params);
    const home = page.origin + "/";
    const inBrowser = page.extractor || (this.options.transport ?? "auto") !== "direct";
    const transport = this.page as Partial<PageTransport>;
    if (inBrowser && transport.inPage) {
      const inPage = transport.inPage.bind(transport);
      const result = await this.limiter.run(() =>
        inPage(home, pageExtractExpression(url, page.extractor)),
      );
      if (page.extractor) return result;
      return extractEmbedded(String((result as { html?: string } | null)?.html ?? ""));
    }
    const request = {
      operationId: id,
      origin: page.origin,
      method: "GET",
      url,
      headers: { accept: "text/html" },
    };
    const response = await this.limiter.run(() => this.direct.send(request, { auth: [], home }));
    paceOnChallenge(this.site, response, this.options.account);
    return extractEmbedded(response.text ?? "");
  }

  /** A paced export: one call per row, with the expected time printed by the caller. */
  exportRows<T>(
    rows: readonly unknown[],
    call: (row: unknown, index: number) => Promise<T>,
  ): Promise<{ rows: T[]; note: string; expectedMs: number }> {
    return exportPaced(this.site, rows, call);
  }
}

export type SiteMapper = SiteClient &
  Record<string, unknown> & {
    paginate: Record<
      string,
      (params?: Params, options?: PaginateOptions) => AsyncIterable<unknown>
    >;
  };

type Outcome = {
  response: RuntimeResponse;
  transport: Transport;
  drifted: boolean;
  authRetried: boolean;
};

/** Opens a mapped site from the registry (or a given model) as a callable API. */
export async function siteMapper(
  site: string,
  options: SiteMapperOptions = {},
): Promise<SiteMapper> {
  const model = options.model ?? (await loadCurrentModel(site));
  if (!model)
    throw new Error(
      `${siteName(site)} is not mapped yet. Record it first: browserkit map https://${siteName(site)}`,
    );
  const overrides = options.model ? {} : await readOverrides(site);
  if (!options.model)
    await readSiteFacts(site)
      .then((notes) => applyPaceNotes(siteName(site), notes))
      .catch(() => undefined);
  const session = await initialSession(model, options);
  const { session: _ignored, ...rest } = options;
  void _ignored;
  const refreshSession = sessionRefresher(model, options);
  const client = new SiteClient(model, {
    ...rest,
    ...(session ? { session } : {}),
    ...(refreshSession ? { refreshSession } : {}),
    signers: { ...(overrides.signers ?? {}), ...(options.signers ?? {}) },
    actions: { ...(overrides.actions ?? {}), ...(options.actions ?? {}) },
  });
  return callable(client);
}

/** Operations, page endpoints and actions as methods: api.searchProducts({ q }). */
function callable(client: SiteClient): SiteMapper {
  const pagers = new Proxy(
    (id: string, params?: Params, opts?: PaginateOptions) => client.paginate(id, params, opts),
    {
      get: (_, name: string) => (params?: Params, opts?: PaginateOptions) =>
        client.paginate(name, params, opts),
    },
  );
  return new Proxy(client, {
    get(target, name, receiver) {
      if (name === "paginate") return pagers;
      if (typeof name === "string" && !(name in target)) {
        if (target.model.operations.some((op) => op.id === name))
          return (params?: Params) => target.call(name, params);
        if (target.pageEndpoint(name))
          return (params?: Record<string, string>) => target.fetchPage(name, params);
        if (target.actions[name]) return (inputs?: Params) => target.action(name, inputs);
      }
      return Reflect.get(target, name, receiver);
    },
  }) as SiteMapper;
}

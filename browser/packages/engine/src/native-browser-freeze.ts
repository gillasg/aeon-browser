// page.freeze and page.dryRun: rehearse before committing.
// freeze.snapshot() keeps a point-in-time copy of the tab (where it is, its scroll, web storage,
// form values and the cookies its URL would send) in memory, and restore() puts it back. What
// it returns is a summary with counts: values and cookies never leave the engine.
// dryRun.start() turns on Fetch interception for this tab only while active: writes (POST, PUT,
// PATCH, DELETE by default) are answered by the browser with a synthetic response, or failed,
// and recorded as scrubbed receipts; everything else continues untouched. stop() turns Fetch off.
import {
  Ring,
  bytesBase64,
  clampLimit,
  evaluate,
  scrubPair,
  scrubText,
  scrubUrl,
  scrubValue,
  type ClawPort,
} from "./native-browser-claw-port.js";

type Params = Record<string, unknown>;
interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  session?: boolean;
  sameSite?: string;
}
interface FormValue {
  selector: string;
  value?: string;
  checked?: boolean;
}
interface PageState {
  url: string;
  origin: string;
  title: string;
  scrollX: number;
  scrollY: number;
  local: [string, string][];
  session: [string, string][];
  forms: FormValue[];
}
interface Snapshot extends PageState {
  id: string;
  label?: string;
  capturedAt: string;
  cookies: Cookie[];
}

// Runs in the page. Password, hidden and file inputs are never copied.
function readPageState(): PageState {
  const path = (el: Element): string => {
    if (el.id) return "#" + CSS.escape(el.id);
    const name = el.getAttribute("name");
    const form = el.closest("form");
    if (name) {
      const scope = form && form.id ? "#" + CSS.escape(form.id) + " " : "";
      const same = document.querySelectorAll(
        scope + el.tagName + '[name="' + CSS.escape(name) + '"]',
      );
      if (same.length === 1)
        return scope + el.tagName.toLowerCase() + '[name="' + CSS.escape(name) + '"]';
    }
    const parts: string[] = [];
    for (let node: Element | null = el; node && node !== document.body; node = node.parentElement) {
      const index = Array.prototype.indexOf.call(node.parentElement?.children ?? [], node) + 1;
      parts.unshift(node.tagName.toLowerCase() + ":nth-child(" + index + ")");
    }
    return "body > " + parts.join(" > ");
  };
  const entries = (store: Storage): [string, string][] => {
    const out: [string, string][] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key !== null) out.push([key, store.getItem(key) ?? ""]);
    }
    return out;
  };
  const forms: FormValue[] = [];
  for (const el of document.querySelectorAll("input, textarea, select")) {
    const input = el as HTMLInputElement;
    const type = (input.type || "").toLowerCase();
    if (["password", "hidden", "file", "submit", "button", "reset", "image"].includes(type))
      continue;
    if (
      /(pass|otp|cvv|cvc|card|secret|token)/i.test(
        input.name + " " + input.id + " " + input.autocomplete,
      )
    )
      continue;
    forms.push(
      type === "checkbox" || type === "radio"
        ? { selector: path(el), checked: input.checked }
        : { selector: path(el), value: input.value },
    );
  }
  return {
    url: location.href,
    origin: location.origin,
    title: document.title,
    scrollX: scrollX,
    scrollY: scrollY,
    local: entries(localStorage),
    session: entries(sessionStorage),
    forms,
  };
}

// Runs in the page: puts storage, form values and scroll back.
function writePageState(state: PageState): { restored: boolean; forms: number } {
  if (location.origin !== state.origin) return { restored: false, forms: 0 };
  const fill = (store: Storage, items: [string, string][]) => {
    store.clear();
    for (const [key, value] of items) store.setItem(key, value);
  };
  fill(localStorage, state.local);
  fill(sessionStorage, state.session);
  let forms = 0;
  for (const field of state.forms) {
    const el = document.querySelector(field.selector) as HTMLInputElement | null;
    if (!el) continue;
    if (field.checked !== undefined) el.checked = field.checked;
    else {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
      if (setter) setter.call(el, field.value ?? "");
      else el.value = field.value ?? "";
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    forms += 1;
  }
  scrollTo(state.scrollX, state.scrollY);
  return { restored: true, forms };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class SessionFreeze {
  private readonly snapshots = new Map<string, Snapshot>();
  private sequence = 0;
  constructor(
    private readonly port: ClawPort,
    private readonly max = 20,
  ) {}

  private summary(snap: Snapshot): Params {
    return {
      id: snap.id,
      ...(snap.label ? { label: snap.label } : {}),
      url: scrubUrl(snap.url),
      title: scrubText(snap.title),
      capturedAt: snap.capturedAt,
      scroll: { x: snap.scrollX, y: snap.scrollY },
      counts: {
        localStorage: snap.local.length,
        sessionStorage: snap.session.length,
        cookies: snap.cookies.length,
        forms: snap.forms.length,
      },
    };
  }

  async snapshot(label?: unknown): Promise<Params> {
    const state = await evaluate<PageState>(this.port, `(${readPageState.toString()})()`);
    if (!state || !/^https?:/.test(state.url))
      throw new Error("INVALID_TARGET: page.freeze needs an http(s) page");
    const reply = await this.port.send<{ cookies?: Cookie[] }>("Network.getCookies", {
      urls: [state.url],
    });
    this.sequence += 1;
    const snap: Snapshot = {
      ...state,
      id: `snap-${this.sequence}`,
      ...(typeof label === "string" && label ? { label: label.slice(0, 80) } : {}),
      capturedAt: new Date().toISOString(),
      cookies: reply.cookies ?? [],
    };
    this.snapshots.set(snap.id, snap);
    while (this.snapshots.size > this.max)
      this.snapshots.delete(this.snapshots.keys().next().value ?? "");
    return this.summary(snap);
  }

  async restore(id: unknown): Promise<Params> {
    const snap = this.snapshots.get(String(id));
    if (!snap) throw new Error(`TARGET_NOT_FOUND: no snapshot ${String(id)}; page.freeze.list()`);
    const cookies = await this.restoreCookies(snap);
    const here = await evaluate<string>(this.port, "location.href");
    if (here !== snap.url) await this.navigate(snap.url);
    const page = await evaluate<{ restored: boolean; forms: number }>(
      this.port,
      `(${writePageState.toString()})(${JSON.stringify(snap)})`,
    );
    if (!page?.restored) throw new Error("EXPECTATION_FAILED: the page left the snapshot's origin");
    return {
      ...this.summary(snap),
      restored: { cookies, forms: page.forms, navigated: here !== snap.url },
    };
  }

  private async restoreCookies(snap: Snapshot): Promise<number> {
    const now = await this.port.send<{ cookies?: Cookie[] }>("Network.getCookies", {
      urls: [snap.url],
    });
    const id = (c: Cookie) => `${c.name}\n${c.domain}\n${c.path}`;
    const keep = new Set(snap.cookies.map(id));
    for (const cookie of now.cookies ?? [])
      if (!keep.has(id(cookie)))
        await this.port.send("Network.deleteCookies", {
          name: cookie.name,
          domain: cookie.domain,
          path: cookie.path,
        });
    if (snap.cookies.length)
      await this.port.send("Network.setCookies", {
        cookies: snap.cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          ...(c.sameSite ? { sameSite: c.sameSite } : {}),
          ...(!c.session && c.expires && c.expires > 0 ? { expires: c.expires } : {}),
        })),
      });
    return snap.cookies.length;
  }

  private async navigate(url: string): Promise<void> {
    await this.port.send("Page.navigate", { url });
    for (let waited = 0; waited < 15000; waited += 100) {
      const ready = await evaluate<boolean>(
        this.port,
        `document.readyState === 'complete' && location.href === ${JSON.stringify(url)}`,
      ).catch(() => false);
      if (ready) return;
      await pause(100);
    }
    throw new Error("TIMEOUT: the snapshot's page did not load");
  }

  list(): Params[] {
    return [...this.snapshots.values()].map((snap) => this.summary(snap));
  }

  drop(id: unknown): { dropped: boolean } {
    return { dropped: this.snapshots.delete(String(id)) };
  }

  clear(): { cleared: number } {
    const cleared = this.snapshots.size;
    this.snapshots.clear();
    return { cleared };
  }
}

// ---------- Dry-Run Shield ----------
export interface DryRunReceipt {
  at: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  bodyPreview?: string;
  answered: "fulfilled" | "failed";
}
export interface DryRunOptions {
  methods?: string[];
  url?: string;
  mode?: "fulfill" | "fail";
  status?: number;
  body?: unknown;
  contentType?: string;
  max?: number;
}
const WRITES = ["POST", "PUT", "PATCH", "DELETE"];

function preview(body: unknown): string | undefined {
  if (typeof body !== "string" || !body) return undefined;
  try {
    return JSON.stringify(scrubValue(JSON.parse(body))).slice(0, 2000);
  } catch {
    const form = /^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(body)
      ? body.replace(
          /([^=&]+)=([^&]*)/g,
          (_m, k: string, v: string) => `${k}=${scrubPair(decodeURIComponent(k), v)}`,
        )
      : body;
    return scrubText(form).slice(0, 2000);
  }
}

export class DryRunShield {
  private options: (Required<Omit<DryRunOptions, "url">> & { url?: string }) | undefined;
  private off: (() => void) | undefined;
  private receipts = new Ring<DryRunReceipt>(100);
  private passed = 0;
  constructor(private readonly port: ClawPort) {}

  enabled(): string[] {
    return this.options ? ["Fetch"] : [];
  }

  async start(options: DryRunOptions = {}): Promise<Params> {
    const methods = (options.methods?.length ? options.methods : WRITES).map((m) =>
      String(m).toUpperCase(),
    );
    const fresh = !this.options;
    this.options = {
      methods,
      ...(typeof options.url === "string" && options.url ? { url: options.url } : {}),
      mode: options.mode === "fail" ? "fail" : "fulfill",
      status: clampLimit(options.status, 200, 599),
      body: options.body === undefined ? { dryRun: true } : options.body,
      contentType:
        typeof options.contentType === "string" ? options.contentType : "application/json",
      max: clampLimit(options.max, 100, 1000),
    };
    if (fresh) {
      this.receipts = new Ring(this.options.max);
      this.passed = 0;
      this.off = this.port.on((method, params) => {
        if (method === "Fetch.requestPaused") void this.paused(params);
      });
      try {
        await this.port.send("Fetch.enable", {
          patterns: [{ urlPattern: "*", requestStage: "Request" }],
        });
      } catch (error) {
        this.forget();
        throw error;
      }
    }
    return {
      active: true,
      methods,
      mode: this.options.mode,
      ...(this.options.url ? { url: this.options.url } : {}),
    };
  }

  private async paused(params: Params): Promise<void> {
    const requestId = String(params.requestId);
    const request = (params.request ?? {}) as {
      url?: string;
      method?: string;
      headers?: Record<string, string>;
      postData?: string;
    };
    const options = this.options;
    const method = String(request.method ?? "GET").toUpperCase();
    const url = String(request.url ?? "");
    const hit =
      options &&
      params.responseStatusCode === undefined &&
      options.methods.includes(method) &&
      (!options.url || url.includes(options.url));
    if (!options || !hit) {
      this.passed += 1;
      await this.port.send("Fetch.continueRequest", { requestId }).catch(() => undefined);
      return;
    }
    const bodyPreview = preview(request.postData);
    this.receipts.push({
      at: new Date().toISOString(),
      method,
      url: scrubUrl(url),
      headers: Object.fromEntries(
        Object.entries(request.headers ?? {}).map(([k, v]) => [k, scrubPair(k, String(v))]),
      ),
      ...(bodyPreview ? { bodyPreview } : {}),
      answered: options.mode === "fail" ? "failed" : "fulfilled",
    });
    if (options.mode === "fail") {
      await this.port
        .send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" })
        .catch(() => undefined);
      return;
    }
    const text = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    await this.port
      .send("Fetch.fulfillRequest", {
        requestId,
        responseCode: options.status,
        responseHeaders: [
          { name: "content-type", value: options.contentType },
          { name: "x-dry-run", value: "intercepted" },
        ],
        body: bytesBase64(new TextEncoder().encode(text)),
      })
      .catch(() => undefined);
  }

  list(options: Params = {}): Params {
    const receipts = this.receipts.list();
    if (options.clear === true) this.receipts.clear();
    return {
      active: !!this.options,
      receipts,
      passedThrough: this.passed,
      dropped: this.receipts.dropped,
    };
  }

  async stop(): Promise<Params> {
    if (!this.options) return { active: false, receipts: this.receipts.list() };
    this.forget();
    await this.port.send("Fetch.disable").catch(() => undefined);
    return { active: false, receipts: this.receipts.list(), passedThrough: this.passed };
  }

  detached(): void {
    this.forget();
  }

  private forget(): void {
    this.options = undefined;
    this.off?.();
    this.off = undefined;
  }
}

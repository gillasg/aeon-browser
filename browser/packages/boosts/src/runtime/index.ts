import { exposeGm, gmApis, type GmContext, type ScriptConfig } from "./gm.js";
import { Run, trackWorld, world } from "./lifecycle.js";
import { sbHelpers, type ValueStore } from "./sb.js";
import { Tracker } from "./tracker.js";
import {
  eventTransport,
  portTransport,
  startBridge,
  type PagePolicy,
  type Transport,
} from "./transport.js";

// The runtime every script gets, built into a self-contained string the service worker puts in
// front of each script's code. `start` returns the names the script sees as globals.

export type { ScriptConfig };

/** Names the wrapper declares for the script, whether or not they are granted. */
export const GLOBAL_NAMES = [
  "GM",
  "GM_info",
  "GM_getValue",
  "GM_setValue",
  "GM_deleteValue",
  "GM_listValues",
  "GM_getValues",
  "GM_setValues",
  "GM_deleteValues",
  "GM_addValueChangeListener",
  "GM_removeValueChangeListener",
  "GM_getResourceText",
  "GM_getResourceURL",
  "GM_registerMenuCommand",
  "GM_unregisterMenuCommand",
  "GM_getTab",
  "GM_saveTab",
  "GM_getTabs",
  "GM_openInTab",
  "GM_addStyle",
  "GM_addElement",
  "GM_log",
  "GM_notification",
  "GM_setClipboard",
  "GM_download",
  "GM_audio",
  "GM_cookie",
  "GM_xmlhttpRequest",
  "GM_onStop",
  "GM_liveView",
  "SB",
  "unsafeWindow",
];

const STRICT_DIRECTIVES = /^(style-src|script-src|require-trusted-types-for|trusted-types)/;

/** Strict CSP on this page: noted once, so saving a page-world boost here warns next time. */
function watchCsp(transport: Transport): void {
  let told = false;
  world().original.addEventListener.call(document, "securitypolicyviolation", (event) => {
    const directive = (event as SecurityPolicyViolationEvent).effectiveDirective;
    if (told || !STRICT_DIRECTIVES.test(directive)) return;
    told = true;
    void transport.call("csp", { directive }).catch(() => undefined);
  });
}

/**
 * Chrome raises no violation event for a user script's own refusals, so a page-world script
 * probes once: a detached innerHTML (Trusted Types) and a short-lived <style> (style-src).
 */
function probeCsp(transport: Transport): void {
  let directive = "";
  try {
    document.createElement("div").innerHTML = "";
  } catch {
    directive = "require-trusted-types-for";
  }
  if (!directive) {
    const style = document.createElement("style");
    (document.head ?? document.documentElement).appendChild(style);
    if (!style.sheet) directive = "style-src";
    style.remove();
  }
  if (directive) void transport.call("csp", { directive }).catch(() => undefined);
}

function errorOf(error: unknown): { message: string; stack?: string | undefined } {
  return error instanceof Error
    ? { message: `${error.name}: ${error.message}`, stack: error.stack }
    : { message: String(error) };
}

type Body = (...globals: unknown[]) => Promise<void>;

/** Starts and stops one script on this page as its rules and switches say. */
class Lifecycle {
  private run: Run | undefined;
  private body: Body | undefined;
  private dead = false;
  private last = location.href;

  constructor(
    private readonly context: GmContext & { globals: Record<string, unknown> },
    private readonly rule: (href: string) => boolean,
    private readonly isolated: boolean,
    private readonly urlEvents: boolean,
  ) {
    context.transport.onPush((event) => {
      if (event === "stop") this.halt(true);
    });
    world().original.setInterval(() => this.check(), 300);
    for (const type of ["popstate", "hashchange"])
      world().original.addEventListener.call(window, type, () => this.check());
  }

  current(): Run | undefined {
    return this.run;
  }

  start(body: Body): void {
    this.body = body;
    if (this.rule(location.href)) void this.begin();
  }

  private async begin(): Promise<void> {
    if (this.run || this.dead || !this.body) return;
    const run = new Run(this.context.report);
    this.run = run;
    // A fresh copy of the stored values: the registered snapshot is only for first paint.
    await this.context.refreshValues?.();
    if (run.stopped) return;
    if (this.isolated) world().active = run;
    void this.context.transport.call("started", { url: location.href }).catch(() => undefined);
    const globals = this.context.globals;
    try {
      await this.body.apply(
        window,
        GLOBAL_NAMES.map((name) => globals[name]),
      );
    } catch (error) {
      this.context.report(error);
    }
  }

  /** Stops this run; `final` when the boost was switched off or removed. */
  halt(final: boolean): void {
    if (final) this.dead = true;
    const run = this.run;
    if (!run) return;
    this.run = undefined;
    run.stop();
    if (world().active === run) world().active = undefined;
    void this.context.transport.call("stopped").catch(() => undefined);
  }

  private check(): void {
    if (location.href === this.last || this.dead) return;
    this.last = location.href;
    const wanted = this.rule(this.last);
    if (!wanted) return this.halt(false);
    if (!this.run) return void this.begin();
    if (this.urlEvents) dispatchUrlChange(this.last);
  }
}

function dispatchUrlChange(url: string): void {
  const event = Object.assign(new Event("urlchange"), { url });
  window.dispatchEvent(event);
  const handler = (window as unknown as { onurlchange?: unknown }).onurlchange;
  if (typeof handler === "function") (handler as (e: Event) => void)(event);
}

/** Uncaught errors from the script's own callbacks (its world only). */
function watchErrors(report: (error: unknown) => void): void {
  const add = world().original.addEventListener;
  add.call(window, "error", (event) =>
    report((event as ErrorEvent).error ?? (event as ErrorEvent).message),
  );
  add.call(window, "unhandledrejection", (event) =>
    report((event as PromiseRejectionEvent).reason),
  );
}

export function start(
  config: ScriptConfig,
  rule: (href: string) => boolean = () => true,
): Record<string, unknown> {
  const isolated = config.world !== "page";
  if (isolated) trackWorld();
  const transport =
    config.world === "page" ? eventTransport(config.nonce) : portTransport(`sb:${config.id}`);
  const name = String((config.info.script as { name?: string } | undefined)?.name ?? config.id);
  const tracker = new Tracker(transport);
  const report = (error: unknown): void => {
    console.error(`[Site Boosts] ${name}:`, error);
    const details = errorOf(error);
    tracker.error(details.message);
    void transport.call("error", details).catch(() => undefined);
  };
  const ref: { lifecycle?: Lifecycle } = {};
  const context: GmContext & { globals: Record<string, unknown> } = {
    config,
    transport,
    tracker,
    report,
    current: () => ref.lifecycle?.current(),
    globals: {},
  };
  const apis = gmApis(context);
  const globals = exposeGm(context, config.info, apis);
  globals.SB = sbHelpers(context, apis as unknown as ValueStore);
  globals.unsafeWindow = window;
  context.globals = globals;
  const urlEvents = config.grantAll || config.grants.includes("window.onurlchange");
  const lifecycle = new Lifecycle(context, rule, isolated, urlEvents);
  ref.lifecycle = lifecycle;
  if (isolated) watchErrors(report);
  watchCsp(transport);
  if (!isolated) probeCsp(transport);
  return {
    __report: report,
    __run: (body: Body) => lifecycle.start(body),
  };
}

/** The isolated-world half for page-world scripts, limited to what `policy` lets the page reach. */
export function bridge(nonce: string, id: string, policy: PagePolicy): void {
  startBridge(nonce, `sb:${id}`, policy);
}

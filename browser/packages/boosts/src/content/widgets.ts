import type { Widget } from "../shared/types.js";

// Boost widgets: small pills, badges and note cards inside a page, each in its own closed Shadow
// DOM so the page's styles and scripts cannot reach in and the widget's cannot leak out. Text is
// set as text, never parsed as HTML. Anchored widgets follow their element as the page changes;
// unmounting removes every host element, leaving nothing behind.

export const WIDGET_ATTRIBUTE = "data-site-boosts-widget";
const TAG = "site-boost-widget";

const STYLE = `:host{all:initial;display:inline-block;z-index:2147483646}
.w{font:500 12px/1.3 system-ui,sans-serif;color:#1d1d1f;background:#f5f5f7;border:1px solid #d2d2d7;
border-radius:999px;padding:3px 10px;margin:2px;box-shadow:0 1px 2px rgba(0,0,0,.08)}
.pill{cursor:pointer}.badge{border-radius:6px;font-variant-numeric:tabular-nums}
.note{display:block;border-radius:10px;padding:8px 12px;max-width:280px;white-space:pre-wrap}`;

const CORNERS: Record<NonNullable<Widget["corner"]>, string> = {
  "top-left": "top:12px;left:12px",
  "top-right": "top:12px;right:12px",
  "bottom-left": "bottom:12px;left:12px",
  "bottom-right": "bottom:12px;right:12px",
};

function safeAll(doc: Document, selector: string): Element[] {
  try {
    return [...doc.querySelectorAll(selector)];
  } catch {
    return [];
  }
}

function runAction(doc: Document, action: Widget["action"]): void {
  if (!action) return;
  if (action.do === "click") (safeAll(doc, action.selector)[0] as HTMLElement | undefined)?.click();
  else if (action.do === "copy")
    void navigator.clipboard?.writeText(action.text).catch(() => undefined);
  else if (/^https?:\/\//i.test(action.url)) window.open(action.url, "_blank", "noopener");
}

const label = (doc: Document, widget: Widget): string =>
  widget.kind === "badge" && widget.count
    ? `${widget.text} ${safeAll(doc, widget.count).length}`.trim()
    : widget.text;

interface Mounted {
  host: HTMLElement;
  body: HTMLElement;
  widget: Widget;
}

function build(doc: Document, boostId: string, widget: Widget): Mounted {
  const host = doc.createElement(TAG);
  host.setAttribute(WIDGET_ATTRIBUTE, boostId);
  const root = host.attachShadow({ mode: "closed" });
  const style = doc.createElement("style");
  style.textContent = STYLE;
  const body = doc.createElement(widget.kind === "pill" ? "button" : "div");
  body.className = `w ${widget.kind}`;
  body.textContent = label(doc, widget);
  if (widget.kind === "pill")
    body.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      runAction(doc, widget.action);
    });
  root.append(style, body);
  return { host, body, widget };
}

function place(doc: Document, mounted: Mounted, anchor: Element | undefined): void {
  const { host, widget } = mounted;
  if (!anchor) {
    host.style.cssText = `position:fixed;${CORNERS[widget.corner ?? "bottom-right"]}`;
    (doc.body ?? doc.documentElement).append(host);
    return;
  }
  const position = widget.position ?? "after";
  if (position === "before") anchor.before(host);
  else if (position === "prepend") anchor.prepend(host);
  else if (position === "append") anchor.append(host);
  else anchor.after(host);
}

/** One boost's widgets in one document. */
export class Widgets {
  private mounted: Mounted[] = [];
  private anchored = new Map<number, WeakSet<Element>>();

  constructor(
    private doc: Document,
    private boostId: string,
    private widgets: Widget[],
  ) {}

  /** Mounts what is missing (new anchors, re-rendered pages) and refreshes live counts. */
  update(): void {
    this.widgets.forEach((widget, index) => {
      if (!widget.selector) return this.mountCorner(widget, index);
      const seen = this.anchored.get(index) ?? new WeakSet<Element>();
      this.anchored.set(index, seen);
      for (const anchor of safeAll(this.doc, widget.selector)) {
        if (seen.has(anchor)) continue;
        seen.add(anchor);
        this.mount(widget, anchor);
      }
    });
    this.mounted = this.mounted.filter((m) => m.host.isConnected);
    for (const m of this.mounted) {
      const text = label(this.doc, m.widget);
      if (m.body.textContent !== text) m.body.textContent = text;
    }
  }

  private mountCorner(widget: Widget, index: number): void {
    if (this.mounted.some((m) => m.widget === widget && m.host.isConnected)) return;
    this.anchored.delete(index);
    this.mount(widget, undefined);
  }

  private mount(widget: Widget, anchor: Element | undefined): void {
    const mounted = build(this.doc, this.boostId, widget);
    place(this.doc, mounted, anchor);
    this.mounted.push(mounted);
  }

  count(): number {
    return this.mounted.filter((m) => m.host.isConnected).length;
  }

  /** Removes every widget of this boost, including copies a page cloned. */
  unmount(): void {
    for (const m of this.mounted) m.host.remove();
    for (const el of safeAll(this.doc, `${TAG}[${WIDGET_ATTRIBUTE}]`))
      if (el.getAttribute(WIDGET_ATTRIBUTE) === this.boostId) el.remove();
    this.mounted = [];
    this.anchored.clear();
  }
}

// Boost CSS (styles and zaps) inside open shadow roots: page styles never cross a shadow
// boundary, so each open root gets the boost's sheet through adoptedStyleSheets, including roots
// that appear later (new elements, custom elements upgraded after they were inserted).

const RESCAN_MS = [300, 1500, 5000];

export class ShadowStyles {
  private readonly sheet: CSSStyleSheet | undefined;
  private readonly roots = new Set<ShadowRoot>();
  private readonly observers: MutationObserver[] = [];
  private readonly timers: ReturnType<typeof setTimeout>[] = [];

  constructor(css: string) {
    try {
      this.sheet = new CSSStyleSheet();
      this.sheet.replaceSync(css);
    } catch {
      this.sheet = undefined;
    }
  }

  start(): void {
    if (!this.sheet) return;
    this.watch(document);
    this.scan(document.documentElement);
    for (const ms of RESCAN_MS)
      this.timers.push(setTimeout(() => this.scan(document.documentElement), ms));
    addEventListener("load", () => this.scan(document.documentElement), { once: true });
  }

  /** Every open root under `node`, and the roots inside those. */
  scan(node: Node | null): void {
    if (!node || !this.sheet) return;
    const elements = node instanceof Element ? [node, ...node.querySelectorAll("*")] : [];
    for (const element of elements) {
      const root = element.shadowRoot;
      if (!root || this.roots.has(root)) continue;
      this.adopt(root);
      for (const child of root.children) this.scan(child);
    }
  }

  private adopt(root: ShadowRoot): void {
    if (!this.sheet) return;
    this.roots.add(root);
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, this.sheet];
    this.watch(root);
  }

  private watch(target: Document | ShadowRoot): void {
    const observer = new MutationObserver((records) => {
      for (const record of records)
        for (const added of record.addedNodes) if (added instanceof Element) this.scan(added);
    });
    observer.observe(target, { childList: true, subtree: true });
    this.observers.push(observer);
  }

  stop(): void {
    for (const observer of this.observers.splice(0)) observer.disconnect();
    for (const timer of this.timers.splice(0)) clearTimeout(timer);
    for (const root of this.roots)
      root.adoptedStyleSheets = root.adoptedStyleSheets.filter((sheet) => sheet !== this.sheet);
    this.roots.clear();
  }
}

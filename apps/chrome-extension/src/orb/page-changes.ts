// "Changed since you last looked": on a page Aeon has read before, a small pill says what is
// different ("2 changes since Tue") and the changed parts get a thin outline; hovering one shows
// what it was. Pages Aeon never read show nothing and are never stored. Seeing the page moves
// the baseline on, so the next visit compares against this one.

interface SavedRead {
  url: string;
  at: string;
  lines: string[];
}

const NEEDS = "#c9a46a";
const MAX_OUTLINES = 30;
const marked: { element: HTMLElement; outline: string; offset: string; title: string }[] = [];
let pill: HTMLElement | undefined;
let checkedUrl = "";

export function watchPageChanges(): void {
  globalThis.setTimeout(() => void check(), 2500);
  // Single-page sites change the address without a load.
  globalThis.setInterval(() => {
    if (location.href !== checkedUrl) void check();
  }, 2000);
}

/** A page address without its fragment, as saved reads are keyed. */
export function pageKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return url;
  }
}

/** The same text the agent's read saved: the main content's visible text. */
function pageText(): string {
  const root = document.querySelector<HTMLElement>("main, [role=main]") ?? document.body;
  return root?.innerText ?? "";
}

/** As core's readLines: trimmed, spaces collapsed, no blanks. */
export function textLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 1)
    .map((line) => line.slice(0, 300));
}

// Clock-like lines change on every visit and say nothing.
const NOISE =
  /^(\d+|now|just now|\d+\s*(s|m|h|d|sec|min|mins|hours?|days?)( ago)?|yesterday|today)$/i;

export function lineChanges(
  before: readonly string[],
  now: readonly string[],
): { added: string[]; removed: string[] } {
  const had = new Set(before);
  const has = new Set(now);
  const meaningful = (line: string) => line.length >= 4 && !NOISE.test(line);
  return {
    added: now.filter((line) => !had.has(line) && meaningful(line)),
    removed: before.filter((line) => !has.has(line) && meaningful(line)),
  };
}

/** The removed line most like an added one: what that part said before. */
export function previousOf(line: string, removed: readonly string[]): string | undefined {
  const pairs = (text: string) => {
    const set = new Set<string>();
    const lower = text.toLowerCase();
    for (let index = 0; index < lower.length - 1; index++) set.add(lower.slice(index, index + 2));
    return set;
  };
  const target = pairs(line);
  let best: { line: string; score: number } | undefined;
  for (const candidate of removed) {
    const other = pairs(candidate);
    let shared = 0;
    for (const pair of target) if (other.has(pair)) shared++;
    const score = (2 * shared) / (target.size + other.size || 1);
    if (score > 0.5 && (!best || score > best.score)) best = { line: candidate, score };
  }
  return best?.line;
}

async function check(): Promise<void> {
  const url = pageKey(location.href);
  checkedUrl = location.href;
  clear();
  const saved = (await chrome.runtime
    .sendMessage({ kind: "aeon.page.saved", url })
    .catch(() => null)) as SavedRead | null;
  if (!saved?.lines?.length || location.href !== url) return;
  const text = pageText();
  const { added, removed } = lineChanges(saved.lines, textLines(text));
  void chrome.runtime.sendMessage({ kind: "aeon.page.seen", url, text }).catch(() => undefined);
  if (!added.length && !removed.length) return;
  const many = added.length > MAX_OUTLINES;
  if (!many) outline(added, removed);
  showPill(added.length || removed.length, saved.at, many);
}

function outline(added: readonly string[], removed: readonly string[]): void {
  const wanted = new Set(added);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set<HTMLElement>();
  for (
    let node = walker.nextNode();
    node && marked.length < MAX_OUTLINES;
    node = walker.nextNode()
  ) {
    const element = node.parentElement;
    if (!element || seen.has(element)) continue;
    seen.add(element);
    const line = element.innerText?.replace(/\s+/g, " ").trim();
    if (!line || !wanted.has(line)) continue;
    wanted.delete(line);
    const was = previousOf(line, removed);
    marked.push({
      element,
      outline: element.style.outline,
      offset: element.style.outlineOffset,
      title: element.title,
    });
    element.style.outline = `1.5px solid ${NEEDS}`;
    element.style.outlineOffset = "2px";
    element.title = was ? `Before: ${was}\nNow: ${line}` : `New since you last looked: ${line}`;
  }
}

function clear(): void {
  for (const item of marked.splice(0)) {
    item.element.style.outline = item.outline;
    item.element.style.outlineOffset = item.offset;
    item.element.title = item.title;
  }
  pill?.remove();
  pill = undefined;
}

function since(at: string): string {
  const date = new Date(at);
  const days = (Date.now() - date.getTime()) / 86_400_000;
  if (days < 1 && date.getDate() === new Date().getDate())
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days < 7) return date.toLocaleDateString([], { weekday: "short" });
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function showPill(count: number, at: string, many: boolean): void {
  const host = document.createElement("div");
  host.setAttribute("data-aeon-overlay", "");
  const root = host.attachShadow({ mode: "closed" });
  const label = many
    ? `Changed a lot since ${since(at)}`
    : `${count} change${count === 1 ? "" : "s"} since ${since(at)}`;
  root.innerHTML = `<style>
    .pill{position:fixed;left:16px;bottom:16px;z-index:2147483645;display:flex;gap:8px;align-items:center;
      padding:6px 8px 6px 12px;border-radius:999px;background:#111014;color:#e4e2ee;
      font:500 12px/1.2 system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.35);border:1px solid ${NEEDS}55}
    .dot{width:7px;height:7px;border-radius:50%;background:${NEEDS}}
    button{border:none;background:rgba(255,255,255,.08);color:inherit;font:inherit;border-radius:999px;padding:2px 8px;cursor:pointer}
  </style><div class="pill" role="status"><span class="dot"></span><span></span>${many ? "" : '<button data-toggle type="button">Hide</button>'}<button data-close type="button" aria-label="Dismiss">✕</button></div>`;
  (root.querySelector(".pill span:nth-child(2)") as HTMLElement).textContent = label;
  root.querySelector("[data-close]")?.addEventListener("click", clear);
  const toggle = root.querySelector<HTMLButtonElement>("[data-toggle]");
  toggle?.addEventListener("click", () => {
    const hidden = toggle.textContent === "Show";
    for (const item of marked)
      item.element.style.outline = hidden ? `1.5px solid ${NEEDS}` : item.outline;
    toggle.textContent = hidden ? "Hide" : "Show";
  });
  document.documentElement.append(host);
  pill = host;
}

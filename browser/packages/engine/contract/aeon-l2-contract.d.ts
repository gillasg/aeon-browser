// The always-visible L2 grammar inside browser_code. Everything else: help(topic).
// Laws: (1) a Playwright name carries Playwright semantics; different semantics get a different name.
// (2) success returns a structured result or Receipt; failure throws AeonError from the closed set.
// (3) secrets cross the realm only as Sealed handles.
type Ref = `t${number}:e${number}`; // printed by page.state(); valid only on its own tab (else WRONG_TAB)
type Target = Ref | string | Locator; // ref | CSS/text selector | Playwright locator
interface Changed {
  url?: string; newTab?: Page; download?: Download; dialog?: string;
  dom: "none" | "local" | "page"; // 'page' => read page.state() again
  diff?: string;
}
interface Receipt { did: string; changed: Changed; ms: number }
interface AeonError extends Error { // code and owner from protocol/src/errors.ts
  code: string; owner: "model" | "page" | "user" | "ours"; hint: string;
}
interface Sealed<K extends "session" | "cookie" | "bearer" | "csrf" = "session" | "cookie" | "bearer" | "csrf"> {
  readonly kind: K; readonly scope: string; readonly label: string; // String()/JSON yield only label
}
interface Download { path: string; name: string; bytes: number }
interface List { name: string; rows: Record<string, string>[]; complete: boolean }
interface NetEntry { id: string; method: string; url: string; status?: number; headers: Record<string, string | Sealed> }
interface Locator { // Playwright, verbatim subset
  click(o?: { button?: "left" | "right"; clickCount?: number }): Promise<Receipt>;
  fill(value: string | Sealed): Promise<Receipt>; press(key: string): Promise<Receipt>;
  check(): Promise<Receipt>; hover(): Promise<Receipt>; selectOption(v: string | string[]): Promise<Receipt>;
  setInputFiles(paths: string | string[]): Promise<Receipt>; textContent(): Promise<string | null>;
  isVisible(): Promise<boolean>; count(): Promise<number>; nth(i: number): Locator; first(): Locator;
}
interface Page { // Playwright, verbatim, down to screenshot()
  readonly ref: `t${number}`; url(): string; title(): Promise<string>;
  goto(url: string, o?: { waitUntil?: "load" | "domcontentloaded" | "networkidle" }): Promise<Receipt>;
  goBack(): Promise<Receipt>; goForward(): Promise<Receipt>; reload(): Promise<Receipt>;
  locator(selector: string): Locator; getByText(t: string | RegExp): Locator;
  getByRole(role: string, o?: { name?: string | RegExp; exact?: boolean }): Locator;
  getByLabel(t: string | RegExp): Locator; getByPlaceholder(t: string | RegExp): Locator;
  click(t: Target): Promise<Receipt>; fill(t: Target, v: string | Sealed): Promise<Receipt>;
  press(t: Target, key: string): Promise<Receipt>; selectOption(t: Target, v: string): Promise<Receipt>;
  keyboard: { type(text: string): Promise<Receipt>; press(key: string): Promise<Receipt> };
  waitForURL(u: string | RegExp, o?: { timeout?: number }): Promise<void>;
  waitForLoadState(s?: "load" | "domcontentloaded" | "networkidle"): Promise<void>;
  waitForResponse(u: string | RegExp): Promise<{ status: number; json(): Promise<unknown> }>;
  waitForEvent(e: "download" | "popup"): Promise<Download | Page>;
  evaluate<R, A = undefined>(fn: (arg: A) => R, arg?: A): Promise<R>; // the page's own world
  screenshot(o?: { fullPage?: boolean; path?: string }): Promise<string>;
  state(o?: { query?: string; frames?: boolean }): Promise<string>; // Aeon from here: numbered view
  read(): Promise<{ url: string; title: string; text: string; markdown: string; lists: List[] }>;
  extract<T>(schema: object, o?: { instruction?: string }): Promise<T>;
  act(step: string): Promise<Receipt>; // one step in plain words
  waitFor(c: { text: string | RegExp } | { gone: Target } | { change: Target | "page" }, o?: { timeout?: number }): Promise<void>;
  tap: Taps; // live streams, one shape
  wire(rules: WireRule[]): Promise<{ undo(): Promise<void> }>; // declarative, runs in Chrome; not page.route
  upload(t: Target, paths: string[]): Promise<Receipt>; download(t: Target): Promise<Download>;
  session(): Promise<Sealed<"session">>;
  tokens(): Promise<{ csrf: Sealed<"csrf">[]; bearer?: Sealed<"bearer">; persistedQueries: string[] }>;
  close(): Promise<void>;
}
interface Tap<M> extends AsyncIterable<M> { // every kind has these four members
  waitFor(pred: (m: M) => boolean, o?: { timeout?: number }): Promise<M>;
  list(o?: { last?: number }): M[]; stop(): Promise<void>; meta: Record<string, unknown>;
}
type Frame = { url: string; dir: "in" | "out"; data: unknown };
interface Taps {
  (kind: "network", o?: { match?: string | RegExp; ring?: number }): Promise<Tap<NetEntry>>;
  (kind: "ws" | "sse" | "webrtc", o?: { match?: string | RegExp }): Promise<Tap<Frame>>;
  (kind: "notifications", o?: { match?: string | RegExp }): Promise<Tap<{ title: string; body: string }>>;
  (kind: "console" | "dialogs"): Promise<Tap<{ level: string; text: string }>>;
  (kind: "downloads"): Promise<Tap<Download>>;
  (kind: "db" | "storage", o?: { store?: string }): Promise<Tap<{ key: string; value: unknown }>>;
}
type WireRule = ({ match: string } & ({ abort: true } | { headers: Record<string, string | null> }
  | { fulfill: { status?: number; json?: unknown; body?: string } })) | { turbo: true };
declare const site: { // compiled site APIs: zero-model on repeat
  ops(host: string): Promise<{ id: string; what: string; writes?: true }[]>;
  call<T = unknown>(host: string, op: string, params?: object): Promise<T>;
  watch<T = unknown>(host: string, op: string, params?: object): Promise<T[]>; // only new/changed
  write(host: string, op: string, params: object): Promise<Receipt>;
  run<T = unknown>(ability: string, inputs?: object): Promise<T>;
};
declare const human: { // the user, when only a person can do the step
  handoff(why: string, o?: { page?: Page; kind?: "cliff-edge" | "auth" | "captcha" | "question";
    target?: Target; actionLabel?: string; options?: string[]; input?: string }): Promise<"done" | string>;
  signIn(o?: { page?: Page; account?: string }): Promise<{ signedIn: boolean; reason?: string }>;
  fillProfile(o?: { page?: Page }): Promise<Receipt>; fillCode(o?: { page?: Page }): Promise<Receipt>;
};
declare const browser: {
  activeTab(): Promise<Page>; openTab(url: string, o?: { background?: boolean }): Promise<Page>;
  tabs(): Promise<{ ref: `t${number}`; url: string; title: string }[]>; page(ref: string | number): Page;
  pool<I, R>(items: I[], fn: (page: Page, item: I) => Promise<R>, o?: { concurrency?: number }): Promise<R[]>;
  fetch(url: string, init?: RequestInit & { session?: Sealed<"session">; as?: "json" | "text" | "base64" }):
    Promise<{ status: number; headers: Record<string, string>; json?: unknown; text?: string }>;
  history(q: string, o?: { days?: number }): Promise<{ url: string; title: string; at: string }[]>;
};
declare function help(topic?: string): string; // every other capability, with runnable examples

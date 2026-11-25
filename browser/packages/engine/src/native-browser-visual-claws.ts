// page.canvas and page.visual: canvases on the page, a clipped pixel diff against a baseline and
// a hit test that says whether something covers a point or box. Everything here is lazy: no
// listener, patch or DevTools command exists until a call asks for it, and the 2D text tap is
// removed again by stop(). The DevTools channel is passed in, so tests can stub it.
export type Cdp = (method: string, params?: Record<string, unknown>) => Promise<unknown>;
type Value = Record<string, unknown>;

export interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}

const MAX_BASELINES = 32;
const SAMPLES = 4096;
const baselines = new Map<string, { sha256: string; bytes: Uint8Array; clip: Clip }>();

async function evaluate<T>(cdp: Cdp, expression: string): Promise<T> {
  const answer = (await cdp("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
  if (answer?.exceptionDetails) throw new Error("EVAL_FAILED: " + answer.exceptionDetails.text);
  return answer?.result?.value as T;
}

const call = (fn: string, arg: unknown) => `(${fn})(${JSON.stringify(arg ?? null)})`;

// Runs in the page: canvases with their size, box and context kind (never creates a context).
const CANVAS_LIST = String((arg: { selector?: string; digest?: boolean }) => {
  const tap = (
    window as unknown as { __aeonCanvasTap?: { kinds?: WeakMap<HTMLCanvasElement, string> } }
  ).__aeonCanvasTap;
  // Never probe via canvas.getContext(): calling getContext('2d') on an untouched canvas locks
  // its context type and permanently breaks a page's later WebGL initialization.
  const kindOf = (canvas: HTMLCanvasElement) => tap?.kinds?.get(canvas) ?? "untouched";
  const nodes = [...document.querySelectorAll(arg.selector || "canvas")].filter(
    (node): node is HTMLCanvasElement => node instanceof HTMLCanvasElement,
  );
  return nodes.slice(0, 50).map((canvas, index) => {
    const box = canvas.getBoundingClientRect();
    let digest: string | undefined;
    if (arg.digest) {
      try {
        const data = canvas.toDataURL("image/png");
        let hash = 2166136261;
        for (let i = 0; i < data.length; i++) hash = Math.imul(hash ^ data.charCodeAt(i), 16777619);
        digest = (hash >>> 0).toString(16) + ":" + data.length;
      } catch {
        digest = "tainted";
      }
    }
    return {
      index,
      id: canvas.id || undefined,
      width: canvas.width,
      height: canvas.height,
      context: kindOf(canvas),
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      ...(digest ? { digest } : {}),
    };
  });
});

// Runs in the page before any drawing it wants to see: remembers each context kind and, while
// the tap runs, fillText/strokeText calls into a bounded buffer. stop() puts the originals back.
const TEXT_TAP = String((arg: { action: string; limit?: number }) => {
  const w = window as unknown as {
    __aeonCanvasTap?: {
      texts: unknown[];
      kinds: WeakMap<HTMLCanvasElement, string>;
      restore: () => void;
    };
  };
  if (arg.action === "list") return w.__aeonCanvasTap ? w.__aeonCanvasTap.texts.slice() : null;
  if (arg.action === "stop") {
    const had = Boolean(w.__aeonCanvasTap);
    w.__aeonCanvasTap?.restore();
    delete w.__aeonCanvasTap;
    return { stopped: had };
  }
  if (w.__aeonCanvasTap) return { started: true, already: true };
  const proto = CanvasRenderingContext2D.prototype;
  const fill = proto.fillText;
  const stroke = proto.strokeText;
  const getContext = HTMLCanvasElement.prototype.getContext;
  const limit = Math.min(Math.max(Number(arg.limit) || 500, 1), 2000);
  const kinds = new WeakMap<HTMLCanvasElement, string>();
  const texts: { text: string; x: number; y: number; op: string; canvas?: string | undefined }[] =
    [];
  const note = (op: string) =>
    function (this: CanvasRenderingContext2D, text: string, x: number, y: number) {
      texts.push({
        text: String(text).slice(0, 500),
        x,
        y,
        op,
        canvas: this.canvas?.id || undefined,
      });
      if (texts.length > limit) texts.shift();
      return (op === "fill" ? fill : stroke).apply(this, arguments as never);
    };
  proto.fillText = note("fill");
  proto.strokeText = note("stroke");
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string) {
    kinds.set(this, kind);
    return getContext.apply(this, arguments as never);
  } as typeof getContext;
  w.__aeonCanvasTap = {
    texts,
    kinds,
    restore: () => {
      proto.fillText = fill;
      proto.strokeText = stroke;
      HTMLCanvasElement.prototype.getContext = getContext;
    },
  };
  return { started: true };
});

// Runs in the page: what is on top at the target's centre (and corners for a box).
const HIT_TEST = String((arg: { selector?: string; x?: number; y?: number }) => {
  const describe = (el: Element | null) =>
    el
      ? {
          tag: el.tagName.toLowerCase(),
          id: el.id || undefined,
          className:
            typeof el.className === "string" ? el.className.slice(0, 80) || undefined : undefined,
          text: ((el as HTMLElement).innerText || "").trim().slice(0, 80) || undefined,
        }
      : null;
  let target: Element | null = null;
  let rect: { x: number; y: number; width: number; height: number };
  if (arg.selector) {
    target = document.querySelector(arg.selector);
    if (!target) return { error: "TARGET_NOT_FOUND: no element matches " + arg.selector };
    const box = target.getBoundingClientRect();
    rect = { x: box.x, y: box.y, width: box.width, height: box.height };
  } else rect = { x: Number(arg.x), y: Number(arg.y), width: 0, height: 0 };
  const inset = (n: number, size: number) => (size > 4 ? n + Math.min(2, size / 4) : n);
  const points: [number, number][] = [[rect.x + rect.width / 2, rect.y + rect.height / 2]];
  if (rect.width > 4 && rect.height > 4)
    points.push(
      [inset(rect.x, rect.width), inset(rect.y, rect.height)],
      [
        rect.x + rect.width - Math.min(2, rect.width / 4) - 0.5,
        rect.y + rect.height - Math.min(2, rect.height / 4) - 0.5,
      ],
    );
  const hits = points.map(([x, y]) => document.elementFromPoint(x, y));
  const covered = hits.map((hit) =>
    target ? !hit || !(hit === target || target.contains(hit)) : false,
  );
  const top = hits[0] ?? null;
  const offscreen =
    rect.y + rect.height < 0 ||
    rect.y > innerHeight ||
    rect.x > innerWidth ||
    rect.x + rect.width < 0;
  return {
    occluded: offscreen || covered[0] === true,
    partial: !covered[0] && covered.some(Boolean),
    offscreen,
    topElement: describe(top),
    targetRect: rect,
  };
});

function toBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Share of sampled bytes that differ (0 = identical, 1 = all different); length change counts. */
export function byteDelta(before: Uint8Array, after: Uint8Array): number {
  const length = Math.max(before.length, after.length);
  if (!length) return 0;
  const step = Math.max(1, Math.floor(length / SAMPLES));
  let checked = 0;
  let differ = 0;
  for (let i = 0; i < length; i += step) {
    checked++;
    if (before[i] !== after[i]) differ++;
  }
  return Math.round((differ / checked) * 10_000) / 10_000;
}

export function normalClip(value: unknown): Clip {
  const clip = (value ?? {}) as Value;
  const num = (key: string, min: number) => Math.max(min, Math.round(Number(clip[key]) || 0));
  const out = { x: num("x", 0), y: num("y", 0), width: num("width", 1), height: num("height", 1) };
  if (!Number(clip.width) || !Number(clip.height))
    throw new Error("INVALID_INPUT: regionDiff needs a clip {x, y, width, height}");
  return out;
}

async function regionDiff(tabId: number, cdp: Cdp, value: Value): Promise<unknown> {
  const clip = normalClip(value.clip);
  const name = typeof value.baseline === "string" ? value.baseline : "default";
  const key = `${tabId}:${name}`;
  const shot = (await cdp("Page.captureScreenshot", {
    format: "png",
    clip: { ...clip, scale: 1 },
    captureBeyondViewport: false,
  })) as { data?: string };
  if (!shot?.data) throw new Error("UNSUPPORTED: the tab gave no screenshot");
  const bytes = toBytes(shot.data);
  const hash = await sha256(bytes);
  const prior = value.reset === true ? undefined : baselines.get(key);
  baselines.delete(key);
  baselines.set(key, { sha256: hash, bytes, clip });
  while (baselines.size > MAX_BASELINES) baselines.delete(baselines.keys().next().value as string);
  if (!prior)
    return { baseline: name, sha256: hash, clip, first: true, changed: false, diffRatio: 0 };
  const same = prior.sha256 === hash;
  const diffRatio = same ? 0 : Math.max(byteDelta(prior.bytes, bytes), 0.0001);
  return { baseline: name, sha256: hash, previous: prior.sha256, clip, changed: !same, diffRatio };
}

/** Drops a tab's baselines (tab closed, or forget()). */
export function forgetVisual(tabId: number): void {
  for (const key of [...baselines.keys()]) if (key.startsWith(`${tabId}:`)) baselines.delete(key);
}

export async function visualCall(tabId: number, value: Value, cdp: Cdp): Promise<unknown> {
  switch (value.visual) {
    case "canvas":
      return {
        canvases: await evaluate(
          cdp,
          call(CANVAS_LIST, { selector: value.selector, digest: value.digest === true }),
        ),
      };
    case "canvasTap": {
      const action = String(value.action ?? "list");
      if (!["start", "stop", "list"].includes(action))
        throw new Error("INVALID_INPUT: canvasTap action is start, stop or list");
      const answer = await evaluate<unknown>(cdp, call(TEXT_TAP, { action, limit: value.limit }));
      return action === "list" ? { texts: answer ?? [], tapping: answer !== null } : answer;
    }
    case "regionDiff":
      return regionDiff(tabId, cdp, value);
    case "forget":
      forgetVisual(tabId);
      return { forgotten: true };
    case "occlusion": {
      const target = value.visualTarget ?? {};
      const arg = typeof target === "string" ? { selector: target } : target;
      const answer = await evaluate<Value>(cdp, call(HIT_TEST, arg));
      if (answer && typeof answer.error === "string") throw new Error(answer.error);
      return answer;
    }
    default:
      throw new Error(
        "INVALID_INPUT: visual is canvas, canvasTap, regionDiff, occlusion or forget",
      );
  }
}

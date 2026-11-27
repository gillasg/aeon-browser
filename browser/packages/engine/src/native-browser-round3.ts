// Round 3 page claws, pure parts: checkout and coupon detection, dialog decisions with a bounded log,
// worker filtering, and the opt-in WebAssembly tap. Page-side collectors read names, labels and visible
// text only, never a field's value, so card numbers, CVVs and passwords cannot leave the page.

export interface CheckoutField {
  name: string;
  type: string;
  autocomplete: string;
  label: string;
}

export interface CheckoutRaw {
  url: string;
  fields: CheckoutField[];
  buttons: string[];
  lines: string[];
}

export interface CheckoutResult {
  isCheckout: boolean;
  step?: string;
  coupon?: { field: string; apply?: string };
  amounts: Record<string, string>;
  payment: { fields: string[]; markers: string[] };
}

const COUPON = /coupon|promo|voucher|discount|gift ?card|redeem/i;
const PAYMENT_AUTOCOMPLETE = /^cc-|card/i;
const PAYMENT_NAME = /card|cc[-_ ]?(num|exp|csc)|cvv|cvc|expir|security code/i;
const AMOUNT_KEYS: [string, RegExp][] = [
  ["subtotal", /sub-?total/i],
  ["discount", /discount|savings|promo/i],
  ["shipping", /shipping|delivery|postage/i],
  ["tax", /\btax|vat|gst\b/i],
  ["total", /^\s*(order |grand |estimated )?total\b/i],
];
const MONEY = /([$€£¥₹]|[A-Z]{3}\s?)\s?\d[\d,.]*|\d[\d,.]*\s?([€£]|[A-Z]{3}\b)/;

function checkoutStep(raw: CheckoutRaw): string | undefined {
  const text = (raw.url + " " + raw.lines.join(" ")).toLowerCase();
  if (/review (your )?order|place (your )?order/.test(text)) return "review";
  if (
    raw.fields.some(
      (f) => PAYMENT_NAME.test(f.name + f.label) || PAYMENT_AUTOCOMPLETE.test(f.autocomplete),
    )
  )
    return "payment";
  if (/shipping|delivery address/.test(text)) return "shipping";
  if (/\b(cart|basket|bag)\b/.test(text)) return "cart";
  return undefined;
}

function checkoutAmounts(lines: string[]): Record<string, string> {
  const amounts: Record<string, string> = {};
  for (const line of lines.slice(0, 400)) {
    const money = MONEY.exec(line);
    if (!money || line.length > 120) continue;
    for (const [key, pattern] of AMOUNT_KEYS)
      if (!amounts[key] && pattern.test(line)) {
        amounts[key] = money[0].trim();
        break;
      }
  }
  return amounts;
}

/** Checkout form, coupon field and apply button, order amounts, payment step markers. Deterministic. */
export function checkoutOf(raw: CheckoutRaw): CheckoutResult {
  const couponField = raw.fields.find((f) => COUPON.test(f.name + " " + f.label));
  const apply = raw.buttons.find((b) => /^(apply|redeem|use code|add code)/i.test(b.trim()));
  const paymentFields = raw.fields
    .filter(
      (f) => PAYMENT_NAME.test(f.name + " " + f.label) || PAYMENT_AUTOCOMPLETE.test(f.autocomplete),
    )
    .map((f) => f.name || f.label);
  const markers = raw.buttons
    .concat(raw.lines.slice(0, 200))
    .filter((t) =>
      /place (your )?order|pay now|complete (purchase|order)|checkout|payment method/i.test(t),
    )
    .map((t) => t.slice(0, 80))
    .slice(0, 10);
  const amounts = checkoutAmounts(raw.lines);
  const step = checkoutStep(raw);
  const out: CheckoutResult = {
    isCheckout:
      !!(paymentFields.length || couponField || markers.length || amounts.total) &&
      !!(amounts.total || markers.length || paymentFields.length),
    amounts,
    payment: { fields: [...new Set(paymentFields)].slice(0, 20), markers: [...new Set(markers)] },
  };
  if (step) out.step = step;
  if (couponField)
    out.coupon = apply
      ? { field: couponField.name || couponField.label, apply }
      : { field: couponField.name || couponField.label };
  return out;
}

/** Page side: field names/types/labels (never values), button texts and short visible lines. */
export function checkoutCollect(): CheckoutRaw {
  const label = (el: HTMLInputElement): string =>
    String(
      (el.labels && el.labels[0]?.innerText) ||
        el.getAttribute("aria-label") ||
        el.placeholder ||
        "",
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
  const fields = [...document.querySelectorAll("input,select,textarea")]
    .slice(0, 400)
    .map((node) => {
      const el = node as HTMLInputElement;
      return {
        name: el.name || el.id || "",
        type: el.type || el.tagName.toLowerCase(),
        autocomplete: el.getAttribute("autocomplete") || "",
        label: label(el),
      };
    });
  const buttons = [...document.querySelectorAll("button,input[type=submit],[role=button],a.button")]
    .slice(0, 200)
    .map((el) =>
      String((el as HTMLInputElement).value || (el as HTMLElement).innerText || "")
        .trim()
        .slice(0, 80),
    )
    .filter(Boolean);
  const lines = String(document.body?.innerText || "")
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line && line.length <= 120)
    .slice(0, 1500);
  return { url: location.href, fields, buttons, lines };
}

export interface DialogPolicy {
  action?: string;
  promptText?: string;
  match?: string;
}

export interface DialogEvent {
  type?: string;
  message?: string;
  url?: string;
  defaultPrompt?: string;
}

/** The Page.handleJavaScriptDialog params for one dialog under a policy (a non-matching dialog is dismissed). */
export function dialogDecision(
  policy: DialogPolicy,
  event: DialogEvent,
): { accept: boolean; promptText?: string } {
  const message = String(event.message ?? "");
  const matched =
    !policy.match || message.toLowerCase().includes(String(policy.match).toLowerCase());
  const accept = matched && policy.action !== "dismiss";
  if (!accept || event.type !== "prompt") return { accept };
  return { accept, promptText: String(policy.promptText ?? event.defaultPrompt ?? "") };
}

/** Appends a scrubbed log row, keeping at most cap rows. */
export function dialogLogPush(
  log: Record<string, unknown>[],
  event: DialogEvent,
  decision: { accept: boolean },
  scrub: (text: string) => string,
  cap = 50,
): void {
  log.push({
    at: Date.now(),
    type: event.type || "alert",
    message: scrub(String(event.message ?? "").slice(0, 300)),
    accepted: decision.accept,
  });
  if (log.length > cap) log.splice(0, log.length - cap);
}

export interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
  title?: string;
}

/** Dedicated, shared and service workers whose URL is on the page's origin. */
export function workersOf(infos: TargetInfo[], origin: string): TargetInfo[] {
  const kinds = new Set(["worker", "shared_worker", "service_worker"]);
  return infos
    .filter((info) => kinds.has(info.type))
    .filter((info) => {
      try {
        return new URL(info.url).origin === origin;
      } catch {
        return false;
      }
    })
    .map((info) => ({
      targetId: info.targetId,
      type: info.type,
      url: info.url,
      title: info.title ?? "",
    }));
}

/** Page side: wrap WebAssembly.instantiate/instantiateStreaming to record module metadata (idempotent). */
export function wasmTapInstall(): { installed: boolean } {
  const w = window as unknown as Record<string, unknown>;
  if (w.__uxWasmTap) return { installed: true };
  const wasm = WebAssembly as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const log: Record<string, unknown>[] = [];
  const original = {
    instantiate: wasm.instantiate,
    instantiateStreaming: wasm.instantiateStreaming,
  };
  const note = (source: string, result: unknown): void => {
    const r = result as { module?: WebAssembly.Module; instance?: WebAssembly.Instance };
    const module = r.module ?? (result instanceof WebAssembly.Module ? result : undefined);
    const exports = module
      ? WebAssembly.Module.exports(module)
          .map((e) => e.name)
          .slice(0, 100)
      : Object.keys(r.instance?.exports ?? {}).slice(0, 100);
    const memory = Object.values(r.instance?.exports ?? {}).find(
      (v) => v instanceof WebAssembly.Memory,
    ) as WebAssembly.Memory | undefined;
    log.push({
      at: Date.now(),
      source: source.slice(0, 300),
      exports,
      memoryPages: memory ? memory.buffer.byteLength / 65536 : undefined,
    });
    if (log.length > 50) log.shift();
  };
  const tap = (name: "instantiate" | "instantiateStreaming") =>
    async function (this: unknown, ...args: unknown[]): Promise<unknown> {
      const first = args[0] as { url?: string } | undefined;
      const source =
        name === "instantiateStreaming"
          ? String((await (first as Promise<{ url?: string }>))?.url ?? "stream")
          : first instanceof WebAssembly.Module
            ? "module"
            : "bytes";
      const result = await original[name]!.apply(WebAssembly, args);
      note(source, result);
      return result;
    };
  if (original.instantiate) wasm.instantiate = tap("instantiate");
  if (original.instantiateStreaming) wasm.instantiateStreaming = tap("instantiateStreaming");
  w.__uxWasmTap = { log, original };
  return { installed: true };
}

/** Page side: the recorded modules. */
export function wasmTapList(): Record<string, unknown>[] {
  const tap = (window as unknown as Record<string, { log: Record<string, unknown>[] } | undefined>)
    .__uxWasmTap;
  return tap ? tap.log.slice() : [];
}

/** Page side: put the original functions back and forget the log. */
export function wasmTapRemove(): { removed: boolean } {
  const w = window as unknown as Record<string, unknown>;
  const tap = w.__uxWasmTap as { original: Record<string, unknown> } | undefined;
  if (!tap) return { removed: false };
  Object.assign(WebAssembly, Object.fromEntries(Object.entries(tap.original).filter(([, v]) => v)));
  delete w.__uxWasmTap;
  return { removed: true };
}

/** The constants and helpers checkoutOf reads, as sandbox source. */
export const checkoutSource = [
  "var COUPON = " + String(COUPON) + ";",
  "var PAYMENT_AUTOCOMPLETE = " + String(PAYMENT_AUTOCOMPLETE) + ";",
  "var PAYMENT_NAME = " + String(PAYMENT_NAME) + ";",
  "var MONEY = " + String(MONEY) + ";",
  "var AMOUNT_KEYS = [" +
    AMOUNT_KEYS.map(
      ([key, pattern]) => "[" + JSON.stringify(key) + ", " + String(pattern) + "]",
    ).join(", ") +
    "];",
  String(checkoutStep),
  String(checkoutAmounts),
].join("\n");

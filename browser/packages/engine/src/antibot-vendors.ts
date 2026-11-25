// Bot vendors a site runs, read from its cookies, scripts and headers. A vendor on the page is a
// reason to move like a person from the first action, not only after a challenge (ST-4).
import { noteChallengeSeen } from "./native-browser-human-input.js";

export type BotVendor = "cloudflare" | "datadome" | "perimeterx" | "akamai" | "kasada";

export interface VendorSignals {
  /** `document.cookie`, or a list of cookie names. */
  cookies?: string | string[] | undefined;
  /** Script and frame sources on the page. */
  scripts?: string[] | undefined;
  /** Page HTML or a slice of it. */
  html?: string;
  headers?: Record<string, string | undefined>;
}

const COOKIES: [RegExp, BotVendor][] = [
  [/^(cf_clearance|__cf_bm|cf_chl_\w*)$/, "cloudflare"],
  [/^datadome$/i, "datadome"],
  [/^_px(3|2|hd|vid|cvid)?$/, "perimeterx"],
  [/^(_abck|bm_sz|ak_bmsc)$/, "akamai"],
  [/^(KP_UIDz(-ssn)?|x-kpsdk-\w+)$/i, "kasada"],
];

const SOURCES: [RegExp, BotVendor][] = [
  [/challenges\.cloudflare\.com|cf-turnstile|_cf_chl_opt/i, "cloudflare"],
  [/captcha-delivery\.com|js\.datadome\.co|\bdatadome\b/i, "datadome"],
  [/perimeterx\.net|px-cdn\.net|px-captcha|_pxAppId/i, "perimeterx"],
  [/\/akam\/\d+\/|\b_abck\b/i, "akamai"],
  [/\/ips\.js(\?|"|'|$)|\bkpsdk\b|x-kpsdk/i, "kasada"],
];

const HEADERS: [string, BotVendor][] = [
  ["cf-mitigated", "cloudflare"],
  ["x-datadome", "datadome"],
  ["x-px-block", "perimeterx"],
  ["x-akamai-transformed", "akamai"],
  ["x-kpsdk-ct", "kasada"],
  ["x-kpsdk-r", "kasada"],
];

function cookieNames(cookies: VendorSignals["cookies"]): string[] {
  if (Array.isArray(cookies)) return cookies.map((name) => name.trim());
  return (cookies ?? "")
    .split(";")
    .map((pair) => pair.split("=")[0]?.trim() ?? "")
    .filter(Boolean);
}

/** Every vendor the signals name, once each, in a stable order. */
export function detectVendors(signals: VendorSignals): BotVendor[] {
  const found = new Set<BotVendor>();
  for (const name of cookieNames(signals.cookies))
    for (const [pattern, vendor] of COOKIES) if (pattern.test(name)) found.add(vendor);
  const sources = [...(signals.scripts ?? []), (signals.html ?? "").slice(0, 200_000)];
  for (const source of sources)
    for (const [pattern, vendor] of SOURCES) if (pattern.test(source)) found.add(vendor);
  const headers = signals.headers ?? {};
  for (const [name, vendor] of HEADERS) if (headers[name]) found.add(vendor);
  return (["cloudflare", "datadome", "perimeterx", "akamai", "kasada"] as const).filter((v) =>
    found.has(v),
  );
}

export interface KinematicsChoice {
  human: boolean;
  reason?: "vendor" | "breaker" | "opted-out";
  vendors: BotVendor[];
}

/** Whether input should be human-paced from action 1. An explicit opt-out (tests) wins. */
export function kinematicsFromStart(input: {
  vendors: BotVendor[];
  breakerTripped?: boolean;
  optOut?: boolean;
}): KinematicsChoice {
  const vendors = input.vendors;
  if (input.optOut) return { human: false, reason: "opted-out", vendors };
  if (vendors.length) return { human: true, reason: "vendor", vendors };
  if (input.breakerTripped) return { human: true, reason: "breaker", vendors };
  return { human: false, vendors };
}

let breakerProbe: (origin: string) => boolean = () => false;
let optedOut = false;

/** Tells the engine which origins have a tripped Rung-0 breaker (site-mapper owns the breaker). */
export function setBreakerProbe(probe?: (origin: string) => boolean): void {
  breakerProbe = probe ?? (() => false);
}

/** Opts out of vendor-aware kinematics, for tests that need the fast path. */
export function setVendorKinematicsOptOut(value: boolean): void {
  optedOut = value;
}

function originOf(url: string | undefined): string | undefined {
  try {
    return url ? new URL(url).origin : undefined;
  } catch {
    return undefined;
  }
}

/** Arms human-paced input on the tab when its page names a vendor or its site tripped the breaker. */
export function armVendorKinematics(
  tabId: number | undefined,
  page: { url?: string; vendors?: BotVendor[]; gate?: unknown },
): KinematicsChoice {
  const origin = originOf(page.url);
  const choice = kinematicsFromStart({
    vendors: page.vendors ?? [],
    breakerTripped: origin ? breakerProbe(origin) : false,
    optOut: optedOut,
  });
  if (page.gate || choice.human) noteChallengeSeen(tabId);
  return choice;
}

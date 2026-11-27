import type { Check } from "./doctor-checks.js";

// The only new network page the stealth doctor uses. The browser reaches it through its own
// route (proxy included), so `loc=` is the country of the exit IP the user actually browses with.
export const STEALTH_TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace";

// The unit-file token from the 2026-11-16 stealth audit. Chrome 157 does not accept the old
// `--force-webrtc-ip-handling-policy` name; this is the real switch.
export const WEBRTC_FLAG = "--webrtc-ip-handling-policy=disable_non_proxied_udp";
export const WEBRTC_FIX = `Restart Chrome with ${WEBRTC_FLAG} (Chrome's WebRTC IP handling policy), then retry.`;
export const STABLE_FIX =
  "Run the stable, branded Google Chrome on a real display with its default profile, then update Graft if a tell remains.";

const OPEN_GRAFT = "Open Chrome with Graft loaded so the stealth tab can run.";
const TRACE_FIX = `Make sure Chrome can reach ${STEALTH_TRACE_URL} through its normal route, then retry.`;

/** One gathered ICE candidate, as the page saw it. */
export interface IceCandidate {
  /** "host", "srflx", "prflx", "relay", ... */
  type?: string;
  /** The IP address, or an mDNS `*.local` name (which carries no IP). */
  address?: string;
}

/** Raw values a stealth tab probe read. The checks interpret them; nothing here is spoofed. */
export interface StealthFacts {
  /** The probe could not run at all (browser offline, tab failed). */
  error?: string;
  webrtc?: {
    /** The HTTP exit IP from the trace page, to compare ICE candidates against. */
    exitIp?: string;
    candidates: IceCandidate[];
  };
  geo?: {
    /** ISO country code from the trace's `loc=` line. */
    exitCountry?: string;
    /** Intl.DateTimeFormat().resolvedOptions().timeZone. */
    timeZone?: string;
    /** navigator.languages. */
    languages: string[];
  };
  page?: {
    webdriver: boolean;
    userAgent: string;
    /** Client-hint brands, e.g. ["Chromium 157", "Not-A.Brand 99"]. */
    brands: string[];
    screen: { width: number; height: number };
    plugins: number;
    mimeTypes: number;
    /** Readable signals from page.stealthCheck() (things a page can see). */
    signals: string[];
    /** Engine-only notes from page.stealthCheck() (not page-visible). */
    diagnostics: string[];
  };
}

/** The three stealth checks, in a fixed order, each with its one exact fix. */
export function stealthChecks(facts: StealthFacts): Check[] {
  if (facts.error) {
    const detail = `Not checked: ${facts.error}`;
    return [
      check("webrtc", "fail", detail, OPEN_GRAFT),
      check("geo", "fail", detail, OPEN_GRAFT),
      check("tells", "fail", detail, OPEN_GRAFT),
    ];
  }
  return [webrtcCheck(facts.webrtc), geoCheck(facts.geo), tellsCheck(facts.page)];
}

function webrtcCheck(webrtc: StealthFacts["webrtc"]): Check {
  const candidates = webrtc?.candidates ?? [];
  const exitIp = webrtc?.exitIp;
  if (!candidates.length)
    return check(
      "webrtc",
      "ok",
      "WebRTC gathered no ICE candidates; no local address is exposed.",
      WEBRTC_FIX,
    );
  const leaks = candidates.filter((candidate) => isLeak(candidate, exitIp));
  if (!leaks.length)
    return check(
      "webrtc",
      "ok",
      `WebRTC candidates match the exit IP${exitIp ? ` ${exitIp}` : ""}; no local address is exposed.`,
      WEBRTC_FIX,
    );
  const list = leaks.map(candidateText).join(", ");
  return check(
    "webrtc",
    "fail",
    `WebRTC exposes addresses that are not the exit IP: ${list}.`,
    WEBRTC_FIX,
  );
}

/** A candidate leaks when it carries an address (mDNS has none) that is not the exit IP. */
function isLeak(candidate: IceCandidate, exitIp?: string): boolean {
  const address = String(candidate.address ?? "").trim();
  if (!address || /\.local$/i.test(address)) return false;
  return !exitIp || !sameAddress(address, exitIp);
}

function sameAddress(a: string, b: string): boolean {
  const clean = (value: string) =>
    value
      .trim()
      .replace(/^\[|\]$/g, "")
      .toLowerCase();
  return clean(a) === clean(b);
}

function candidateText(candidate: IceCandidate): string {
  return `${candidate.type ?? "candidate"} ${candidate.address ?? "?"}`;
}

interface GeoReading {
  country: string;
  timeZone: string;
  languages: string[];
  zoneCountry: string | undefined;
  languageRegion: string | undefined;
}

function geoCheck(geo: StealthFacts["geo"]): Check {
  const { country, timeZone, languages, zoneCountry, languageRegion } = geoReading(geo);
  if (!country) return check("geo", "fail", "The exit country could not be read.", TRACE_FIX);
  const zoneMismatch = zoneCountry !== undefined && zoneCountry !== country;
  const languageMismatch = languageRegion !== undefined && languageRegion !== country;
  if (!zoneMismatch) return geoPass(country, timeZone, languages, languageMismatch);
  return check(
    "geo",
    "fail",
    `Exit country ${country} does not match the browser time zone ${timeZone} (${zoneCountry}).`,
    geoFix(country, languageMismatch),
  );
}

function geoReading(geo: StealthFacts["geo"]): GeoReading {
  const country = geo?.exitCountry ?? "";
  const timeZone = geo?.timeZone ?? "";
  const languages = geo?.languages ?? [];
  return {
    country,
    timeZone,
    languages,
    zoneCountry: countryForTimeZone(timeZone),
    languageRegion: regionOfLanguages(languages),
  };
}

function geoPass(
  country: string,
  timeZone: string,
  languages: string[],
  languageMismatch: boolean,
): Check {
  // An unmapped zone is not called a mismatch: better to say nothing than to guess. Languages
  // are reported but do not flip the line on their own — a person's own `en-US,en` is normal.
  const note = languageMismatch ? ` Languages are ${languages.join(", ")}.` : "";
  const zone = timeZone ? ` (${timeZone})` : "";
  return check(
    "geo",
    "ok",
    `Exit country ${country} matches the browser time zone${zone}.${note}`,
    geoFix(country, false),
  );
}

function geoFix(country: string, includeLanguage: boolean): string {
  const zone = zoneForCountry(country);
  const parts = [`TZ=${zone}`];
  if (includeLanguage) parts.push(`LANG=${languageForCountry(country)}`);
  return `Run Chrome with ${parts.join(" and ")} to match exit country ${country}.`;
}

interface TellSink {
  (issue: string, fix: string): void;
}

function tellsCheck(page: StealthFacts["page"]): Check {
  if (!page) return check("tells", "fail", "The page tell probe did not run.", OPEN_GRAFT);
  const { issues, fixes } = collectTells(page);
  if (!issues.length) return check("tells", "ok", okDetail(page), STABLE_FIX);
  return check(
    "tells",
    "fail",
    `Page tells: ${issues.join("; ")}.`,
    `${fixes.map((f) => f.charAt(0).toUpperCase() + f.slice(1)).join("; ")}.`,
  );
}

function collectTells(page: NonNullable<StealthFacts["page"]>): {
  issues: string[];
  fixes: string[];
} {
  const issues: string[] = [];
  const fixes: string[] = [];
  const add: TellSink = (issue, fix) => {
    issues.push(issue);
    if (!fixes.includes(fix)) fixes.push(fix);
  };
  addBrowserTells(page, add);
  for (const signal of page.signals ?? []) add(signal, "update Graft, then run the stable Chrome");
  return { issues, fixes };
}

function addBrowserTells(page: NonNullable<StealthFacts["page"]>, add: TellSink): void {
  if (page.webdriver)
    add("navigator.webdriver is true", "run a normal Chrome, not an automated build");
  if (/headless/i.test(page.userAgent ?? ""))
    add("the user agent says headless", "run Chrome on a real display, not headless");
  addBrandTell(page.brands ?? [], add);
  const screen = page.screen ?? { width: 0, height: 0 };
  if (!screen.width || !screen.height)
    add("the screen reports zero size", "run Chrome on a real display");
  if (!page.plugins || !page.mimeTypes)
    add(
      "browser plugins or MIME types are missing",
      "run Chrome with its default profile and PDF viewer",
    );
}

function addBrandTell(brands: string[], add: TellSink): void {
  const testBuild = brands.some(
    (brand) => /chrome for testing/i.test(brand) || /headless/i.test(brand),
  );
  if (testBuild)
    add(
      'the "Chrome for Testing" client-hint brand',
      "run the stable Google Chrome, not Chrome for Testing",
    );
  else if (brands.length && !brands.some((brand) => /google chrome/i.test(brand)))
    add(
      "the Google Chrome client-hint brand is missing",
      "run the stable Google Chrome, not Chrome for Testing",
    );
}

function okDetail(page: NonNullable<StealthFacts["page"]>): string {
  const screen = page.screen ?? { width: 0, height: 0 };
  return `No page tells: webdriver off, stable-branded Chrome, screen ${screen.width}x${screen.height}, ${page.plugins ?? 0} plugins.`;
}

function check(name: Check["name"], status: Check["status"], detail: string, fix: string): Check {
  return { name, status, detail, fix };
}

// Time zone <-> country mapping. This is general IANA data, not a site name. Unknown zones are
// left unmapped so the geo check never guesses. `Asia/Calcutta` is the alias the audit measured.
const COUNTRY_ZONE: Record<string, string> = {
  IN: "Asia/Kolkata",
  DE: "Europe/Berlin",
  US: "America/New_York",
  GB: "Europe/London",
  FR: "Europe/Paris",
  NL: "Europe/Amsterdam",
  IE: "Europe/Dublin",
  CH: "Europe/Zurich",
  CA: "America/Toronto",
  AU: "Australia/Sydney",
  NZ: "Pacific/Auckland",
  JP: "Asia/Tokyo",
  CN: "Asia/Shanghai",
  SG: "Asia/Singapore",
  KR: "Asia/Seoul",
  BR: "America/Sao_Paulo",
  ZA: "Africa/Johannesburg",
};

const ZONE_COUNTRY: Record<string, string> = {
  "Asia/Kolkata": "IN",
  "Asia/Calcutta": "IN",
  "Europe/Berlin": "DE",
  "Europe/Paris": "FR",
  "Europe/London": "GB",
  "Europe/Amsterdam": "NL",
  "Europe/Dublin": "IE",
  "Europe/Zurich": "CH",
  "America/New_York": "US",
  "America/Chicago": "US",
  "America/Denver": "US",
  "America/Los_Angeles": "US",
  "America/Toronto": "CA",
  "America/Vancouver": "CA",
  "Australia/Sydney": "AU",
  "Australia/Melbourne": "AU",
  "Pacific/Auckland": "NZ",
  "Asia/Tokyo": "JP",
  "Asia/Shanghai": "CN",
  "Asia/Singapore": "SG",
  "Asia/Seoul": "KR",
  "America/Sao_Paulo": "BR",
  "Africa/Johannesburg": "ZA",
};

const COUNTRY_LANGUAGE: Record<string, string> = {
  IN: "en_IN.UTF-8",
  DE: "de_DE.UTF-8",
  US: "en_US.UTF-8",
  GB: "en_GB.UTF-8",
  FR: "fr_FR.UTF-8",
  CA: "en_CA.UTF-8",
  AU: "en_AU.UTF-8",
  JP: "ja_JP.UTF-8",
  CN: "zh_CN.UTF-8",
  BR: "pt_BR.UTF-8",
};

function countryForTimeZone(timeZone: string): string | undefined {
  if (!timeZone) return undefined;
  if (ZONE_COUNTRY[timeZone]) return ZONE_COUNTRY[timeZone];
  const prefixes: [string, string][] = [
    ["US/", "US"],
    ["Canada/", "CA"],
    ["Brazil/", "BR"],
    ["Australia/", "AU"],
  ];
  for (const [prefix, country] of prefixes) {
    if (timeZone.startsWith(prefix)) return country;
  }
  return undefined;
}

function zoneForCountry(country: string): string {
  return COUNTRY_ZONE[country] ?? "the IANA zone for that country";
}

function languageForCountry(country: string): string {
  return COUNTRY_LANGUAGE[country] ?? `en_${country}.UTF-8`;
}

function regionOfLanguages(languages: string[]): string | undefined {
  for (const tag of languages ?? []) {
    const match = /^[a-z]{2,3}-([A-Za-z]{2})$/.exec(String(tag).trim());
    if (match?.[1]) return match[1].toUpperCase();
  }
  return undefined;
}

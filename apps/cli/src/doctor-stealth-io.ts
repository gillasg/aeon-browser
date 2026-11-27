import type { DaemonHost } from "./host.js";
import type { IceCandidate, StealthFacts } from "./doctor-stealth-checks.js";

// The one browser cell the stealth doctor runs. It opens one background, un-presented tab
// (no cursor, no overlay, no focus change), reads what a page can see through Chrome's own
// route, and closes the tab in `finally`. It never patches or spoofs anything: WebRTC ICE
// gathering uses the browser's standard public STUN (part of WebRTC itself, not a new Graft
// service); the only new page fetched is the Cloudflare trace.
const STEALTH_CELL = `
const TRACE = "https://www.cloudflare.com/cdn-cgi/trace";
const STUN = "stun:stun.l.google.com:19302";
const page = await browser.openTab(TRACE, { newTab: true, present: false, timeoutMs: 20000 });
try {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  const traceText = await page
    .evaluate(() => (document.body ? document.body.innerText : ""))
    .catch(() => "");

  const webrtc = await page
    .evaluate(async (stunUrl) => {
      const out = [];
      let pc;
      let done = false;
      let resolve;
      const gathered = new Promise((r) => { resolve = r; });
      const finish = () => {
        if (done) return;
        done = true;
        try { if (pc) pc.close(); } catch (error) {}
        resolve(out);
      };
      try {
        pc = new RTCPeerConnection({ iceServers: [{ urls: stunUrl }] });
      } catch (error) {
        return [];
      }
      pc.onicecandidate = (event) => {
        const candidate = event.candidate;
        if (!candidate) return;
        const fromString = /(\\d{1,3}(?:\\.\\d{1,3}){3}|[0-9a-f:]{4,})/i.exec(candidate.candidate || "");
        out.push({ type: candidate.type || "", address: candidate.address || (fromString ? fromString[1] : "") });
      };
      pc.onicegatheringstatechange = () => {
        if (pc && pc.iceGatheringState === "complete") finish();
      };
      pc.createDataChannel("graft-stealth-probe");
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .catch(finish);
      setTimeout(finish, 6000);
      return await gathered;
    }, STUN)
    .catch(() => []);

  const nav = await page
    .evaluate(() => {
      const data = navigator.userAgentData || {};
      const brands = (data.brands || []).map((entry) => String(entry.brand || "") + " " + String(entry.version || ""));
      const langs = navigator.languages && navigator.languages.length
        ? navigator.languages
        : [navigator.language || ""];
      return {
        webdriver: navigator.webdriver === true,
        userAgent: navigator.userAgent || "",
        brands: brands,
        screen: { width: screen.width || 0, height: screen.height || 0 },
        plugins: navigator.plugins ? navigator.plugins.length : 0,
        mimeTypes: navigator.mimeTypes ? navigator.mimeTypes.length : 0,
        timeZone: (Intl.DateTimeFormat().resolvedOptions() || {}).timeZone || "",
        languages: Array.from(langs).map(String),
      };
    })
    .catch(() => undefined);

  const stealth = await page
    .stealthCheck()
    .catch(() => ({ signals: [], diagnostics: [] }));

  return {
    traceText: traceText,
    candidates: Array.isArray(webrtc) ? webrtc : [],
    nav: nav,
    signals: Array.isArray((stealth || {}).signals) ? stealth.signals : [],
    diagnostics: Array.isArray((stealth || {}).diagnostics) ? stealth.diagnostics : [],
  };
} finally {
  await page.close().catch(() => {});
}
`;

/** Runs the stealth tab probe through the daemon and interprets its raw findings. */
export async function gatherStealthFacts(host: DaemonHost): Promise<StealthFacts> {
  try {
    const value = await host.runInBrowser(STEALTH_CELL, {
      session: "doctor-stealth",
      timeoutMs: 60000,
    });
    return parseStealthFacts(value);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Turns the raw cell result into facts. Kept separate so it can be tested with a fixture. */
export function parseStealthFacts(raw: unknown): StealthFacts {
  if (!raw || typeof raw !== "object") return { error: "The stealth tab returned no data." };
  const value = raw as Record<string, unknown>;
  if (typeof value.error === "string" && value.error) return { error: value.error };
  const trace = parseTrace(typeof value.traceText === "string" ? value.traceText : "");
  const nav = objectAt(value.nav);
  const screen = objectAt(nav?.screen);
  return {
    webrtc: webrtcFact(trace, parseCandidates(value.candidates)),
    geo: geoFact(trace, nav),
    page: pageFact(nav, screen, value),
  };
}

function webrtcFact(trace: Trace, candidates: IceCandidate[]): NonNullable<StealthFacts["webrtc"]> {
  return {
    ...(trace.ip ? { exitIp: trace.ip } : {}),
    candidates,
  };
}

function geoFact(
  trace: Trace,
  nav: Record<string, unknown> | undefined,
): NonNullable<StealthFacts["geo"]> {
  const timeZone = nav && typeof nav.timeZone === "string" ? nav.timeZone : undefined;
  return {
    ...(trace.country ? { exitCountry: trace.country } : {}),
    ...(timeZone ? { timeZone } : {}),
    languages: stringsOf(nav?.languages),
  };
}

function pageFact(
  nav: Record<string, unknown> | undefined,
  screen: Record<string, unknown> | undefined,
  value: Record<string, unknown>,
): NonNullable<StealthFacts["page"]> {
  const userAgent = nav && typeof nav.userAgent === "string" ? nav.userAgent : "";
  return {
    webdriver: nav?.webdriver === true,
    userAgent,
    brands: stringsOf(nav?.brands),
    screen: { width: numberAt(screen, "width"), height: numberAt(screen, "height") },
    plugins: numberAt(nav, "plugins"),
    mimeTypes: numberAt(nav, "mimeTypes"),
    signals: stringsOf(value.signals),
    diagnostics: stringsOf(value.diagnostics),
  };
}

function parseCandidates(value: unknown): IceCandidate[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((candidate) => ({
      ...(candidate.type ? { type: String(candidate.type) } : {}),
      ...(candidate.address ? { address: String(candidate.address) } : {}),
    }));
}

function objectAt(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? (value as unknown[]).map(String) : [];
}

function numberAt(object: Record<string, unknown> | undefined, key: string): number {
  return Number(object?.[key] ?? 0);
}

interface Trace {
  ip?: string;
  country?: string;
}

function parseTrace(text: string): Trace {
  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at > 0) fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  const ip = fields.get("ip");
  const loc = fields.get("loc");
  return {
    ...(ip ? { ip } : {}),
    ...(loc ? { country: loc.toUpperCase() } : {}),
  };
}

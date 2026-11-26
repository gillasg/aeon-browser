import { isNoiseHost } from "@browserkit/site-mapper/request-words";
export { READ_SEGMENT } from "@browserkit/site-mapper/request-words";
// One taxonomy for every request a page makes: is it the site's own API, or plumbing around it
// (bot challenges, sensors, trackers, beacons, media, assets, documents)? Learning, waits and
// listings all read the same answer, so a video manifest or a challenge call is never mistaken
// for an API.

export type RequestClass =
  | "api"
  | "graphql"
  | "tracker"
  | "challenge"
  | "sensor"
  | "media"
  | "asset"
  | "beacon"
  | "document";

export const REQUEST_CLASSES: readonly RequestClass[] = [
  "api",
  "graphql",
  "tracker",
  "challenge",
  "sensor",
  "media",
  "asset",
  "beacon",
  "document",
];

export interface RequestFacts {
  url: string;
  /** CDP resource type: XHR, Fetch, Document, Ping, Image, Media… */
  type?: string;
  mime?: string;
  method?: string;
  /** The script that made the request. */
  initiator?: string;
  status?: number;
  postData?: string;
}

const TRACKERS =
  /(^|\.)(google-analytics\.com|googletagmanager\.com|doubleclick\.net|googlesyndication\.com|googleadservices\.com|adservice\.google\.com|facebook\.net|connect\.facebook\.com|segment\.(io|com)|sentry\.io|hotjar\.(com|io)|mixpanel\.com|amplitude\.com|datadoghq\.com|browser-intake-datadoghq\.com|nr-data\.net|newrelic\.com|clarity\.ms|fullstory\.com|heap(analytics)?\.io|intercom\.io|branch\.io|appsflyer\.com|adnxs\.com|criteo\.(com|net)|taboola\.com|outbrain\.com|scorecardresearch\.com|quantserve\.com|bing\.com\/bat|bat\.bing\.com|snapchat\.com|tiktok\.com\/api\/v\d\/pixel|analytics\.)/i;
const TRACKER_PATHS = /\/(collect|beacon|pixel|track|telemetry|log_event|jserror|rum)(\/|\?|$)/i;

const CHALLENGE_HOSTS =
  /(^|\.)(challenges\.cloudflare\.com|captcha-delivery\.com|geo\.captcha-delivery\.com|js\.datadome\.co|api-js\.datadome\.co|perimeterx\.net|px-cdn\.net|px-cloud\.net|px-client\.net|awswaf\.com|token\.awswaf\.com|hcaptcha\.com|recaptcha\.net)$/i;
const CHALLENGE_PATHS =
  /\/cdn-cgi\/challenge-platform\/|\/__challenge_|\/\.well-known\/vercel\/security\/|\/akam\/\d+\/|\/ips\.js(\?|$)|\/149e9513-01fa-4fb0-aad4-566afd725d1b\/|\/challenge\.js(\?|$)|\/recaptcha\/(api|enterprise)|\/turnstile\/v\d\//i;

const SENSOR_HOSTS = /^(d0a7e\.airbnb\.com|k\.twitchcdn\.net)$/i;
const SENSOR_PATHS = /\/(mfc|snk|sensor_data|_bm\/|px\/xhr|api\/v\d\/collector)(\/|\?|$)/i;

const BEACON_HOSTS = /(^|\.)(fundingchoicesmessages\.google\.com|fundingchoices\.google\.com)$/i;
const BEACON_PATHS =
  /\/(weblab|unagi|jitney\/logging|data\/collector|logging|log|logs|events?\/batch|metrics|ping|csp-report|report|uedata|batch\/1\/OE)(\/|\?|$)|\/unagi\/|\/1\/events(\/|\?|$)/i;

const MEDIA_MIME = /^(video\/|audio\/|application\/(dash\+xml|vnd\.apple\.mpegurl|x-mpegurl|mp4))/i;
const MEDIA_EXT = /\.(mpd|m3u8|m4s|m4a|m4v|mp4|webm|mp3|ogg|oga|opus|wav|flac|aac)$/i;
const ASSET_MIME =
  /^(image\/|font\/|text\/css|application\/(wasm|font-|x-font-|vnd\.ms-fontobject)|(application|text)\/(x-)?javascript|application\/ecmascript)/i;
const ASSET_EXT =
  /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|woff2?|ttf|otf|eot|css|wasm|js|mjs|map)$/i;
const ASSET_TYPES = new Set(["Image", "Font", "Stylesheet", "Script", "Manifest", "TextTrack"]);
const MEDIA_TYPES = new Set(["Media"]);

const GRAPHQL_PATH = /\/graphql(\/|\?|$)|\/gql(\/|\?|$)|\/graphql-/i;
const GRAPHQL_HOST = /^gql(-\w+)?\./i;

interface Parsed {
  host: string;
  path: string;
  search: string;
}

function parse(url: string): Parsed | undefined {
  try {
    const parsed = new URL(url);
    return { host: parsed.hostname, path: parsed.pathname, search: parsed.search };
  } catch {
    return undefined;
  }
}

function mimeOf(mime: string | undefined): string {
  return (mime ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

function isTrackerParsed(parsed: Parsed): boolean {
  return TRACKERS.test(parsed.host) || TRACKER_PATHS.test(parsed.path) || isNoiseHost(parsed.host);
}

/** Ad, analytics and error-reporting calls: never part of a site's own API. */
export function isTrackerUrl(url: string): boolean {
  const parsed = parse(url);
  if (!parsed) return true;
  return isTrackerParsed(parsed);
}

function isChallenge(parsed: Parsed): boolean {
  return CHALLENGE_HOSTS.test(parsed.host) || CHALLENGE_PATHS.test(parsed.path);
}

/** A segment that reads as noise: long-ish, mixed case or digits, no words. */
function randomLooking(segment: string): boolean {
  if (segment.length < 6 || !/^[A-Za-z0-9_-]+$/.test(segment)) return false;
  const vowels = (segment.match(/[aeiou]/gi) ?? []).length;
  const mixed = /[a-z]/.test(segment) && /[A-Z]/.test(segment);
  return mixed && vowels / segment.length < 0.25;
}

/** Body that is neither a form nor readable JSON with a few named fields: an encoded blob. */
function opaqueBody(body: string | undefined): boolean {
  if (!body || body.length < 200) return false;
  const trimmed = body.trim();
  if (/^[{[]/.test(trimmed)) {
    const words = trimmed.match(/"[A-Za-z_]{2,24}"\s*:/g) ?? [];
    return words.length <= 2;
  }
  return !/^[\w.%-]+=/.test(trimmed) || !/\s/.test(trimmed.slice(0, 200));
}

function isSensor(parsed: Parsed, facts: RequestFacts): boolean {
  if (SENSOR_HOSTS.test(parsed.host) || SENSOR_PATHS.test(parsed.path)) return true;
  if ((facts.method ?? "GET").toUpperCase() !== "POST") return false;
  const segments = parsed.path.split("/").filter(Boolean);
  const random = segments.filter(randomLooking).length;
  return random >= 1 && random >= segments.length / 2 && opaqueBody(facts.postData);
}

function isBeacon(parsed: Parsed, facts: RequestFacts): boolean {
  if (facts.type === "Ping" || facts.type === "CSPViolationReport") return true;
  return BEACON_HOSTS.test(parsed.host) || BEACON_PATHS.test(parsed.path);
}

function isMedia(parsed: Parsed, mime: string, type: string | undefined): boolean {
  if (MEDIA_MIME.test(mime) || mime === "video/mp2t") return true;
  if (type && MEDIA_TYPES.has(type)) return true;
  if (MEDIA_EXT.test(parsed.path)) return true;
  // .ts is TypeScript as often as an MPEG segment: media only when it is not served as a script.
  return /\.ts$/i.test(parsed.path) && !/script/.test(mime) && type !== "Script";
}

function isApiCall(type: string | undefined): boolean {
  return type === "XHR" || type === "Fetch" || type === "EventSource";
}

function isAsset(parsed: Parsed, mime: string, type: string | undefined): boolean {
  const script = /javascript|ecmascript/.test(mime) || type === "Script";
  // JSONP: a script fetched with a callback is an API answer wrapped in a call.
  if (script && /[?&](callback|jsonp|cb)=/i.test(parsed.search)) return false;
  if (ASSET_MIME.test(mime)) return !(isApiCall(type) && script);
  if (type && ASSET_TYPES.has(type)) return true;
  return !mime.includes("json") && ASSET_EXT.test(parsed.path);
}

function isGraphql(parsed: Parsed, facts: RequestFacts): boolean {
  if (GRAPHQL_PATH.test(parsed.path) || GRAPHQL_HOST.test(parsed.host)) return true;
  if (
    /[?&](query|operationName|extensions)=/.test(parsed.search) &&
    /persistedQuery|operationName/i.test(decodeSafe(parsed.search))
  )
    return true;
  const body = facts.postData?.trimStart();
  if (!body || !/^[{[]/.test(body)) return false;
  return (
    /"(operationName|query)"\s*:\s*"/.test(body) &&
    /("query"\s*:\s*"\s*(query|mutation|subscription|\{|fragment))|"operationName"/.test(body)
  );
}

function decodeSafe(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function isDocument(mime: string, type: string | undefined): boolean {
  if (type === "Document") return true;
  // An HTML fragment fetched by script is an API answer; HTML loaded any other way is a page.
  return mime === "text/html" && !isApiCall(type);
}

/** Which kind of request this is. Plumbing is checked first, so only real calls are "api". */
export function classifyRequest(facts: RequestFacts): RequestClass {
  const parsed = parse(facts.url);
  if (!parsed) return "tracker";
  const mime = mimeOf(facts.mime);
  const type = facts.type;
  if (isChallenge(parsed)) return "challenge";
  if (isSensor(parsed, facts)) return "sensor";
  if (TRACKERS.test(parsed.host) || TRACKER_PATHS.test(parsed.path)) return "tracker";
  if (isBeacon(parsed, facts)) return "beacon";
  if (isNoiseHost(parsed.host)) return "tracker";
  if (isMedia(parsed, mime, type)) return "media";
  if (isAsset(parsed, mime, type)) return "asset";
  if (isDocument(mime, type)) return "document";
  if (isGraphql(parsed, facts)) return "graphql";
  return "api";
}

export function isApiLikeClass(cls: RequestClass): boolean {
  return cls === "api" || cls === "graphql";
}

/** `"api"`, `["api", "graphql"]`: the classes a filter asks for, or undefined for any. */
export function classFilter(wanted: unknown): ((cls: RequestClass) => boolean) | undefined {
  const items = (Array.isArray(wanted) ? wanted : [wanted]).filter(
    (item): item is RequestClass =>
      typeof item === "string" && (REQUEST_CLASSES as readonly string[]).includes(item),
  );
  if (!items.length) return undefined;
  const set = new Set(items);
  return (cls) => set.has(cls);
}

/** The facts a recorded entry offers, in the shape classifyRequest reads. */
export function classOfEntry(entry: {
  url: string;
  type?: string;
  mimeType?: string;
  method?: string;
  status?: number;
  requestBody?: string;
  initiator?: { url?: string };
}): RequestClass {
  return classifyRequest({
    url: entry.url,
    ...(entry.type !== undefined ? { type: entry.type } : {}),
    ...(entry.mimeType !== undefined ? { mime: entry.mimeType } : {}),
    ...(entry.method !== undefined ? { method: entry.method } : {}),
    ...(entry.status !== undefined ? { status: entry.status } : {}),
    ...(entry.requestBody !== undefined ? { postData: entry.requestBody } : {}),
    ...(entry.initiator?.url ? { initiator: entry.initiator.url } : {}),
  });
}

// Page claws: typed form schemas (page.forms), WebMCP detection, asset-stripped turbo tabs,
// fresh CSRF / persisted-query token harvesting, and region/device emulation with a clean reset.
// Nothing here runs until called: no listener, no domain enable, no prompt text. The builders
// below are pure and self-contained, embedded into the sandbox by source so tests run them too.

export interface FieldDescriptor {
  name: string;
  tag: string;
  type: string;
  label?: string;
  required?: boolean;
  multiple?: boolean;
  value?: string;
  checked?: boolean;
  placeholder?: string;
  pattern?: string;
  min?: string;
  max?: string;
  minLength?: number;
  maxLength?: number;
  options?: { value: string; label: string }[];
}

export interface FormDescriptor {
  id?: string;
  name?: string;
  action?: string;
  method?: string;
  where?: string;
  fields: FieldDescriptor[];
}

export interface JsonSchema {
  [key: string]: unknown;
}

const FIELD_FORMATS: Record<string, string> = {
  email: "email",
  url: "uri",
  date: "date",
  "datetime-local": "date-time",
  time: "time",
  tel: "tel",
  color: "color",
  month: "month",
  week: "week",
  password: "password",
};

function clawBounds(field: FieldDescriptor, schema: JsonSchema, numeric: boolean): void {
  if (numeric && field.min) schema.minimum = Number(field.min);
  if (numeric && field.max) schema.maximum = Number(field.max);
  if (field.minLength !== undefined) schema.minLength = field.minLength;
  if (field.maxLength !== undefined) schema.maxLength = field.maxLength;
  if (field.pattern) schema.pattern = field.pattern;
}

function clawScalarSchema(field: FieldDescriptor): JsonSchema {
  if (field.type === "checkbox") return { type: "boolean" };
  if (field.type === "file")
    return field.multiple
      ? { type: "array", items: { type: "string", format: "path" } }
      : { type: "string", format: "path" };
  const numeric = field.type === "number" || field.type === "range";
  const schema: JsonSchema = { type: numeric ? "number" : "string" };
  const format = FIELD_FORMATS[field.type];
  if (format) schema.format = format;
  clawBounds(field, schema, numeric);
  return schema;
}

function clawChoiceSchema(field: FieldDescriptor): JsonSchema {
  const options = field.options ?? [];
  const values = options.map((option) => option.value);
  const one: JsonSchema = { type: "string", enum: values };
  if (options.some((option) => option.label !== option.value))
    one["x-labels"] = options.map((option) => option.label);
  return field.multiple ? { type: "array", items: one, uniqueItems: true } : one;
}

function clawDefault(field: FieldDescriptor, schema: JsonSchema): void {
  if (field.type === "checkbox") {
    if (field.checked) schema.default = true;
  } else if (field.type === "radio") {
    if (field.checked) schema.default = field.value;
  } else if (field.value) schema.default = field.multiple ? [field.value] : field.value;
}

function clawFieldSchema(field: FieldDescriptor): JsonSchema {
  const isChoice = field.tag === "select" || field.type === "radio";
  const schema = isChoice ? clawChoiceSchema(field) : clawScalarSchema(field);
  if (field.label) schema.title = field.label;
  if (field.placeholder) schema.description = field.placeholder;
  clawDefault(field, schema);
  return schema;
}

/** A radio group arrives as one field per button: fold a later button into the first one's enum. */
function clawMergeRadio(prior: JsonSchema | undefined, field: FieldDescriptor): boolean {
  if (field.type !== "radio" || !prior || !Array.isArray(prior.enum)) return false;
  (prior.enum as string[]).push(...(field.options ?? []).map((option) => option.value));
  if (field.checked) prior.default = field.value;
  return true;
}

function clawFormMeta(form: FormDescriptor): JsonSchema {
  const meta: JsonSchema = { method: (form.method || "get").toLowerCase() };
  if (form.action) meta.action = form.action;
  if (form.where) meta.where = form.where;
  return meta;
}

/** One form as JSON Schema: typed properties, required list, enums, and hidden defaults kept apart. */
export function formSchemaOf(form: FormDescriptor): JsonSchema {
  const skip = new Set(["submit", "button", "reset", "image"]);
  const properties: Record<string, JsonSchema> = {};
  const required = new Set<string>();
  const hidden: Record<string, string> = {};
  for (const field of form.fields) {
    if (!field.name || skip.has(field.type)) continue;
    if (field.type === "hidden") {
      hidden[field.name] = field.value ?? "";
      continue;
    }
    if (!clawMergeRadio(properties[field.name], field))
      properties[field.name] = clawFieldSchema(field);
    if (field.required) required.add(field.name);
  }
  const out: JsonSchema = { type: "object", properties, required: [...required] };
  if (form.id || form.name) out.title = form.id || form.name;
  out["x-form"] = clawFormMeta(form);
  if (Object.keys(hidden).length) out["x-hidden"] = hidden;
  return out;
}

export interface TokenSources {
  metas: { name: string; content: string }[];
  inputs: { name: string; value: string; form?: string }[];
  cookies: string;
  urls: string[];
  headers: Record<string, string>[];
  globals?: Record<string, string>;
}

export interface Harvest {
  csrf: { source: string; name: string; value: string }[];
  persistedQueries: { operationName: string; sha256Hash: string; url: string }[];
  headers: Record<string, string>;
}

const CLAW_TOKEN_NAME =
  /(csrf|xsrf|_token$|^token$|authenticity|nonce|requestverification|anti-?forgery)/i;

function clawHeaderTokens(sets: Record<string, string>[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const set of sets)
    for (const [name, value] of Object.entries(set)) {
      const lower = name.toLowerCase();
      if (CLAW_TOKEN_NAME.test(lower) && !headers[lower]) headers[lower] = value;
    }
  return headers;
}

function clawCookieTokens(cookies: string): [string, string][] {
  const out: [string, string][] = [];
  for (const part of cookies.split(";")) {
    const at = part.indexOf("=");
    const name = part.slice(0, at).trim();
    if (at <= 0 || !CLAW_TOKEN_NAME.test(name)) continue;
    const raw = part.slice(at + 1).trim();
    let value = raw;
    try {
      value = decodeURIComponent(raw);
    } catch {
      value = raw;
    }
    out.push([name, value]);
  }
  return out;
}

function clawPersistedQuery(url: string): Harvest["persistedQueries"][number] | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const raw = parsed.searchParams.get("extensions") ?? "";
  const match = /"sha256Hash"\s*:\s*"([0-9a-f]{64})"/i.exec(raw);
  if (!match) return undefined;
  const operationName =
    parsed.searchParams.get("operationName") || parsed.pathname.split("/").pop() || "";
  return {
    operationName,
    sha256Hash: (match[1] ?? "").toLowerCase(),
    url: parsed.origin + parsed.pathname,
  };
}

function clawPersistedQueries(urls: string[]): Harvest["persistedQueries"] {
  const out: Harvest["persistedQueries"] = [];
  const seen = new Set<string>();
  for (const url of urls) {
    const query = clawPersistedQuery(url);
    if (!query || seen.has(query.sha256Hash)) continue;
    seen.add(query.sha256Hash);
    out.push(query);
  }
  return out;
}

/** Fresh CSRF/XSRF/nonce tokens and GraphQL persisted-query hashes, newest source first, deduplicated. */
export function harvestTokensOf(sources: TokenSources): Harvest {
  const csrf: Harvest["csrf"] = [];
  const seen = new Set<string>();
  const add = (source: string, name: string, value: string): void => {
    if (!value || value.length > 4096 || seen.has(source + "|" + name)) return;
    seen.add(source + "|" + name);
    csrf.push({ source, name, value });
  };
  const headers = clawHeaderTokens(sources.headers);
  for (const [name, value] of Object.entries(headers)) add("header", name, value);
  for (const meta of sources.metas)
    if (CLAW_TOKEN_NAME.test(meta.name)) add("meta", meta.name, meta.content);
  for (const [name, value] of clawCookieTokens(sources.cookies)) add("cookie", name, value);
  for (const input of sources.inputs)
    if (CLAW_TOKEN_NAME.test(input.name)) add("input", input.name, input.value);
  for (const [name, value] of Object.entries(sources.globals ?? {})) add("global", name, value);
  const first = csrf[0];
  if (first && !Object.keys(headers).some((name) => /csrf|xsrf/.test(name)))
    headers["x-csrf-token"] = first.value;
  return { csrf, persistedQueries: clawPersistedQueries(sources.urls), headers };
}

export interface TurboOptions {
  images?: boolean;
  media?: boolean;
  fonts?: boolean;
  trackers?: boolean;
  styles?: boolean;
  extra?: string[];
  allow?: string[];
}

/** The Network.setBlockedURLs patterns for a turbo tab: heavy assets and common trackers. */
export function turboPatternsOf(options: TurboOptions = {}): string[] {
  const groups: [boolean, string[]][] = [
    [options.images !== false, ["png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "bmp", "svg"]],
    [options.media !== false, ["mp4", "webm", "m4s", "mp3", "ogg", "wav", "m3u8", "mpd", "mov"]],
    [options.fonts !== false, ["woff", "woff2", "ttf", "otf", "eot"]],
    [options.styles === true, ["css"]],
  ];
  const patterns: string[] = [];
  for (const [on, extensions] of groups)
    if (on) for (const ext of extensions) patterns.push("*." + ext, "*." + ext + "?*");
  if (options.trackers !== false)
    patterns.push(
      "*google-analytics.com*",
      "*googletagmanager.com*",
      "*doubleclick.net*",
      "*facebook.net*",
      "*connect.facebook.com*",
      "*hotjar.com*",
      "*segment.io*",
      "*cdn.segment.com*",
      "*mixpanel.com*",
      "*amplitude.com*",
      "*clarity.ms*",
      "*fullstory.com*",
      "*sentry.io*",
      "*newrelic.com*",
      "*nr-data.net*",
      "*adservice.google.*",
    );
  patterns.push(...(options.extra ?? []).map(String));
  const allow = new Set((options.allow ?? []).map(String));
  return [...new Set(patterns)].filter((pattern) => !allow.has(pattern));
}

export interface EmulateOptions {
  locale?: string;
  timezoneId?: string;
  timezone?: string;
  geolocation?: { latitude: number; longitude: number; accuracy?: number };
  viewport?: { width: number; height: number; scale?: number };
  mobile?: boolean;
  userAgent?: string;
  colorScheme?: string;
}

type CdpPlan = [string, Record<string, unknown>][];

function clawBad(what: string): never {
  throw new Error("INVALID_INPUT: page.emulate " + what);
}

function clawRegionPlan(options: EmulateOptions, plan: CdpPlan): void {
  const timezoneId = options.timezoneId ?? options.timezone;
  if (timezoneId !== undefined) {
    if (!/^(UTC|[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+)$/.test(String(timezoneId)))
      clawBad("timezoneId must be an IANA name like Europe/Berlin");
    plan.push(["Emulation.setTimezoneOverride", { timezoneId: String(timezoneId) }]);
  }
  if (options.locale !== undefined) {
    if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(String(options.locale)))
      clawBad("locale must be a BCP 47 tag like de-DE");
    plan.push(["Emulation.setLocaleOverride", { locale: String(options.locale) }]);
  }
  const geo = options.geolocation;
  if (!geo) return;
  const latitude = Number(geo.latitude);
  const longitude = Number(geo.longitude);
  if (!(Math.abs(latitude) <= 90) || !(Math.abs(longitude) <= 180))
    clawBad("geolocation needs latitude -90..90 and longitude -180..180");
  plan.push([
    "Emulation.setGeolocationOverride",
    { latitude, longitude, accuracy: Number(geo.accuracy ?? 50) },
  ]);
}

function clawDevicePlan(options: EmulateOptions, plan: CdpPlan): void {
  if (!options.viewport && options.mobile === undefined) return;
  const mobile = options.mobile === true;
  const fallback = mobile
    ? { width: 390, height: 844, scale: 3 }
    : { width: 1280, height: 800, scale: 1 };
  const view = { ...fallback, ...options.viewport };
  const width = Math.round(Number(view.width));
  const height = Math.round(Number(view.height));
  if (!(width >= 200 && width <= 7680 && height >= 200 && height <= 4320))
    clawBad("viewport needs width 200..7680 and height 200..4320");
  const deviceScaleFactor = Number(view.scale);
  plan.push(["Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor, mobile }]);
  plan.push(["Emulation.setTouchEmulationEnabled", { enabled: mobile }]);
}

/** CDP calls for an emulation request, in order; throws INVALID_INPUT on a bad value. */
export function emulationPlanOf(options: EmulateOptions): CdpPlan {
  const plan: CdpPlan = [];
  clawRegionPlan(options, plan);
  clawDevicePlan(options, plan);
  if (options.userAgent) {
    const params: Record<string, unknown> = { userAgent: String(options.userAgent) };
    if (options.locale) params.acceptLanguage = String(options.locale);
    plan.push(["Emulation.setUserAgentOverride", params]);
  }
  if (options.colorScheme)
    plan.push([
      "Emulation.setEmulatedMedia",
      { features: [{ name: "prefers-color-scheme", value: String(options.colorScheme) }] },
    ]);
  return plan;
}

/** CDP calls that undo every override emulationPlanOf can set. */
export function resetPlanOf(): CdpPlan {
  return [
    ["Emulation.clearDeviceMetricsOverride", {}],
    ["Emulation.setTouchEmulationEnabled", { enabled: false }],
    ["Emulation.setUserAgentOverride", { userAgent: "" }],
    ["Emulation.setEmulatedMedia", { features: [] }],
    ["Emulation.setTimezoneOverride", { timezoneId: "" }],
    ["Emulation.setLocaleOverride", {}],
    ["Emulation.clearGeolocationOverride", {}],
  ];
}

export const browserClawsApi = `
var FIELD_FORMATS = ${JSON.stringify(FIELD_FORMATS)};
var CLAW_TOKEN_NAME = ${CLAW_TOKEN_NAME.toString()};
${[clawBounds, clawScalarSchema, clawChoiceSchema, clawDefault, clawFieldSchema, clawMergeRadio, clawFormMeta, formSchemaOf, clawHeaderTokens, clawCookieTokens, clawPersistedQuery, clawPersistedQueries, harvestTokensOf, turboPatternsOf, clawBad, clawRegionPlan, clawDevicePlan, emulationPlanOf, resetPlanOf].map((fn) => fn.toString()).join("\n")}
var __turboState = new Map();
// Page side: every form (and formless fields), piercing open shadow roots, in one pass.
function __clawFormsCollect(arg) {
  var roots = [document], all = [];
  while (roots.length) { var root = roots.pop(); all.push(...root.querySelectorAll('input,select,textarea')); for (var el of root.querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot); }
  var labelOf = (el) => {
    var text = el.labels && el.labels[0] ? el.labels[0].innerText : '';
    if (!text && el.getAttribute('aria-labelledby')) text = el.getAttribute('aria-labelledby').split(/\\s+/).map((id) => (el.getRootNode().getElementById?.(id) || document.getElementById(id))?.innerText || '').join(' ');
    text = text || el.getAttribute('aria-label') || el.closest('label')?.innerText || el.title || '';
    return String(text).replace(/\\s+/g, ' ').trim().slice(0, 200);
  };
  var groups = new Map();
  for (var field of all) {
    if (field.disabled && arg.disabled !== true) continue;
    var form = field.form || null, key = form || 'page';
    if (!groups.has(key)) groups.set(key, {id: form?.id || undefined, name: form?.getAttribute('name') || undefined, action: form?.action || undefined, method: form?.method || 'get', where: form ? undefined : 'no form', fields: []});
    var type = field.tagName === 'INPUT' ? (field.type || 'text') : field.tagName.toLowerCase();
    var row = {name: field.name || field.id, tag: field.tagName.toLowerCase(), type, label: labelOf(field) || undefined, required: field.required || field.getAttribute('aria-required') === 'true', multiple: !!field.multiple, placeholder: field.placeholder || undefined, pattern: field.pattern || undefined, min: field.min || undefined, max: field.max || undefined, minLength: field.minLength > 0 ? field.minLength : undefined, maxLength: field.maxLength > 0 ? field.maxLength : undefined};
    if (field.tagName === 'SELECT') { row.options = [...field.options].map((o) => ({value: o.value, label: o.text.trim()})); row.value = field.value; }
    else if (type === 'radio') { row.options = [{value: field.value, label: labelOf(field) || field.value}]; row.value = field.value; row.checked = field.checked; }
    else if (type === 'checkbox') row.checked = field.checked;
    else if (type !== 'password' && type !== 'file') row.value = field.value;
    groups.get(key).fields.push(row);
  }
  return [...groups.values()].filter((group) => group.fields.length).slice(0, 50);
}
// Page side: where rotating tokens live right now.
function __clawTokensCollect() {
  var metas = [...document.querySelectorAll('meta[name],meta[property]')].map((m) => ({name: m.getAttribute('name') || m.getAttribute('property') || '', content: m.content || ''}));
  var inputs = [...document.querySelectorAll('input[type=hidden][name]')].map((i) => ({name: i.name, value: i.value, form: i.form?.id || undefined}));
  var urls = performance.getEntriesByType('resource').map((entry) => entry.name).filter((url) => /sha256Hash/.test(url)).slice(-200);
  var globals = {};
  for (var name of ['csrfToken', '_csrf', 'CSRF_TOKEN', 'csrf_token']) if (typeof window[name] === 'string') globals[name] = window[name];
  return {metas, inputs, cookies: document.cookie || '', urls, headers: [], globals};
}
async function __clawTokens(target) {
  var raw = await browser.page(target).inspect(__clawTokensCollect);
  var entries = await browser.page(target).network.list({}).catch(() => []);
  var list = Array.isArray(entries) ? entries : (entries && entries.entries) || [];
  for (var entry of list.slice(-200).reverse()) {
    if (entry && entry.requestHeaders) raw.headers.push(entry.requestHeaders);
    if (entry && entry.url && /sha256Hash/.test(entry.url)) raw.urls.push(entry.url);
  }
  return harvestTokensOf(raw);
}
async function __clawTurbo(target, options) {
  var page = browser.page(target), key = __key(target);
  if (options === false || (options && options.off)) {
    var prior = __turboState.get(key);
    __turboState.delete(key);
    await page.cdp('Network.setBlockedURLs', {urls: prior ? prior.before : []});
    return {turbo: false, restored: prior ? prior.before.length : 0};
  }
  var urls = turboPatternsOf(options && typeof options === 'object' ? options : {});
  var before = __turboState.has(key) ? __turboState.get(key).before : [];
  await page.cdp('Network.setBlockedURLs', {urls: before.concat(urls)});
  __turboState.set(key, {before, urls});
  return {turbo: true, blocked: urls.length};
}
async function __clawEmulate(target, options, base) {
  if (options.device || options.reset || options.reload !== undefined) return base(options);
  var page = browser.page(target), plan = emulationPlanOf(options);
  if (!plan.length) throw Error('INVALID_INPUT: page.emulate needs locale, timezoneId, geolocation, viewport, mobile, userAgent, colorScheme or device');
  if (options.geolocation) await __call({permission:'set', target, type:'location', setting:'allow'}).catch(() => {});
  for (var [method, params] of plan) await page.cdp(method, params);
  return {emulated: plan.map((step) => step[0].replace('Emulation.', ''))};
}
async function __clawReset(target) {
  var page = browser.page(target);
  for (var [method, params] of resetPlanOf()) await page.cdp(method, params).catch(() => {});
  return {reset: true};
}
function __extendPageClaws(target, base) {
  var emulate = base.emulate, abortClear = base.abortClear;
  return Object.assign(base, {
    // Every form as typed JSON Schema in one pass: {forms: [{type, properties, required, x-form, x-hidden}]}.
    forms: async (options = {}) => ({forms: (await browser.page(target).inspect(__clawFormsCollect, options || {})).map(formSchemaOf)}),
    // The page's native WebMCP tools (document.modelContext / navigator.modelContext), if it has any.
    modelContext: () => browser.page(target).inspect(__pageWebmcpList),
    // Block images, media, fonts and trackers in this tab (turbo(false) restores what was blocked before).
    turbo: (options = {}) => __clawTurbo(target, options),
    // Fresh CSRF/XSRF tokens and GraphQL persisted-query hashes: {csrf, persistedQueries, headers}.
    tokens: () => __clawTokens(target),
    // {locale, timezoneId, geolocation, viewport, mobile, userAgent, colorScheme} or {device}.
    emulate: (options = {}) => __clawEmulate(target, options || {}, emulate),
    resetEmulation: () => __clawReset(target),
    abortClear: async () => { __turboState.delete(__key(target)); return abortClear(); },
    setFiles: (selector, files) => base.upload(selector, files),
  });
}
`;

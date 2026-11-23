// Page claws: form schemas, token harvest, turbo patterns, emulation plans, upload errors, and the
// sandbox wiring, all against plain descriptors and a fake browser: no Chrome, no model.
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import {
  browserClawsApi,
  emulationPlanOf,
  formSchemaOf,
  harvestTokensOf,
  resetPlanOf,
  turboPatternsOf,
} from "../dist/code-api-claws.js";
import { fileInputExpression, fileInputProblem } from "../dist/native-browser-frames.js";

const signup = {
  id: "signup",
  action: "https://example.test/join",
  method: "POST",
  fields: [
    { name: "email", tag: "input", type: "email", label: "Email", required: true, value: "" },
    { name: "age", tag: "input", type: "number", min: "18", max: "120", value: "30" },
    { name: "bio", tag: "textarea", type: "textarea", maxLength: 200, placeholder: "About you" },
    {
      name: "plan",
      tag: "select",
      type: "select",
      required: true,
      value: "pro",
      options: [
        { value: "free", label: "Free" },
        { value: "pro", label: "Pro" },
      ],
    },
    {
      name: "size",
      tag: "input",
      type: "radio",
      value: "s",
      checked: false,
      options: [{ value: "s", label: "Small" }],
    },
    {
      name: "size",
      tag: "input",
      type: "radio",
      value: "l",
      checked: true,
      required: true,
      options: [{ value: "l", label: "Large" }],
    },
    { name: "terms", tag: "input", type: "checkbox", checked: true, required: true },
    { name: "cv", tag: "input", type: "file", multiple: true },
    { name: "csrf", tag: "input", type: "hidden", value: "tok123" },
    { name: "go", tag: "input", type: "submit", value: "Join" },
  ],
};

test("a form becomes typed JSON Schema with required, enums, defaults and hidden values", () => {
  const schema = formSchemaOf(signup);
  assert.equal(schema.title, "signup");
  assert.deepEqual(schema["x-form"], { method: "post", action: "https://example.test/join" });
  assert.deepEqual(schema["x-hidden"], { csrf: "tok123" });
  const p = schema.properties;
  assert.deepEqual(p.email, { type: "string", format: "email", title: "Email" });
  assert.deepEqual(p.age, { type: "number", minimum: 18, maximum: 120, default: "30" });
  assert.deepEqual(p.bio, { type: "string", maxLength: 200, description: "About you" });
  assert.deepEqual(p.plan, {
    type: "string",
    enum: ["free", "pro"],
    "x-labels": ["Free", "Pro"],
    default: "pro",
  });
  assert.deepEqual(p.size.enum, ["s", "l"]);
  assert.equal(p.size.default, "l");
  assert.deepEqual(p.terms, { type: "boolean", default: true });
  assert.deepEqual(p.cv, { type: "array", items: { type: "string", format: "path" } });
  assert.ok(!("go" in p) && !("csrf" in p));
  assert.deepEqual(schema.required, ["email", "plan", "size", "terms"]);
});

test("the same form always gives the same schema", () => {
  assert.deepEqual(formSchemaOf(signup), formSchemaOf(structuredClone(signup)));
  assert.deepEqual(formSchemaOf({ fields: [] }), {
    type: "object",
    properties: {},
    required: [],
    "x-form": { method: "get" },
  });
});

test("tokens come from headers, metas, cookies, hidden inputs and globals, deduplicated", () => {
  const hash = "a".repeat(64);
  const harvest = harvestTokensOf({
    metas: [
      { name: "csrf-token", content: "meta1" },
      { name: "viewport", content: "x" },
    ],
    inputs: [
      { name: "authenticity_token", value: "form1" },
      { name: "q", value: "no" },
    ],
    cookies: "sid=1; XSRF-TOKEN=c%3D1; theme=dark",
    urls: [
      `https://api.test/graphql?operationName=Feed&extensions=${encodeURIComponent(JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } }))}`,
      `https://api.test/graphql?operationName=Feed&extensions=${encodeURIComponent(JSON.stringify({ persistedQuery: { sha256Hash: hash } }))}`,
      "not a url",
    ],
    headers: [{ "X-CSRF-Token": "hdr-new", Accept: "*/*" }, { "x-csrf-token": "hdr-old" }],
    globals: { csrfToken: "g1" },
  });
  assert.deepEqual(
    harvest.csrf.map((t) => [t.source, t.name, t.value]),
    [
      ["header", "x-csrf-token", "hdr-new"],
      ["meta", "csrf-token", "meta1"],
      ["cookie", "XSRF-TOKEN", "c=1"],
      ["input", "authenticity_token", "form1"],
      ["global", "csrfToken", "g1"],
    ],
  );
  assert.deepEqual(harvest.headers, { "x-csrf-token": "hdr-new" });
  assert.deepEqual(harvest.persistedQueries, [
    { operationName: "Feed", sha256Hash: hash, url: "https://api.test/graphql" },
  ]);
});

test("with no header token the first found token is offered as x-csrf-token", () => {
  const harvest = harvestTokensOf({
    metas: [{ name: "csrf-token", content: "m" }],
    inputs: [],
    cookies: "bad=%E0",
    urls: [],
    headers: [],
  });
  assert.deepEqual(harvest.headers, { "x-csrf-token": "m" });
});

test("turbo blocks images, media, fonts and trackers by default, and honours opt-outs", () => {
  const all = turboPatternsOf();
  for (const pattern of ["*.png", "*.jpg?*", "*.mp4", "*.woff2", "*google-analytics.com*"])
    assert.ok(all.includes(pattern), pattern);
  assert.ok(!all.includes("*.css"));
  assert.equal(new Set(all).size, all.length);
  const some = turboPatternsOf({
    images: false,
    trackers: false,
    styles: true,
    extra: ["*ads.test*"],
    allow: ["*.woff"],
  });
  assert.ok(!some.includes("*.png") && !some.includes("*hotjar.com*") && !some.includes("*.woff"));
  assert.ok(some.includes("*.css") && some.includes("*ads.test*") && some.includes("*.woff2"));
});

test("emulation plans the CDP calls in order and rejects bad values", () => {
  const plan = emulationPlanOf({
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
    geolocation: { latitude: 52.5, longitude: 13.4 },
    mobile: true,
    userAgent: "UA",
  });
  assert.deepEqual(
    plan.map(([method]) => method),
    [
      "Emulation.setTimezoneOverride",
      "Emulation.setLocaleOverride",
      "Emulation.setGeolocationOverride",
      "Emulation.setDeviceMetricsOverride",
      "Emulation.setTouchEmulationEnabled",
      "Emulation.setUserAgentOverride",
    ],
  );
  assert.deepEqual(plan[3][1], { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  assert.deepEqual(plan[5][1], { userAgent: "UA", acceptLanguage: "de-DE" });
  assert.deepEqual(emulationPlanOf({ timezone: "UTC" }), [
    ["Emulation.setTimezoneOverride", { timezoneId: "UTC" }],
  ]);
  assert.throws(() => emulationPlanOf({ timezoneId: "Mars" }), /INVALID_INPUT.*IANA/);
  assert.throws(() => emulationPlanOf({ locale: "German" }), /INVALID_INPUT.*BCP 47/);
  assert.throws(
    () => emulationPlanOf({ geolocation: { latitude: 99, longitude: 0 } }),
    /INVALID_INPUT/,
  );
  assert.throws(() => emulationPlanOf({ viewport: { width: 10, height: 10 } }), /INVALID_INPUT/);
  assert.deepEqual(emulationPlanOf({}), []);
});

test("reset undoes every override the plan can set", () => {
  const reset = new Set(resetPlanOf().map(([method]) => method));
  for (const method of [
    "Emulation.clearGeolocationOverride",
    "Emulation.setTimezoneOverride",
    "Emulation.setLocaleOverride",
    "Emulation.clearDeviceMetricsOverride",
    "Emulation.setUserAgentOverride",
  ])
    assert.ok(reset.has(method), method);
});

test("file inputs report why they cannot take the files", () => {
  assert.equal(fileInputProblem({ type: "file", multiple: false, disabled: false }, 1), undefined);
  assert.match(
    fileInputProblem({ type: "text", multiple: false, disabled: false }, 1),
    /type=text/,
  );
  assert.match(fileInputProblem({ type: "file", multiple: false, disabled: true }, 1), /disabled/);
  assert.match(
    fileInputProblem({ type: "file", multiple: false, disabled: false }, 2),
    /one file, 2 given/,
  );
  assert.match(fileInputProblem({ type: "file", multiple: true, disabled: false }, 0), /no files/);
  // The finder is valid script that pierces open shadow roots and styled labels.
  const source = fileInputExpression("#drop");
  assert.doesNotThrow(() => new Function(source));
  assert.match(source, /shadowRoot/);
  assert.match(source, /htmlFor/);
});

const plain = (value) => JSON.parse(JSON.stringify(value));

function sandbox(inspectAnswer) {
  const cdp = [];
  const calls = [];
  const base = {
    emulate: async (options) => ({ base: options }),
    abortClear: async () => ({ cleared: true }),
    upload: async (selector, files) => ({ selector, files }),
  };
  const page = {
    inspect: async (fn) => inspectAnswer(fn.name),
    cdp: async (method, params) => (cdp.push([method, params]), {}),
    network: {
      list: async () => [{ url: "https://x.test/", requestHeaders: { "X-XSRF-TOKEN": "net" } }],
    },
  };
  const context = vm.createContext({
    browser: { page: () => page },
    __key: (target) => String(target),
    __call: async (request) => (calls.push(request), {}),
    __pageWebmcpList: function __pageWebmcpList() {},
    URL,
    performance,
  });
  vm.runInContext(browserClawsApi, context);
  const extended = vm.runInContext("__extendPageClaws", context)("t1", base);
  return { page: extended, cdp, calls };
}

test("the sandbox page gains forms, tokens, turbo, emulate, resetEmulation and setFiles lazily", async () => {
  const { page, cdp, calls } = sandbox((name) =>
    name === "__clawFormsCollect"
      ? [signup]
      : name === "__clawTokensCollect"
        ? { metas: [], inputs: [], cookies: "", urls: [], headers: [], globals: {} }
        : { available: false, tools: [] },
  );
  assert.equal(cdp.length, 0, "extending the page sends nothing");
  const { forms } = await page.forms();
  assert.equal(forms[0].properties.plan.default, "pro");
  assert.deepEqual((await page.modelContext()).available, false);
  const tokens = await page.tokens();
  assert.deepEqual(JSON.parse(JSON.stringify(tokens.csrf)), [
    { source: "header", name: "x-xsrf-token", value: "net" },
  ]);

  const on = await page.turbo();
  assert.equal(on.turbo, true);
  assert.equal(cdp.at(-1)[0], "Network.setBlockedURLs");
  assert.ok(cdp.at(-1)[1].urls.includes("*.png"));
  assert.deepEqual(plain(await page.turbo(false)), { turbo: false, restored: 0 });
  assert.deepEqual(plain(cdp.at(-1)[1]), { urls: [] });

  const emulated = await page.emulate({
    timezoneId: "Asia/Tokyo",
    geolocation: { latitude: 35.6, longitude: 139.7 },
  });
  assert.deepEqual(plain(emulated.emulated), ["setTimezoneOverride", "setGeolocationOverride"]);
  assert.equal(calls[0].permission, "set");
  assert.deepEqual(JSON.parse(JSON.stringify(await page.emulate({ device: "iphone" }))), {
    base: { device: "iphone" },
  });
  await assert.rejects(page.emulate({}), /INVALID_INPUT/);
  cdp.length = 0;
  assert.deepEqual(plain(await page.resetEmulation()), { reset: true });
  assert.equal(cdp.length, resetPlanOf().length);
  assert.deepEqual(JSON.parse(JSON.stringify(await page.setFiles("#cv", ["a.pdf"]))), {
    selector: "#cv",
    files: ["a.pdf"],
  });
});

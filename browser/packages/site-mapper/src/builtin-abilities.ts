// Abilities Aeon ships with, on sites everyone uses: ask an AI site on the user's own account,
// make or edit an image with Gemini, ask Gemini about a video, read an X thread, research X.
// They are ordinary abilities (listed, run with site.run, shown on the site page); their code is
// written for each call from the inputs, so a prompt is never spliced into code by hand. A
// stored ability with the same name replaces the built-in one.

import type { Ability, AbilityWayScript } from "./abilities.js";
import {
  PROVIDERS,
  imagePrompt,
  imageScript,
  uiScript,
  youtubePrompt,
  type ProviderId,
} from "./providers.js";
import { xResearchCode, xThreadCode } from "./builtin-x.js";

type Inputs = Record<string, unknown>;

interface Builtin {
  site: string;
  name: string;
  description: string;
  inputs: Record<string, unknown>;
  required: string[];
  outputs?: Record<string, unknown>;
  /** Browser code: an async (page, bu, args) => result function, for these inputs. */
  code: (inputs: Inputs) => string;
}

const ASK_INPUTS = {
  prompt: { type: "string", description: "What to ask" },
  model: { type: "string", description: "A model the site offers (default: the site's own)" },
  files: { type: "array", items: { type: "string" }, description: "Workspace files to attach" },
  withPage: {
    description: "true (the current page) or a tab id: its text goes with the prompt",
  },
  conversation: { type: "string", description: "A conversation URL from an earlier answer" },
  timeoutMs: { type: "number", description: "How long to wait for the answer (max 300000)" },
};

const ANSWER = {
  type: "object",
  properties: {
    text: { type: "string" },
    conversation: { type: "string" },
    applied: { type: "array" },
    skipped: { type: "array" },
  },
};

/** Site-specific options: how each one is applied, so the answer says which were. */
const EXTRA_INPUTS: Partial<Record<ProviderId, Record<string, unknown>>> = {
  chatgpt: {
    effort: {
      enum: ["pro", "thinking", "instant"],
      description: "pro: the slowest, most careful answer (minutes); give timeoutMs 300000",
    },
  },
  perplexity: {
    mode: { enum: ["search", "research"], description: "research: Perplexity's deep research" },
  },
  grok: { deepSearch: { type: "boolean", description: "Grok's DeepSearch (slower, sourced)" } },
  kimi: { mode: { enum: ["chat", "researcher"], description: "researcher: Kimi's deep research" } },
};

// A mode the site switches with one of its own buttons, found by its visible name.
const MODE_BUTTONS: Record<string, string> = {
  "perplexity:mode:research": "research|deep research",
  "grok:deepSearch:true": "deep ?search",
  "kimi:mode:researcher": "researcher|deep research",
};

const CHATGPT_EFFORT_MODELS: Record<string, string> = {
  pro: "gpt-5-pro",
  thinking: "gpt-5-thinking",
  instant: "gpt-5-instant",
};

function chatUrl(provider: ProviderId, inputs: Inputs, applied: string[]): string {
  if (typeof inputs.conversation === "string" && /^https:\/\//.test(inputs.conversation)) {
    applied.push("conversation");
    return inputs.conversation;
  }
  const url = new URL(PROVIDERS[provider].chatUrl);
  const model =
    provider === "chatgpt" && typeof inputs.effort === "string"
      ? CHATGPT_EFFORT_MODELS[inputs.effort]
      : undefined;
  const wanted = model ?? (typeof inputs.model === "string" ? inputs.model : "");
  // ChatGPT opens a chat on the model named in the address; the others pick in the page.
  if (provider === "chatgpt" && wanted && wanted !== "auto") {
    url.searchParams.set("model", wanted);
    applied.push(model ? "effort" : "model");
  }
  return url.toString();
}

function modeButtons(provider: ProviderId, inputs: Inputs): { input: string; names: string }[] {
  return Object.entries(MODE_BUTTONS)
    .map(([key, names]) => ({ key: key.split(":"), names }))
    .filter(({ key }) => key[0] === provider && String(inputs[key[1] as string]) === key[2])
    .map(({ key, names }) => ({ input: key[1] as string, names }));
}

function askCode(provider: ProviderId, inputs: Inputs): string {
  const prompt = String(inputs.prompt ?? "").trim();
  if (!prompt) throw new Error("INVALID_INPUT: ask needs a prompt");
  const applied: string[] = [];
  const url = chatUrl(provider, inputs, applied);
  const files = Array.isArray(inputs.files) ? inputs.files.map(String) : [];
  const modes = modeButtons(provider, inputs);
  const modelPicked = provider !== "chatgpt" && typeof inputs.model === "string";
  const timeoutMs = Math.min(Math.max(Number(inputs.timeoutMs) || 120_000, 10_000), 300_000);
  return `async (page, bu, args) => {
  const applied = ${JSON.stringify(applied)}, skipped = [];
  let askPrompt = ${JSON.stringify(prompt)};
  ${withPageCode(inputs.withPage)}
  page = await browser.openTab(${JSON.stringify(url)}, { newTab: true });
  await page.waitForTimeout(1200);
  ${files.length ? `await page.upload("input[type=file]", ${JSON.stringify(files)}); await page.waitForTimeout(2000); applied.push("files");` : ""}
  for (const mode of ${JSON.stringify(modes)}) {
    const button = page.getByRole("button", { name: new RegExp(mode.names, "i") }).first();
    if (await button.count().catch(() => 0)) { await button.click(); applied.push(mode.input); }
    else skipped.push(mode.input + ": no such control on the page now");
  }
  ${modelPicked ? `skipped.push("model: pick it on the page, then ask again (only ChatGPT takes a model in its address)");` : ""}
  const text = await ${uiScript(provider, "\u0000PROMPT\u0000", { timeoutMs }).replace('"\\u0000PROMPT\\u0000"', "askPrompt")};
  return { text, provider: ${JSON.stringify(provider)}, conversation: await page.url(), applied, skipped };
}`;
}

/** The page the prompt is about: its text, read in one call, goes after the question. */
function withPageCode(withPage: unknown): string {
  if (withPage === undefined || withPage === false) return "";
  const pick =
    typeof withPage === "number"
      ? `await bu.use(${withPage})`
      : "page || (await bu.use((await browser.activeTab()).id))";
  return `{
    const source = ${pick};
    const read = await source.read({ max: 60000 });
    askPrompt += "\\n\\n--- The page (" + read.url + ") ---\\n" + read.markdown;
    applied.push("withPage");
  }`;
}

function imageCode(inputs: Inputs, edit: boolean): string {
  const prompt = String(inputs.prompt ?? "").trim();
  if (!prompt) throw new Error("INVALID_INPUT: needs a prompt");
  const images = Array.isArray(inputs.images) ? inputs.images.map(String) : [];
  if (edit && !images.length)
    throw new Error("INVALID_INPUT: edit_image needs images (workspace files or URLs)");
  const out = typeof inputs.out === "string" ? inputs.out : "gemini-image.png";
  const ratio =
    typeof inputs.aspectRatio === "string" ? ` Aspect ratio ${inputs.aspectRatio}.` : "";
  const text = imagePrompt(prompt + ratio, { edit, images });
  return `async (page) => {
  page = await browser.openTab(${JSON.stringify(PROVIDERS.gemini.chatUrl)}, { newTab: true });
  await page.waitForTimeout(1200);
  return await ${imageScript(text, { out, images, timeoutMs: 240_000 })};
}`;
}

function videoCode(inputs: Inputs): string {
  const prompt = youtubePrompt(String(inputs.url ?? ""), String(inputs.question ?? ""));
  return `async (page) => {
  page = await browser.openTab(${JSON.stringify(PROVIDERS.gemini.chatUrl)}, { newTab: true });
  await page.waitForTimeout(1200);
  const text = await ${uiScript("gemini", prompt, { timeoutMs: 240_000 })};
  return { text, conversation: await page.url() };
}`;
}

const IMAGE_INPUTS = {
  prompt: { type: "string", description: "What to make, or what to change" },
  images: { type: "array", items: { type: "string" }, description: "Workspace files or URLs" },
  aspectRatio: { type: "string", description: "For example 16:9, 1:1, 9:16" },
  out: { type: "string", description: "Workspace file name (default gemini-image.png)" },
};

function askBuiltins(): Builtin[] {
  return (Object.keys(PROVIDERS) as ProviderId[]).map((provider) => ({
    site: PROVIDERS[provider].host.replace(/^www\./, ""),
    name: "ask",
    description: `Ask ${PROVIDERS[provider].name} on the user's own account (their plan, their history): a second opinion, research, a file or page to read.`,
    inputs: { ...ASK_INPUTS, ...(EXTRA_INPUTS[provider] ?? {}) },
    required: ["prompt"],
    outputs: ANSWER,
    code: (inputs) => askCode(provider, inputs),
  }));
}

const BUILTINS: Builtin[] = [
  ...askBuiltins(),
  {
    site: "gemini.google.com",
    name: "make_image",
    description: "Make an image with Gemini on the user's account; saved in the workspace.",
    inputs: IMAGE_INPUTS,
    required: ["prompt"],
    outputs: { type: "object", properties: { saved: { type: "string" } } },
    code: (inputs) => imageCode(inputs, false),
  },
  {
    site: "gemini.google.com",
    name: "edit_image",
    description: "Edit an image with Gemini (keeps its composition); saved in the workspace.",
    inputs: IMAGE_INPUTS,
    required: ["prompt", "images"],
    outputs: { type: "object", properties: { saved: { type: "string" } } },
    code: (inputs) => imageCode(inputs, true),
  },
  {
    site: "gemini.google.com",
    name: "ask_about_video",
    description: "Gemini watches a YouTube video and answers about it (with timestamps).",
    inputs: {
      url: { type: "string", description: "A YouTube link" },
      question: { type: "string", description: "What to find out (default: a summary)" },
    },
    required: ["url"],
    outputs: ANSWER,
    code: videoCode,
  },
  {
    site: "x.com",
    name: "thread",
    description:
      "Read a whole X post with its replies: X's own responses with the user's login, scrolling for more; the visible posts when those are missing.",
    inputs: {
      url: { type: "string", description: "The post's x.com link" },
      max: { type: "number", description: "Most posts to return (default 100)" },
    },
    required: ["url"],
    outputs: { type: "object", properties: { posts: { type: "array" }, via: { type: "string" } } },
    code: xThreadCode,
  },
  {
    site: "x.com",
    name: "research",
    description:
      "What X is saying about a topic, sourced: Grok searches X, every cited post is opened and checked, X search fills in when Grok has nothing. Returns verified posts; write the summary from them.",
    inputs: {
      topic: { type: "string", description: "What to research" },
      budget: { type: "number", description: "Most posts to open and check (default 8, max 25)" },
      since: { type: "string", description: "Only posts after this date (YYYY-MM-DD)" },
      latest: { type: "boolean", description: "Newest posts first in the X search fallback" },
    },
    required: ["topic"],
    outputs: {
      type: "object",
      properties: { posts: { type: "array" }, grok: { type: "string" }, unverified: {} },
    },
    code: xResearchCode,
  },
];

const ALIASES: Record<string, string> = { "twitter.com": "x.com", "kimi.moonshot.cn": "kimi.com" };

function siteKey(site: string): string {
  const host = site
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    ?.replace(/^www\./, "")
    .toLowerCase();
  return host ? (ALIASES[host] ?? host) : "";
}

function toAbility(builtin: Builtin): Ability {
  return {
    name: builtin.name,
    site: builtin.site,
    description: builtin.description,
    kind: "read",
    inputs: { type: "object", properties: builtin.inputs, required: builtin.required },
    ...(builtin.outputs ? { outputs: builtin.outputs } : {}),
    ways: [{ kind: "script", runtime: "page", code: "// built in: written for each call" }],
    options: {},
    stats: { runs: 0, failures: 0 },
    createdBy: "builtin",
    createdAt: "2026-11-04T00:00:00.000Z",
    updatedAt: "2026-11-04T00:00:00.000Z",
  };
}

/** The built-in abilities of a site (none for most sites). */
export function builtinAbilities(site: string): Ability[] {
  const key = siteKey(site);
  return BUILTINS.filter((builtin) => builtin.site === key).map(toAbility);
}

/** A built-in ability's way for these inputs: browser code that opens its own tab. */
export function builtinWay(
  site: string,
  name: string,
  inputs: Inputs,
): AbilityWayScript | undefined {
  const key = siteKey(site);
  const builtin = BUILTINS.find((item) => item.site === key && item.name === name);
  return builtin ? { kind: "script", runtime: "page", code: builtin.code(inputs) } : undefined;
}

/** Every site with built-in abilities, for listings. */
export function builtinSites(): string[] {
  return [...new Set(BUILTINS.map((builtin) => builtin.site))];
}

// Provider and media calls through a host's code runner: browserkit's bridge, Graft's daemon, or
// any other host that can run one browser_code cell. The transport logic stays in providers.ts;
// this layer only supplies the cells and unwraps their answers.

import {
  PROVIDERS,
  askDirect,
  cookieHeader,
  imagePrompt,
  imageScript,
  providerFor,
  uiScript,
  validateModel,
  youtubePrompt,
  type ProviderAnswer,
} from "./providers.js";

/** Runs one browser_code cell in whichever host is calling. */
export type CodeRunner = (code: string, options?: { timeoutMs?: number }) => Promise<unknown>;

export async function providerCookiesWith(run: CodeRunner, providerId: string): Promise<string> {
  const definition = providerFor(providerId);
  const code = `(async () => {
  const domains = ${JSON.stringify(definition.cookieDomains)};
  const all = [];
  for (const domain of domains) {
    const listed = await browser.cookies.list({ domain, values: true }).catch(() => ({ cookies: [] }));
    for (const cookie of listed.cookies || []) if (cookie.value !== undefined) all.push({ name: cookie.name, value: cookie.value });
  }
  return all;
})()`;
  return cookieHeader(
    (await run(code, { timeoutMs: 60_000 })) as { name: string; value: string }[],
  );
}

/**
 * A fetch made by the user's own browser (browser.fetch: its cookies, user agent and TLS), so a
 * provider sees the browser, never Node. Cookie headers are dropped: the browser sends its own.
 */
export function browserFetchWith(run: CodeRunner): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const headers = Object.fromEntries(
      [...new Headers(init.headers).entries()].filter(
        ([name]) => !/^(cookie|user-agent)$/i.test(name),
      ),
    );
    const request = {
      method: init.method ?? "GET",
      headers,
      as: "text",
      ...(typeof init.body === "string" ? { body: init.body } : {}),
    };
    const code = `(async () => browser.fetch(${JSON.stringify(String(input))}, ${JSON.stringify(request)}))()`;
    const answer = (await run(code, { timeoutMs: 180_000 })) as
      { status?: number; text?: string; json?: unknown } | undefined;
    const text = answer?.text ?? (answer?.json === undefined ? "" : JSON.stringify(answer.json));
    return new Response(text, { status: answer?.status || 502 });
  }) as typeof fetch;
}

/** The page fallback: open the provider and read the typed answer. */
export async function uiAnswerWith(
  run: CodeRunner,
  providerId: string,
  prompt: string,
  timeoutMs: number,
): Promise<string> {
  const definition = providerFor(providerId);
  const code = `page = await browser.openTab(${JSON.stringify(definition.chatUrl)}, { newTab: true });
await page.waitForTimeout(1200);
${uiScript(definition.id, prompt, { timeoutMs })}`;
  const text = await run(code, { timeoutMs: Math.min(timeoutMs + 30_000, 330_000) });
  return typeof text === "string" ? text : JSON.stringify(text);
}

/** Ask a provider, direct first and page second, through any host's code runner. */
export async function askProviderWith(
  run: CodeRunner,
  providerId: string,
  prompt: string,
  options: { model?: string; timeoutMs?: number; transport?: "auto" | "direct" | "ui" } = {},
): Promise<ProviderAnswer> {
  const provider = providerFor(providerId);
  const model = validateModel(provider.id, options.model).model;
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 120_000, 5000), 300_000);
  if (options.transport !== "ui") {
    const cookies = await providerCookiesWith(run, provider.id).catch(() => "");
    // No cookies: only a direct-only call stops here; auto still tries the page, which knows.
    if (!cookies && options.transport === "direct")
      return {
        ok: false,
        provider: provider.id,
        transport: "direct",
        text: "",
        model,
        reason: "signed-out",
        elapsedMs: 0,
      };
    const direct = cookies
      ? await askDirect(provider.id, {
          prompt,
          model,
          cookies,
          timeoutMs,
          fetchImpl: browserFetchWith(run),
        })
      : undefined;
    if (direct && (direct.ok || options.transport === "direct")) return direct;
    if (direct && options.transport === "auto") {
      const started = Date.now();
      const text = await uiAnswerWith(run, provider.id, prompt, timeoutMs);
      return {
        ok: true,
        provider: provider.id,
        transport: "ui",
        text,
        model,
        elapsedMs: direct.elapsedMs + (Date.now() - started),
        ...(direct.reason ? { detail: direct.reason } : {}),
      };
    }
  }
  const started = Date.now();
  const text = await uiAnswerWith(run, provider.id, prompt, timeoutMs);
  return {
    ok: true,
    provider: provider.id,
    transport: "ui",
    text,
    model,
    elapsedMs: Date.now() - started,
  };
}

/** Gemini image generation or editing, saved into the workspace. */
export async function generateImageWith(
  run: CodeRunner,
  prompt: string,
  options: { images?: string[]; out?: string; timeoutMs?: number } = {},
): Promise<{ saved: string; prompt: string }> {
  const images = options.images ?? [];
  const text = imagePrompt(prompt, { edit: images.length > 0, images });
  const out = (options.out ?? "gemini-image.png").replace(/[^A-Za-z0-9._/-]+/g, "-");
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 180_000, 10_000), 300_000);
  const code = `page = await browser.openTab(${JSON.stringify(PROVIDERS.gemini.chatUrl)}, { newTab: true });
await page.waitForTimeout(1200);
${imageScript(text, { out, images, timeoutMs })}`;
  const result = (await run(code, { timeoutMs: timeoutMs + 30_000 })) as
    { saved?: string } | undefined;
  if (!result?.saved) throw new Error("MEDIA_EMPTY: Gemini returned no image");
  return { saved: result.saved, prompt: text };
}

/** Gemini watching a YouTube video and answering a question about it. */
export async function analyseYoutubeWith(
  run: CodeRunner,
  url: string,
  question: string,
  options: { timeoutMs?: number } = {},
): Promise<{ text: string; prompt: string }> {
  const prompt = youtubePrompt(url, question);
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 180_000, 10_000), 300_000);
  const text = await uiAnswerWith(run, "gemini", prompt, timeoutMs);
  if (!text) throw new Error("MEDIA_EMPTY: Gemini returned no analysis");
  return { text: String(text), prompt };
}

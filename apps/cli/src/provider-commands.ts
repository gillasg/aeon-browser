import { readFile } from "node:fs/promises";
import { flag, has, type Args } from "browserkit/dist/args.js";
import { out, printJson } from "browserkit/dist/output.js";
import type { Command } from "browserkit/dist/usage.js";
import {
  PROVIDER_IDS,
  PROVIDERS,
  isProviderId,
  transportSummary,
  validateModel,
} from "@browserkit/tools/providers";
import {
  analyseYoutubeWith,
  askProviderWith,
  generateImageWith,
  type CodeRunner,
} from "@browserkit/tools/providers-run";
import type { DaemonHost } from "./host.js";

// Providers and Gemini media through Aeon's daemon: the same adapter and fallback browserkit uses,
// with the browser_code cells run by this chat runtime instead of the native bridge.

function runner(host: DaemonHost): CodeRunner {
  return (code, options) =>
    host.runInBrowser(code, {
      session: "cli",
      ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });
}

async function promptFrom(args: Args): Promise<string> {
  const given = flag(args, "prompt");
  if (given) return given;
  const words = args.positional.slice(1);
  if (!words.length) throw new Error('Usage: aeon ask <provider> "<prompt>" [--model name] [--ui]');
  const joined = words.join(" ");
  if (joined.startsWith("@")) return readFile(joined.slice(1), "utf8");
  return joined;
}

async function ask(host: DaemonHost, args: Args): Promise<number> {
  const providerId = args.positional[0];
  if (!providerId) throw new Error(`Usage: aeon ask <${PROVIDER_IDS.join("|")}> "<prompt>"`);
  if (!isProviderId(providerId))
    throw new Error(`PROVIDER_UNKNOWN: ${providerId} (${PROVIDER_IDS.join(", ")})`);
  const prompt = await promptFrom(args);
  const transport = has(args, "ui") ? "ui" : has(args, "direct") ? "direct" : "auto";
  const model = flag(args, "model");
  const timeout = flag(args, "timeout");
  const answer = await askProviderWith(runner(host), providerId, prompt, {
    ...(model ? { model } : {}),
    ...(timeout ? { timeoutMs: Number(timeout) } : {}),
    transport,
  });
  if (has(args, "json")) {
    printJson(answer);
    return answer.ok ? 0 : 1;
  }
  if (!answer.ok) {
    out(
      `${PROVIDERS[providerId].name} (${answer.transport}) failed: ${answer.reason ?? "unknown"}`,
    );
    if (answer.detail) out(answer.detail);
    out("Try --ui to use the provider's page, or sign in to the provider in Chrome.");
    return 1;
  }
  out(answer.text);
  out(
    `\n${PROVIDERS[providerId].name} · ${answer.transport} · ${answer.model} · ${answer.elapsedMs} ms`,
  );
  return 0;
}

async function providers(args: Args): Promise<number> {
  const rows = PROVIDER_IDS.map((id) => {
    const summary = transportSummary(id);
    const model = validateModel(id, flag(args, "model") ?? undefined);
    return { ...summary, direct: true, modelWarning: model.warning };
  });
  if (has(args, "json")) printJson({ providers: rows });
  else
    for (const row of rows)
      out(`${row.provider}\t${row.host}\tdirect, page\t${row.models.join(", ")}`);
  return 0;
}

async function media(host: DaemonHost, args: Args): Promise<number> {
  const action = args.positional[0] ?? "image";
  if (action === "image") {
    const prompt = args.positional.slice(1).join(" ");
    if (!prompt)
      throw new Error('Usage: aeon media image "<prompt>" [--image file] [--out name.png]');
    const images = flag(args, "image")
      ? String(flag(args, "image"))
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      : [];
    const timeout = flag(args, "timeout");
    const result = await generateImageWith(runner(host), prompt, {
      images,
      ...(flag(args, "out") ? { out: String(flag(args, "out")) } : {}),
      ...(timeout ? { timeoutMs: Number(timeout) } : {}),
    });
    if (has(args, "json")) printJson(result);
    else out(`Saved ${result.saved}.`);
    return 0;
  }
  if (action === "youtube") {
    const url = args.positional[1];
    if (!url) throw new Error('Usage: aeon media youtube <url> [--ask "question"] [--json]');
    const question = String(
      flag(args, "ask") ?? "Summarise the video with timestamps for the key points.",
    );
    const timeout = flag(args, "timeout");
    const result = await analyseYoutubeWith(runner(host), url, question, {
      ...(timeout ? { timeoutMs: Number(timeout) } : {}),
    });
    if (has(args, "json")) printJson({ url, question, ...result });
    else out(result.text);
    return 0;
  }
  throw new Error("Usage: aeon media image|youtube ...");
}

export function providerCommands(host: DaemonHost): Command[] {
  return [
    {
      name: "ask",
      group: "Browser",
      summary: "ask ChatGPT, Gemini, Perplexity, Grok or Kimi with the user's session",
      help: `Usage: aeon ask <provider> "<prompt>" [--model name] [--ui|--direct] [--timeout ms] [--json]
       aeon providers [--json]

Providers: chatgpt, gemini, perplexity, grok, kimi. The direct transport uses the session already
in Chrome; when it fails the provider's page is opened, the prompt typed and the answer read.
--direct never falls back; --ui always uses the page. Cookies and tokens are never printed.`,
      run: (args) => ask(host, args),
    },
    {
      name: "providers",
      group: "Browser",
      summary: "list chat providers, their models and transports",
      help: `Usage: aeon providers [--json]

Each provider has a direct transport and a page fallback. An unknown model is accepted with a
warning instead of rejected, because providers rename models.`,
      run: providers,
    },
    {
      name: "media",
      group: "Browser",
      summary: "generate or edit an image, or analyse a YouTube video, with Gemini",
      help: `Usage: aeon media image "<prompt>" [--image workspace.png|url] [--out name.png] [--json]
       aeon media youtube <url> [--ask "question"] [--json]

Images are saved in the workspace. YouTube analysis sends the video link to Gemini and returns
its answer. The primitive path is page.upload + page.saveMedia on gemini.google.com/app.`,
      run: (args) => media(host, args),
    },
  ];
}

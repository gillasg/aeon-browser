import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CoreBrowsersRequestSchema,
  CoreBrowsersResultSchema,
  CoreChatPinRequestSchema,
  CoreChatPinnedSchema,
  type CoreBrowserSummary,
} from "@aeon/protocol";
import { WebSocket } from "ws";
import type { BrowserControlService } from "./browser-control-service.js";
import { messageOf } from "./core-browser.js";

// `aeon browsers` and `aeon run --browser <name>`. Each Chrome profile running Aeon is one
// browser with a stable id; the user names one ("eval") so a run stays in that profile. Names
// live in browser-names.json in the data folder, keyed by that id.

type Names = Record<string, string>;

const FILE = "browser-names.json";

export async function readBrowserNames(directory: string): Promise<Names> {
  try {
    const parsed = JSON.parse(await readFile(join(directory, FILE), "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Names) : {};
  } catch {
    return {};
  }
}

/** The name the user gave the browser a chat runs in, for its own password manager. */
export async function chatBrowserName(
  directory: string,
  browserControl: Pick<BrowserControlService, "browserOf">,
  chatId: string,
): Promise<string | undefined> {
  const id = browserControl.browserOf(chatId);
  return id ? (await readBrowserNames(directory))[id] : undefined;
}

async function writeBrowserNames(directory: string, names: Names): Promise<void> {
  const path = join(directory, FILE);
  await writeFile(path + ".tmp", JSON.stringify(names, null, 2));
  await rename(path + ".tmp", path);
}

/** The web sites open in a browser, most tabs first. */
export function sitesOf(urls: string[]): string[] {
  const counts = new Map<string, number>();
  for (const url of urls) {
    let host: string;
    try {
      const parsed = new URL(url);
      host = /^https?:$/.test(parsed.protocol) ? parsed.hostname : "";
    } catch {
      continue;
    }
    if (host) counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([host]) => host);
}

export function summarize(browser: BrowserControlService, names: Names): CoreBrowserSummary[] {
  return browser.connectedBrowsers().map(({ clientInstanceId, urls }) => ({
    clientInstanceId,
    ...(names[clientInstanceId] ? { name: names[clientInstanceId] } : {}),
    tabs: urls.length,
    sites: sitesOf(urls),
  }));
}

/** Finds a connected browser by name, id, or the first characters of its id. */
export function findBrowser(
  browsers: CoreBrowserSummary[],
  wanted: string,
): CoreBrowserSummary | undefined {
  const byName = browsers.filter((item) => item.name === wanted);
  if (byName.length === 1) return byName[0];
  const byId = browsers.filter((item) => item.clientInstanceId.startsWith(wanted));
  return byId.length === 1 ? byId[0] : undefined;
}

export function renamed(names: Names, clientInstanceId: string, name: string): Names {
  const next: Names = {};
  for (const [id, value] of Object.entries(names))
    if (id !== clientInstanceId && value !== name) next[id] = value;
  if (name) next[clientInstanceId] = name;
  return next;
}

async function browsersAnswer(
  browser: BrowserControlService,
  directory: string,
  rename?: { browser: string; name: string },
): Promise<CoreBrowserSummary[]> {
  let names = await readBrowserNames(directory);
  if (rename) {
    const found = findBrowser(summarize(browser, names), rename.browser);
    if (!found) throw new Error(`No connected browser matches ${rename.browser}.`);
    names = renamed(names, found.clientInstanceId, rename.name.trim());
    await writeBrowserNames(directory, names);
  }
  return summarize(browser, names);
}

export function handleBrowsers(
  socket: WebSocket,
  candidate: unknown,
  browser: BrowserControlService,
  directory: string,
): boolean {
  const request = CoreBrowsersRequestSchema.safeParse(candidate);
  if (!request.success) return false;
  const { requestId, rename } = request.data;
  const reply = (browsers: CoreBrowserSummary[], error?: string) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    const body = { kind: "core.browsers.result", requestId, browsers, ...(error ? { error } : {}) };
    socket.send(JSON.stringify(CoreBrowsersResultSchema.parse(body)));
  };
  void browsersAnswer(browser, directory, rename).then(
    (browsers) => reply(browsers),
    (error: unknown) => reply([], messageOf(error)),
  );
  return true;
}

export async function pin(
  browser: BrowserControlService,
  directory: string,
  chatId: string,
  name: string,
): Promise<void> {
  const browsers = summarize(browser, await readBrowserNames(directory));
  const found = browsers.find((item) => item.name === name);
  if (!found) {
    const known = browsers.map((item) => item.name).filter(Boolean);
    const hint = known.length ? ` Connected: ${known.join(", ")}.` : "";
    throw new Error(`No connected browser is named ${name}.${hint} See aeon browsers.`);
  }
  browser.pinChat(chatId, found.clientInstanceId);
}

export function handleChatPin(
  socket: WebSocket,
  candidate: unknown,
  browser: BrowserControlService,
  directory: string,
): boolean {
  const request = CoreChatPinRequestSchema.safeParse(candidate);
  if (!request.success) return false;
  const { requestId, chatId } = request.data;
  const reply = (error?: string) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    const body = {
      kind: "core.chat.pinned",
      requestId,
      chatId,
      ok: !error,
      ...(error ? { error } : {}),
    };
    socket.send(JSON.stringify(CoreChatPinnedSchema.parse(body)));
  };
  void pin(browser, directory, chatId, request.data.browser).then(
    () => reply(),
    (error: unknown) => reply(messageOf(error)),
  );
  return true;
}

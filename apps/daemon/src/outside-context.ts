import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Whether outside agents (MCP, the CLI) may see the user's open tabs. Off by default; the user
// turns it on in Aeon Settings. Only titles and URLs leave the browser, never page contents.

export interface OutsideTab {
  title: string;
  url: string;
  active: boolean;
}

export const CONTEXT_TOOL = {
  name: "context",
  description:
    "The user's open tabs (title, URL) and which is active, when they allowed it in Aeon Settings. Titles and URLs only, never page contents. When it is off, returns how to turn it on.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

const FILE = "outside-context.json";

export async function readOutsideContext(directory: string): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(join(directory, FILE), "utf8")) as {
      openTabs?: unknown;
    };
    return value.openTabs === true;
  } catch {
    return false;
  }
}

export async function writeOutsideContext(directory: string, enabled: boolean): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, FILE), JSON.stringify({ openTabs: enabled }, null, 2) + "\n");
}

/** What an outside agent gets: nothing but the hint while the setting is off. */
export async function outsideContextAnswer(
  directory: string,
  tabs: () => Promise<OutsideTab[]>,
): Promise<{ enabled: boolean; tabs: OutsideTab[]; activeTab?: OutsideTab | null; hint?: string }> {
  if (!(await readOutsideContext(directory)))
    return {
      enabled: false,
      tabs: [],
      hint: 'The user has not let outside agents see their tabs. Ask them to turn on "Let outside agents see my open tabs" in Aeon Settings.',
    };
  const open = (await tabs())
    .map((tab) => ({
      title: String(tab.title ?? "").slice(0, 300),
      url: String(tab.url ?? "").slice(0, 2000),
      active: tab.active === true,
    }))
    .filter((tab) => /^https?:\/\//i.test(tab.url))
    .slice(0, 100);
  return { enabled: true, tabs: open, activeTab: open.find((tab) => tab.active) ?? null };
}

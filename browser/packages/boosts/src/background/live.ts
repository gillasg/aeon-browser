// Live viewers a boost can feed with GM.liveView.push. The viewer's push token stays here, in the
// service worker's session storage: browser.liveView.start registers it, boosts only name the
// viewer (or take the newest), so no token is ever written into a boost's source.

export interface LiveViewEntry {
  id: string;
  title?: string;
  pushUrl: string;
  token: string;
  at: number;
}

const KEY = "boosts:liveViews";
const MAX_VIEWS = 16;

async function read(): Promise<LiveViewEntry[]> {
  const stored = await chrome.storage.session.get(KEY);
  return (stored[KEY] as LiveViewEntry[] | undefined) ?? [];
}

const loopback = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
    );
  } catch {
    return false;
  }
};

export async function rememberView(view: Record<string, unknown>): Promise<{ id: string }> {
  const id = String(view.id ?? "");
  const pushUrl = String(view.pushUrl ?? "");
  const token = String(view.token ?? "");
  if (!id || !token || !loopback(pushUrl))
    throw new Error("INVALID_VIEW: a live viewer needs an id, a loopback pushUrl and a token");
  const views = (await read()).filter((entry) => entry.id !== id);
  views.push({
    id,
    pushUrl,
    token,
    at: Date.now(),
    ...(typeof view.title === "string" ? { title: view.title } : {}),
  });
  await chrome.storage.session.set({ [KEY]: views.slice(-MAX_VIEWS) });
  return { id };
}

export async function forgetView(id: string): Promise<void> {
  await chrome.storage.session.set({ [KEY]: (await read()).filter((entry) => entry.id !== id) });
}

/** GM.liveView.push(rows | {rows} | {frame}, {view?}): into the named viewer, else the newest. */
export async function pushToView(
  args: Record<string, unknown>,
): Promise<{ ok: true; view: string }> {
  const views = await read();
  const wanted = typeof args.view === "string" ? args.view : undefined;
  const view = wanted ? views.find((entry) => entry.id === wanted) : views.at(-1);
  if (!view)
    throw new Error(
      wanted
        ? `NO_LIVE_VIEW: no viewer ${wanted}; start one with browser.liveView.start()`
        : "NO_LIVE_VIEW: no live viewer is open; start one with browser.liveView.start()",
    );
  const data = args.data;
  const body = Array.isArray(data)
    ? { rows: data }
    : data && typeof data === "object" && ("rows" in data || "frame" in data)
      ? data
      : { frame: data };
  const reply = await fetch(view.pushUrl, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${view.token}` },
    body: JSON.stringify(body),
  }).catch((error: unknown) => {
    throw new Error(
      `LIVE_VIEW_GONE: viewer ${view.id} did not answer (${error instanceof Error ? error.message : String(error)}); it closes when Graft stops`,
    );
  });
  if (!reply.ok) throw new Error(`LIVE_VIEW_REFUSED: viewer ${view.id} answered ${reply.status}`);
  return { ok: true, view: view.id };
}

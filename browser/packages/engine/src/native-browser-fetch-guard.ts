// Two habits the kernel enforces on browser.fetch, so no chat can skip them: the first fetch to a
// site with a saved map says which operations it has (calling them beats scraping pages), and a
// chat that keeps getting "not found" from one site is stopped from guessing more addresses.

const NOT_FOUND_LIMIT = 3;
const MAX_TRACKED = 500;
const LISTED_OPERATIONS = 15;

interface SiteState {
  notFound: string[];
  told: boolean;
}

const sites = new Map<string, SiteState>();

function siteOf(url: string): string {
  return new URL(url).host.toLowerCase().replace(/^www\./, "");
}

function stateFor(chatId: string, site: string): SiteState {
  const key = `${chatId}|${site}`;
  let state = sites.get(key);
  if (!state) {
    state = { notFound: [], told: false };
    sites.set(key, state);
    if (sites.size > MAX_TRACKED) sites.delete(sites.keys().next().value as string);
  }
  return state;
}

/** Throws URL_GUESSING once a chat has had NOT_FOUND_LIMIT missing addresses on one site. */
export function noteFetchStatus(
  chatId: string,
  url: string,
  status: number,
  expectMissing: boolean,
): void {
  if (expectMissing || (status !== 404 && status !== 410)) return;
  const site = siteOf(url);
  const state = stateFor(chatId, site);
  state.notFound.push(new URL(url).pathname);
  if (state.notFound.length < NOT_FOUND_LIMIT) return;
  throw new Error(
    `URL_GUESSING: ${state.notFound.length} addresses on ${site} were not found ` +
      `(${state.notFound.slice(-NOT_FOUND_LIMIT).join(", ")}). Stop guessing: open a page that ` +
      `shows the data in a tab and read page.network.list() for the calls it really makes, or use ` +
      `siteMapper. To check addresses that may not exist on purpose, pass {expectMissing: true}.`,
  );
}

interface Operation {
  id?: unknown;
  what?: unknown;
  writes?: unknown;
}

/**
 * The mapped-site notice for the first fetch a chat makes to a site, or undefined (not mapped,
 * already told, or the host could not answer).
 */
export async function mappedNotice(
  chatId: string,
  url: string,
  operations: (site: string) => Promise<unknown>,
): Promise<Record<string, unknown> | undefined> {
  const site = siteOf(url);
  const state = stateFor(chatId, site);
  if (state.told) return undefined;
  state.told = true;
  let listed: unknown;
  try {
    listed = await operations(site);
  } catch {
    return undefined; // Not mapped, or no host to ask: fetch as usual.
  }
  if (!Array.isArray(listed) || !listed.length) return undefined;
  const ops = (listed as Operation[]).map((op) => ({
    id: op.id,
    what: op.what,
    ...(op.writes ? { writes: true } : {}),
  }));
  return {
    site,
    operations: ops.slice(0, LISTED_OPERATIONS),
    ...(ops.length > LISTED_OPERATIONS ? { more: ops.length - LISTED_OPERATIONS } : {}),
    use:
      `${site} has a saved API map: siteMapper.call('${site}', id, params) is faster and steadier ` +
      `than fetching its pages. If no operation has what you need, fetch as you are, or open a ` +
      `page in a tab and read page.network.list() to find the call that does.`,
  };
}

export function resetFetchGuard(): void {
  sites.clear();
}

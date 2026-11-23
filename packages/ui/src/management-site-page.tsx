import { useEffect, useState, type ReactElement } from "react";
import { hashRoute } from "./manage-route.js";
import { EmptyState } from "./empty-state.js";
import type { ManagementSnapshotDto } from "@aeon/protocol";
import type { ManagementSurfaceProps } from "./management-surface-props.js";
import { SiteFacts } from "./ability-source.js";
import { ActionNote } from "./management-automations.js";
import { BlockedSitesSettings } from "./blocked-sites-settings.js";
import { Segmented } from "./segmented.js";
import { SiteActions, SiteAbilities, SiteRunForm, formatWhen } from "./management-sites.js";
import { SessionActions } from "./management-sessions.js";

// Sites: one page per site Aeon knows (mapped, signed in, watched, or with a rule). Each has four
// tabs: its Site APIs (calls with no page), its Replays (recorded steps and scripts), its Boosts,
// and the account it uses with the user's rules, plus Teach Aeon. Absorbs the old Skills, Site
// sessions and Blocked sites pages.

type Site = NonNullable<ManagementSnapshotDto["sites"]>[number];
type Routine = ManagementSnapshotDto["routines"][number];
type Tab = "apis" | "replays" | "boosts" | "account";

const TABS: ReadonlyArray<[Tab, string]> = [
  ["apis", "Site APIs"],
  ["replays", "Replays"],
  ["boosts", "Boosts"],
  ["account", "Account / Rules"],
];

interface SiteEntry {
  host: string;
  mapped: Site | undefined;
  blocked: boolean;
  routines: Routine[];
}

/** One spelling per site: `WWW.Example.com ` and `example.com` are the same page. */
export function siteHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
}

/** Every site worth a page: mapped, blocked, or used by a routine. Sorted by name. */
export function siteEntries(
  sites: readonly Site[],
  blocked: readonly string[],
  routines: readonly Routine[],
): SiteEntry[] {
  const hosts = new Set<string>(
    [...sites.map((site) => site.site), ...blocked, ...routines.flatMap((routine) => routine.sites)]
      .map(siteHost)
      .filter(Boolean),
  );
  return [...hosts].sort().map((host) => ({
    host,
    mapped: sites.find((site) => siteHost(site.site) === host),
    blocked: blocked.some((item) => siteHost(item) === host),
    routines: routines.filter((routine) => routine.sites.some((item) => siteHost(item) === host)),
  }));
}

/** The page for a selected host; a deep link to a site with nothing yet (only a boost, or not
 * mapped) still gets its page instead of falling back to the list. */
export function selectedSiteEntry(
  entries: readonly SiteEntry[],
  selected: string,
): SiteEntry | undefined {
  const host = siteHost(selected);
  if (!host) return undefined;
  return (
    entries.find((item) => item.host === host) ?? {
      host,
      mapped: undefined,
      blocked: false,
      routines: [],
    }
  );
}

export function SitesPage(props: ManagementSurfaceProps): ReactElement {
  const entries = entriesOf(props);
  const [selected, setSelected] = useState(() => siteHost(hashRoute().host));
  // The cursor's X-Ray line opens Manage at `#sites?host=…`, also into a Manage tab already open.
  useEffect(() => {
    const follow = (): void => {
      const host = siteHost(hashRoute().host);
      if (host) setSelected(host);
    };
    addEventListener("hashchange", follow);
    return () => removeEventListener("hashchange", follow);
  }, []);
  const chatId = props.selectedChatId || props.snapshot?.chats[0]?.chatId || "";
  const entry = selectedSiteEntry(entries, selected);
  return (
    <div className="management-sites site-pages">
      <ActionNote note={props.snapshot?.lastAction} />
      {entry ? (
        <SiteDetail entry={entry} props={props} chatId={chatId} onBack={() => setSelected("")} />
      ) : (
        <SiteIndex entries={entries} props={props} onSelect={setSelected} />
      )}
    </div>
  );
}

/** Every site, searchable, with a Blocked filter in place of a page of its own. */
function SiteIndex({
  entries,
  props,
  onSelect,
}: {
  entries: SiteEntry[];
  props: ManagementSurfaceProps;
  onSelect(host: string): void;
}): ReactElement {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "blocked">(() =>
    hashRoute().page === "blocked" ? "blocked" : "all",
  );
  return (
    <>
      <div className="site-list-tools">
        {entries.length > 0 && <SiteSearch query={query} onQuery={setQuery} />}
        <Segmented<"all" | "blocked">
          label="Which sites"
          value={filter}
          options={[
            ["all", "All"],
            ["blocked", "Blocked"],
          ]}
          onChange={setFilter}
        />
      </div>
      {filter === "blocked" ? (
        <BlockedSitesSettings
          {...(props.blockedSites ? { sites: props.blockedSites } : {})}
          {...(props.onBlockedSiteAdd ? { onAdd: props.onBlockedSiteAdd } : {})}
          {...(props.onBlockedSiteRemove ? { onRemove: props.onBlockedSiteRemove } : {})}
        />
      ) : (
        <SiteList
          entries={matching(entries, query)}
          repairs={props.snapshot?.abilities ?? []}
          searching={query.trim() !== ""}
          onSelect={onSelect}
          onSuggest={props.onSuggest}
        />
      )}
    </>
  );
}

function entriesOf(props: ManagementSurfaceProps): SiteEntry[] {
  return siteEntries(
    props.snapshot?.sites ?? [],
    props.blockedSites ?? [],
    props.snapshot?.routines ?? [],
  );
}

function SiteSearch({ query, onQuery }: { query: string; onQuery(value: string): void }) {
  return (
    <input
      className="aeon-search"
      type="search"
      value={query}
      placeholder="Search sites"
      aria-label="Search sites"
      onChange={(event) => onQuery(event.target.value)}
    />
  );
}

function matching(entries: SiteEntry[], query: string): SiteEntry[] {
  const text = query.trim().toLowerCase();
  return text ? entries.filter((entry) => entry.host.includes(text)) : entries;
}

type Ability = NonNullable<ManagementSnapshotDto["abilities"]>[number];

function SiteList({
  entries,
  repairs,
  searching,
  onSelect,
  onSuggest,
}: {
  entries: SiteEntry[];
  /** Every saved skill; a row says how many of its site's need repair. */
  repairs: readonly Ability[];
  searching: boolean;
  onSelect(host: string): void;
  onSuggest: ((example: string) => void) | undefined;
}): ReactElement {
  if (!entries.length && searching)
    return <p className="management-empty">No sites match that search.</p>;
  if (!entries.length)
    return (
      <EmptyState
        text="Aeon learns a site as it works there, and gets faster each time."
        action="Teach Aeon a site"
        {...(onSuggest ? { onAction: () => onSuggest("Learn how to search on ") } : {})}
      />
    );
  return (
    <ul className="site-list">
      {entries.map((entry) => (
        <li key={entry.host}>
          <button type="button" onClick={() => onSelect(entry.host)}>
            <strong>{entry.host}</strong>
            {siteSummary(entry, needsRepair(entry, repairs)) && (
              <span className="management-subtle">
                {siteSummary(entry, needsRepair(entry, repairs))}
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** `Signed in · 12 skills · 1 needs repair`: quiet words, never a handle or a raw state. */
export function siteSummary(entry: SiteEntry, repairs = 0): string {
  const skills = entry.mapped?.abilities.length ?? 0;
  const watches = entry.routines.length;
  const parts = [
    entry.blocked ? "Blocked" : entry.mapped?.session ? "Signed in" : "",
    skills ? plural(skills, "skill", "skills") : "",
    repairs ? plural(repairs, "needs repair", "need repair") : "",
    watches ? plural(watches, "watch", "watches") : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function needsRepair(entry: SiteEntry, abilities: readonly Ability[]): number {
  return abilities.filter(
    (ability) => siteHost(ability.site) === entry.host && ability.checkNote?.repairFailed,
  ).length;
}

function SiteDetail({
  entry,
  props,
  chatId,
  onBack,
}: {
  entry: SiteEntry;
  props: ManagementSurfaceProps;
  chatId: string;
  onBack(): void;
}): ReactElement {
  const [tab, setTab] = useState<Tab>("apis");
  return (
    <section className="site-detail" aria-label={entry.host}>
      <header className="site-detail-head">
        <button type="button" className="aeon-button" onClick={onBack}>
          ← Sites
        </button>
        <h2>{entry.host}</h2>
        {props.onTeachSite && (
          <button
            type="button"
            className="site-teach aeon-button"
            data-tone="primary"
            onClick={() => props.onTeachSite?.(entry.host)}
          >
            Teach Aeon
          </button>
        )}
      </header>
      <nav
        className="site-tabs aeon-segmented"
        role="tablist"
        aria-label={`${entry.host} sections`}
      >
        {TABS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div role="tabpanel">
        <SiteTab tab={tab} entry={entry} chatId={chatId} props={props} />
      </div>
    </section>
  );
}

function SiteTab({
  tab,
  entry,
  chatId,
  props,
}: {
  tab: Tab;
  entry: SiteEntry;
  chatId: string;
  props: ManagementSurfaceProps;
}): ReactElement {
  if (tab === "boosts") return <BoostIdeas host={entry.host} suggest={props.onSuggest} />;
  if (tab === "account")
    return (
      <>
        <Account site={entry.mapped} chatId={chatId} props={props} />
        <Rules entry={entry} props={props} />
      </>
    );
  return (
    <CanDo
      host={entry.host}
      site={entry.mapped}
      chatId={chatId}
      props={props}
      replays={tab === "replays"}
    />
  );
}

/** Site APIs are skills that call the site with no page; replays drive the page (steps, scripts). */
function onlyWays(site: Site, replays: boolean): Site {
  return {
    ...site,
    abilities: site.abilities.filter((ability) => ability.ways.includes("api") !== replays),
  };
}

function CanDo({
  host,
  site,
  chatId,
  props,
  replays,
}: {
  host: string;
  site: Site | undefined;
  chatId: string;
  props: ManagementSurfaceProps;
  replays: boolean;
}): ReactElement {
  const [running, setRunning] = useState(false);
  const suggest = props.onSuggest;
  if (!site) return <NotLearned host={host} suggest={suggest} />;
  const shown = onlyWays(site, replays);
  if (replays)
    return shown.abilities.length ? (
      <SiteAbilities site={shown} onTry={tryAbility(host, suggest)} />
    ) : (
      <p className="management-empty">
        No replays yet. Teach Aeon, or let it work here, and the steps it repeats become one.
      </p>
    );
  return (
    <>
      {site.updatedAt ? (
        <p>
          {site.operations} learned calls
          <span className="management-subtle"> · updated {formatWhen(site.updatedAt)}</span>
        </p>
      ) : (
        <p className="management-subtle">Comes with Aeon: these work on your own account.</p>
      )}
      {shown.abilities.length > 0 && (
        <SiteAbilities site={shown} onTry={tryAbility(host, suggest)} />
      )}
      <SiteFacts notes={site.notes} />
      {site.suggestions.length > 0 && (
        <ul className="management-inputs">
          {site.suggestions.map((suggestion) => (
            <li key={suggestion} className="management-subtle">
              {suggestion}
            </li>
          ))}
        </ul>
      )}
      <SiteActions
        site={site}
        chatId={chatId}
        onAction={props.onAction}
        open={running}
        onToggle={() => setRunning((value) => !value)}
      />
      {running && <SiteRunForm site={site} chatId={chatId} onAction={props.onAction} />}
    </>
  );
}

function tryAbility(
  host: string,
  suggest: ((example: string) => void) | undefined,
): ((ability: Site["abilities"][number]) => void) | undefined {
  return (
    suggest &&
    ((ability) =>
      suggest(`On ${host}, ${ability.description || ability.name.replace(/_/g, " ")}: `))
  );
}

function NotLearned({
  host,
  suggest,
}: {
  host: string;
  suggest: ((example: string) => void) | undefined;
}): ReactElement {
  return (
    <>
      <p className="management-empty">
        Aeon hasn&rsquo;t learned this site yet. It learns as it works here; learning it now takes
        about two minutes in a background tab, and makes the next task a few seconds.
      </p>
      {suggest && (
        <div className="management-actions">
          <button
            type="button"
            onClick={() => suggest(`Learn ${host} so the things I do there are quick next time`)}
          >
            Learn it
          </button>
        </div>
      )}
    </>
  );
}

// Changes people often want on a site, offered as boosts so a page is better on every visit.
const BOOST_IDEAS = ["Hide ads and sponsored items", "Dark mode", "Hide distractions"];

function BoostIdeas({
  host,
  suggest,
}: {
  host: string;
  suggest: ((example: string) => void) | undefined;
}): ReactElement | null {
  if (!suggest) return null;
  const ask = (idea: string) =>
    suggest(`Make a boost for ${host}: ${idea.toLowerCase()}, on every visit`);
  return (
    <>
      <h3 className="management-subheading">Make it better</h3>
      <div className="management-actions">
        {BOOST_IDEAS.map((idea) => (
          <button key={idea} type="button" onClick={() => ask(idea)}>
            {idea}
          </button>
        ))}
        <button type="button" onClick={() => suggest(`Make a boost for ${host} that `)}>
          Something else…
        </button>
      </div>
    </>
  );
}

function Account({
  site,
  chatId,
  props,
}: {
  site: Site | undefined;
  chatId: string;
  props: ManagementSurfaceProps;
}): ReactElement {
  if (!site) return <p className="management-empty">No stored session for this site.</p>;
  return (
    <>
      <p>
        {site.session ? (
          <>
            Signed in{site.sessionAccount ? ` as ${site.sessionAccount}` : ""}
            {site.sessionSavedAt && (
              <span className="management-subtle"> · saved {formatWhen(site.sessionSavedAt)}</span>
            )}
          </>
        ) : (
          <span className="management-subtle">Signed out</span>
        )}
      </p>
      <SessionActions
        session={site.session}
        act={(action) => props.onAction(chatId, action, { site: site.site })}
      />
    </>
  );
}

function Rules({
  entry,
  props,
}: {
  entry: SiteEntry;
  props: ManagementSurfaceProps;
}): ReactElement {
  return (
    <label className="site-rule">
      <input
        type="checkbox"
        checked={entry.blocked}
        disabled={!props.onBlockedSiteAdd || !props.onBlockedSiteRemove}
        onChange={(event) =>
          event.currentTarget.checked
            ? props.onBlockedSiteAdd?.(entry.host)
            : props.onBlockedSiteRemove?.(entry.host)
        }
      />
      <span>
        <strong>Block this site</strong>
        <span className="management-subtle">
          {" "}
          Agents never open, read or call it. Your own browsing is unaffected.
        </span>
      </span>
    </label>
  );
}

import { useState, type ReactElement } from "react";
import { EmptyState } from "./empty-state.js";
import type { ManagementSnapshotDto } from "@aeon/protocol";
import type { ManagementSurfaceProps } from "./management-surface-props.js";
import { AbilitiesPanel, ActionNote } from "./management-automations.js";
import {
  ImportPath,
  SiteActions,
  SiteAbilities,
  SiteRunForm,
  formatWhen,
} from "./management-sites.js";
import { SessionActions } from "./management-sessions.js";

// Sites: one page per site Aeon knows (mapped, signed in, watched, or with a rule). Each has four
// tabs: what Aeon can do there, the account it uses, what is watching it, and the user's rules.
// Absorbs the old Sites, Site sessions and Blocked sites pages.

type Site = NonNullable<ManagementSnapshotDto["sites"]>[number];
type Routine = ManagementSnapshotDto["routines"][number];
type Tab = "can" | "account" | "watching" | "rules";

const TABS: ReadonlyArray<[Tab, string]> = [
  ["can", "Can do"],
  ["account", "Account"],
  ["watching", "Watching"],
  ["rules", "Rules"],
];

interface SiteEntry {
  host: string;
  mapped: Site | undefined;
  blocked: boolean;
  routines: Routine[];
}

/** Every site worth a page: mapped, blocked, or used by a routine. Sorted by name. */
export function siteEntries(
  sites: readonly Site[],
  blocked: readonly string[],
  routines: readonly Routine[],
): SiteEntry[] {
  const hosts = new Set<string>([
    ...sites.map((site) => site.site),
    ...blocked,
    ...routines.flatMap((routine) => routine.sites),
  ]);
  return [...hosts].sort().map((host) => ({
    host,
    mapped: sites.find((site) => site.site === host),
    blocked: blocked.includes(host),
    routines: routines.filter((routine) => routine.sites.includes(host)),
  }));
}

export function SitesPage(props: ManagementSurfaceProps): ReactElement {
  const entries = entriesOf(props);
  const [selected, setSelected] = useState("");
  const [query, setQuery] = useState("");
  const chatId = props.selectedChatId || props.snapshot?.chats[0]?.chatId || "";
  const entry = entries.find((item) => item.host === selected);
  return (
    <div className="management-sites site-pages">
      <ActionNote note={props.snapshot?.lastAction} />
      {entry ? (
        <SiteDetail entry={entry} props={props} chatId={chatId} onBack={() => setSelected("")} />
      ) : (
        <>
          {entries.length > 0 && <SiteSearch query={query} onQuery={setQuery} />}
          <SiteList
            entries={matching(entries, query)}
            searching={query.trim() !== ""}
            onSelect={setSelected}
            onSuggest={props.onSuggest}
          />
          <AbilitiesPanel {...props} />
          <div className="management-footnote">
            <ImportPath chatId={chatId} onAction={props.onAction} />
          </div>
        </>
      )}
    </div>
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

function SiteList({
  entries,
  searching,
  onSelect,
  onSuggest,
}: {
  entries: SiteEntry[];
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
        action="Learn a site"
        {...(onSuggest ? { onAction: () => onSuggest("Learn how to search on ") } : {})}
      />
    );
  return (
    <ul className="site-list">
      {entries.map((entry) => (
        <li key={entry.host}>
          <button type="button" onClick={() => onSelect(entry.host)}>
            <strong>{entry.host}</strong>
            <span className="management-subtle">{siteSummary(entry)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function siteSummary(entry: SiteEntry): string {
  const parts: string[] = [];
  if (entry.mapped) {
    const can = entry.mapped.operations + entry.mapped.abilities.length;
    parts.push(`${can} thing${can === 1 ? "" : "s"} it can do`);
    if (entry.mapped.session) parts.push(entry.mapped.sessionAccount ?? "signed in");
  }
  if (entry.routines.length) parts.push(`${entry.routines.length} watching`);
  if (entry.blocked) parts.push("blocked");
  return parts.join(" · ") || "nothing yet";
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
  const [tab, setTab] = useState<Tab>("can");
  return (
    <section className="site-detail" aria-label={entry.host}>
      <header className="site-detail-head">
        <button type="button" onClick={onBack}>
          ← Sites
        </button>
        <h2>{entry.host}</h2>
      </header>
      <nav className="site-tabs" role="tablist" aria-label={`${entry.host} sections`}>
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
        {tab === "can" && (
          <CanDo host={entry.host} site={entry.mapped} chatId={chatId} props={props} />
        )}
        {tab === "account" && <Account site={entry.mapped} chatId={chatId} props={props} />}
        {tab === "watching" && <Watching routines={entry.routines} props={props} />}
        {tab === "rules" && <Rules entry={entry} props={props} />}
      </div>
    </section>
  );
}

// Changes people often want on a site, offered as boosts so a page is better on every visit.
const BOOST_IDEAS = ["Hide ads and sponsored items", "Dark mode", "Hide distractions"];

function CanDo({
  host,
  site,
  chatId,
  props,
}: {
  host: string;
  site: Site | undefined;
  chatId: string;
  props: ManagementSurfaceProps;
}): ReactElement {
  const [running, setRunning] = useState(false);
  const suggest = props.onSuggest;
  if (!site) return <NotLearned host={host} suggest={suggest} />;
  return (
    <>
      <p>
        {site.operations} learned calls ·{" "}
        <span className={`management-health management-health-${site.health}`}>{site.health}</span>
        <span className="management-subtle"> · updated {formatWhen(site.updatedAt)}</span>
      </p>
      <SiteAbilities
        site={site}
        onTry={
          suggest &&
          ((ability) =>
            suggest(`On ${host}, ${ability.description || ability.name.replace(/_/g, " ")}: `))
        }
      />
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
      <BoostIdeas host={host} suggest={suggest} />
    </>
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
      <BoostIdeas host={host} suggest={suggest} />
    </>
  );
}

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

function Watching({
  routines,
  props,
}: {
  routines: Routine[];
  props: ManagementSurfaceProps;
}): ReactElement {
  if (!routines.length)
    return (
      <p className="management-empty">
        Nothing watches this site. Ask Aeon to &ldquo;tell me when … changes&rdquo; to add one.
      </p>
    );
  return (
    <ul className="site-list">
      {routines.map((routine) => (
        <li key={routine.routineId}>
          <button type="button" onClick={() => props.onOpenChat(routine.chatId)}>
            <strong>{routine.title}</strong>
            <span className="management-subtle">
              {routine.enabled ? "On" : "Paused"}
              {routine.nextDueAt ? ` · next ${formatWhen(routine.nextDueAt)}` : ""}
            </span>
          </button>
        </li>
      ))}
    </ul>
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

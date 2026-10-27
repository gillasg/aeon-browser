import { humanize } from "./management-automations.js";
import { CommandPalette, type PaletteItem } from "./command-palette.js";
import type { PrivacySettingsProps } from "./privacy-settings.js";
import type { ModelLoginState } from "./connect-model-card.js";
import { useEffect, useState, type ReactElement, useMemo } from "react";
import type { ChatCatalogItemDto } from "@aeon/protocol";
import { HomeCatalog } from "./home-catalog.js";
import type { ManagementSnapshotDto } from "@aeon/protocol";
import type { HomeRoutineCardDto } from "@aeon/protocol";
import type { PiModelCatalogDto } from "@aeon/protocol";
import type { ComposerModel, ComposerAttachment } from "./chat-composer.js";
import { HomeStart } from "./home-start.js";
import { ManagementSurface } from "./management-surface.js";
import type { ManagementActionName, ManagementSection } from "./management-types.js";
import { HomeTopBar, viewFromRoute, type HomeView } from "./home-top-bar.js";
import { HomeDashboard } from "./home-dashboard.js";
import { HomeCore } from "./home-core.js";
import type { HomeRunActions, HomeRunPreview } from "./home-live.js";
import { ActivityPanel } from "./activity-panel.js";
import { type ActivityEntry, recentActivityCount, useActivityLog } from "./activity-log.js";
import { FirstRunTour } from "./first-run-tour.js";
import { ModelAccounts } from "./model-accounts.js";
import { BrowserAccounts } from "./browser-accounts.js";
import type { ModelAccountsProps } from "./model-accounts-types.js";

export interface NewTabHomeProps {
  developmentFixture: boolean;
  connectionLabel: string;
  connected?: boolean;
  chats: readonly ChatCatalogItemDto[];
  /** Chats whose agent is working right now. */
  runningChatIds?: ReadonlySet<string>;
  /** Live frames of the tabs running chats act in, by chat. */
  previews?: ReadonlyMap<string, HomeRunPreview>;
  /** Show a background run's window, or stop it. */
  runActions?: HomeRunActions;
  /** Chats waiting on the user (an approval or a question). */
  needsChatIds?: ReadonlySet<string>;
  modelCatalog: PiModelCatalogDto | null;
  /** Sign-in progress for "Connect a model". */
  modelLogin?: ModelLoginState;
  /** Opens the model sign-in page (every provider Pi supports). */
  onConnectModel?(): void;
  /** The Models tab of Settings: sign-ins, API keys and the default model. */
  modelAccounts?: ModelAccountsProps;
  openChatIds: ReadonlySet<string>;
  catalogOpen: boolean;
  catalogQuery: string;
  includeArchived: boolean;
  catalogResults: readonly ChatCatalogItemDto[];
  catalogPending: boolean;
  searchWarnings: number;
  error: string;
  onDismissError?(): void;
  onAsk(
    query: string,
    model: ComposerModel,
    thinkingLevel: string,
    attachments?: readonly ComposerAttachment[],
  ): void;
  onReadAttachments?(files: readonly File[]): Promise<ComposerAttachment[]>;
  onNewChat(): void;
  onOpenChat(chatId: string): void;
  /** Reverses an API write from the Activity page, when the site knows the reverse. */
  onUndoActivity?(entry: ActivityEntry): void;
  onCatalog(): void;
  /** Leaves the chat list (it is a page of its own now). */
  onCloseCatalog?(): void;
  onCatalogQuery(query: string): void;
  onIncludeArchived(include: boolean): void;
  onPin(chat: ChatCatalogItemDto): void;
  onArchive(chat: ChatCatalogItemDto): void;
  onRename(chat: ChatCatalogItemDto): void;
  onDelete(chat: ChatCatalogItemDto): void;
  managementSnapshot: ManagementSnapshotDto | null;
  homeRoutines: readonly HomeRoutineCardDto[];
  managementLoading: boolean;
  managementError: string;
  managementSelectedChatId: string;
  theme: "dark" | "midnight" | "light" | "system";
  sidebarDefaultOpen: boolean;
  onManagementLoad(): void;
  onManagementRefresh(): void;
  onManagementSelectChat(chatId: string): void;
  onManagementOpenChat(chatId: string): void;
  onManagementAction(
    chatId: string,
    action: ManagementActionName,
    input: Record<string, unknown>,
  ): void;
  /** The shared blocked-sites list (browserkit's site-rules.json), loaded through the daemon. */
  blockedSites?: readonly string[];
  onBlockedSiteAdd?(site: string): void;
  onBlockedSiteRemove?(site: string): void;
  privacy?: PrivacySettingsProps;
  /** Outside agents may see the user's open tabs (opt-in, stored by the daemon). */
  outsideContext?: boolean;
  onOutsideContext?(enabled: boolean): void;
  onTheme(theme: "dark" | "midnight" | "light" | "system"): void;
  onSidebarDefault(open: boolean): void;
}

type SettingsSection = "settings" | "models" | "advanced";

/** `?view=models` is the Models tab of Settings; every other view is the top bar's. */
function homeRoute(): { view: HomeView; settingsSection?: SettingsSection } {
  const route = new URLSearchParams(globalThis.location?.search ?? "").get("view");
  return route === "models"
    ? { view: "settings", settingsSection: "models" }
    : viewFromRoute(route);
}

export function NewTabHome(props: NewTabHomeProps): ReactElement {
  const [route] = useState(homeRoute);
  const [view, setView] = useState<HomeView>(route.view);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(
    route.settingsSection ?? "settings",
  );
  const activity = useActivityLog();
  // Home shows each watcher's last check, so it loads management too.
  useEffect(() => props.onManagementLoad(), []);
  useSlashToAsk();
  // The chat list is the Chats page; the controller still owns its search state.
  const shown: HomeView = props.catalogOpen ? "chats" : view;
  const go = (next: HomeView): void => {
    setView(next);
    if (next === "chats") props.onCatalog();
    else props.onCloseCatalog?.();
    if (next === "home" || next === "automations" || next === "sites" || next === "settings")
      props.onManagementLoad();
    syncRoute(next, settingsSection);
  };
  const palette = usePaletteItems(props, go);
  return (
    <div className="home-shell" data-view={shown}>
      <CommandPalette items={palette} />
      <HomeTopBar view={shown} activityCount={recentActivityCount(activity)} onView={go} />
      <main className="home-main" data-screen={screenName(shown)}>
        <span id="home-connection" hidden>
          {props.connectionLabel}
        </span>
        {props.developmentFixture && (
          <div className="home-status" role="status">
            <span className="fixture-badge">
              <i /> Development fixture
            </span>
          </div>
        )}
        <HomePage
          view={shown}
          props={props}
          activity={activity}
          settingsSection={settingsSection}
          onSettingsSection={(section) => {
            setSettingsSection(section);
            syncRoute("settings", section);
          }}
          onView={go}
        />
        {props.error && (
          <p id="home-error" className="home-error" role="status" aria-live="polite">
            <span>{props.error}</span>
            {props.onDismissError && (
              <button type="button" aria-label="Dismiss error" onClick={props.onDismissError}>
                ×
              </button>
            )}
          </p>
        )}
      </main>
    </div>
  );
}

function HomePage({
  view,
  props,
  activity,
  settingsSection,
  onSettingsSection,
  onView,
}: {
  view: HomeView;
  props: NewTabHomeProps;
  activity: ReturnType<typeof useActivityLog>;
  settingsSection: SettingsSection;
  onSettingsSection(section: SettingsSection): void;
  onView(view: HomeView): void;
}): ReactElement {
  if (view === "chats" || view === "activity")
    return <ChatsPage view={view} props={props} activity={activity} onView={onView} />;
  if (view === "automations") return <Management props={props} section="automations" />;
  if (view === "sites") return <Management props={props} section="sites" />;
  if (view === "settings")
    return <SettingsPage props={props} section={settingsSection} onSection={onSettingsSection} />;
  return <HomeLanding props={props} onView={onView} />;
}

function HomeLanding({
  props,
  onView,
}: {
  props: NewTabHomeProps;
  onView(view: HomeView): void;
}): ReactElement {
  return (
    <>
      <FirstRunTour />
      <HomeCore working={props.runningChatIds?.size ?? 0} waiting={props.needsChatIds?.size ?? 0} />
      <HomeStart props={props} />
      <HomeDashboard
        chats={props.chats.filter((chat) => !chat.archived)}
        runningChatIds={props.runningChatIds ?? new Set()}
        needsChatIds={props.needsChatIds ?? new Set()}
        {...(props.previews ? { previews: props.previews } : {})}
        runActions={props.runActions}
        openChatIds={props.openChatIds}
        routines={props.homeRoutines}
        watchers={props.managementSnapshot?.routines}
        pins={props.managementSnapshot?.pins}
        onOpenChat={props.onOpenChat}
        onChats={() => onView("chats")}
        onPin={props.onPin}
        onDelete={props.onDelete}
        onWatchers={() => onView("automations")}
      />
    </>
  );
}

/** Chats and Activity (what Aeon changed on sites) share one section. */
function ChatsPage({
  view,
  props,
  activity,
  onView,
}: {
  view: "chats" | "activity";
  props: NewTabHomeProps;
  activity: ReturnType<typeof useActivityLog>;
  onView(view: HomeView): void;
}): ReactElement {
  return (
    <>
      <nav className="home-subtabs" role="tablist" aria-label="Chats">
        {(
          [
            ["chats", "Chats"],
            ["activity", "Activity"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={view === value}
            onClick={() => onView(value)}
          >
            {label}
          </button>
        ))}
      </nav>
      {view === "chats" ? (
        <HomeCatalog {...props} />
      ) : (
        <ActivityPanel
          entries={activity}
          onOpenChat={props.onOpenChat}
          {...(props.onUndoActivity ? { onUndo: props.onUndoActivity } : {})}
        />
      )}
    </>
  );
}

const SETTINGS_TABS: ReadonlyArray<[SettingsSection, string]> = [
  ["settings", "General"],
  ["models", "Models"],
  ["advanced", "Advanced"],
];

function SettingsPage({
  props,
  section,
  onSection,
}: {
  props: NewTabHomeProps;
  section: SettingsSection;
  onSection(section: SettingsSection): void;
}): ReactElement {
  return (
    <div className="home-settings-layout">
      <SettingsMenu section={section} onSection={onSection} />
      <div className="home-settings-body" role="tabpanel">
        {section === "models" ? (
          props.modelAccounts ? (
            <>
              <ModelAccounts {...props.modelAccounts} />
              <BrowserAccounts
                snapshot={props.managementSnapshot ?? null}
                chatId={props.managementSelectedChatId}
                onAction={props.onManagementAction}
              />
            </>
          ) : (
            <p className="aeon-page-empty">Models are not available here.</p>
          )
        ) : section === "advanced" ? (
          <>
            <Management props={props} section="resources" />
            <Management props={props} section="capabilities" />
          </>
        ) : (
          <Management props={props} section={section} />
        )}
      </div>
    </div>
  );
}

function SettingsMenu({
  section,
  onSection,
}: {
  section: SettingsSection;
  onSection(section: SettingsSection): void;
}): ReactElement {
  return (
    <nav className="home-settings-menu" role="tablist" aria-label="Settings sections">
      {SETTINGS_TABS.map(([value, label]) => (
        <button
          key={value}
          type="button"
          role="tab"
          aria-selected={section === value}
          onClick={() => onSection(value)}
        >
          <SettingsIcon section={value} />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}

function SettingsIcon({ section }: { section: SettingsSection }): ReactElement {
  if (section === "models")
    return (
      <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
        <path
          d="M10 2.8 12 7l4.4 2-4.4 2-2 4.2L8 11 3.6 9 8 7Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
    );
  if (section === "advanced")
    return (
      <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
        <path
          d="M8 3h4v3.2a1.8 1.8 0 0 1 2.2 2.2H17v4h-2.8a1.8 1.8 0 0 1-2.2 2.2V17H8v-2.6a1.8 1.8 0 0 1-2.2-2.2H3v-4h2.8A1.8 1.8 0 0 1 8 6.2Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
    );
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
      <path
        d="M4 6h12M4 10h12M4 14h12M7 4v4m6 0v4M5 12v4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Management({
  props,
  section,
}: {
  props: NewTabHomeProps;
  section: ManagementSection;
}): ReactElement {
  return (
    <ManagementSurface
      section={section}
      snapshot={props.managementSnapshot}
      selectedChatId={props.managementSelectedChatId}
      loading={props.managementLoading}
      error={props.managementError}
      connectionLabel={props.connectionLabel}
      theme={props.theme}
      sidebarDefaultOpen={props.sidebarDefaultOpen}
      onRefresh={props.onManagementRefresh}
      onSelectChat={props.onManagementSelectChat}
      onOpenChat={props.onManagementOpenChat}
      onAction={props.onManagementAction}
      onTheme={props.onTheme}
      onSidebarDefault={props.onSidebarDefault}
      {...(props.blockedSites ? { blockedSites: props.blockedSites } : {})}
      {...(props.onBlockedSiteAdd ? { onBlockedSiteAdd: props.onBlockedSiteAdd } : {})}
      {...(props.onBlockedSiteRemove ? { onBlockedSiteRemove: props.onBlockedSiteRemove } : {})}
      {...(props.outsideContext !== undefined ? { outsideContext: props.outsideContext } : {})}
      privacy={props.privacy}
      {...(props.onOutsideContext ? { onOutsideContext: props.onOutsideContext } : {})}
    />
  );
}

/** What ⌘K offers on home: the pages, a new chat, recent chats, and every site's saved actions. */
function usePaletteItems(props: NewTabHomeProps, go: (view: HomeView) => void): PaletteItem[] {
  const sites = props.managementSnapshot?.sites ?? [];
  return useMemo(() => {
    const ask = (text: string) => () => {
      go("home");
      setTimeout(() => window.dispatchEvent(new CustomEvent("aeon.home.seed", { detail: text })));
    };
    const pages: PaletteItem[] = (
      [
        ["chats", "Open chats"],
        ["activity", "See what Aeon changed"],
        ["automations", "Open automations"],
        ["sites", "Open sites"],
        ["settings", "Open settings"],
      ] as const
    ).map(([view, label]) => ({ id: "page:" + view, label, hint: "Go", run: () => go(view) }));
    const siteActions: PaletteItem[] = sites.flatMap((site) =>
      site.abilities.map((ability) => ({
        id: `site:${site.site}:${ability.name}`,
        label: humanize(ability.name),
        hint: site.site,
        run: ask(`Run ${ability.name} on ${site.site}`),
      })),
    );
    const chats: PaletteItem[] = props.chats
      .filter((chat) => !chat.archived)
      .slice(0, 20)
      .map((chat) => ({
        id: "chat:" + chat.chatId,
        label: chat.title,
        hint: "Chat",
        run: () => props.onOpenChat(chat.chatId),
      }));
    return [
      { id: "new", label: "New chat", hint: "Ask Aeon", run: () => props.onNewChat() },
      ...siteActions,
      ...pages,
      ...chats,
    ];
  }, [sites, props.chats, props.onOpenChat, props.onNewChat, go]);
}

/** "/" anywhere on home (outside a field) jumps to the ask box. */
function useSlashToAsk(): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (event.key !== "/" || target?.closest("input, textarea, select, [contenteditable]"))
        return;
      const field = document.getElementById("home-query");
      if (!field) return;
      event.preventDefault();
      field.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}

function screenName(view: HomeView): string {
  if (view === "home") return "new-tab";
  if (view === "chats") return "catalog";
  return "management";
}

/** Keeps `?view=` in step with the page, so reload and Back land on the same page. */
function syncRoute(view: HomeView, section: SettingsSection): void {
  const location = globalThis.location;
  if (!location) return;
  const url = new URL(location.href);
  const value = view === "settings" ? section : view;
  if (view === "home") url.searchParams.delete("view");
  else url.searchParams.set("view", value);
  globalThis.history?.replaceState(globalThis.history.state, "", url.href);
}

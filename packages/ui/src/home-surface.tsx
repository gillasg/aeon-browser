import type { ModelLoginState } from "./connect-model-card.js";
import { useEffect, useState, type ReactElement } from "react";
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
import { ActivityPanel } from "./activity-panel.js";
import { type ActivityEntry, recentActivityCount, useActivityLog } from "./activity-log.js";
import { FirstRunTour } from "./first-run-tour.js";
import { ModelAccounts } from "./model-accounts.js";
import type { ModelAccountsProps } from "./model-accounts-types.js";

export interface NewTabHomeProps {
  developmentFixture: boolean;
  connectionLabel: string;
  connected?: boolean;
  chats: readonly ChatCatalogItemDto[];
  /** Chats whose agent is working right now. */
  runningChatIds?: ReadonlySet<string>;
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
  onDelete?(chat: ChatCatalogItemDto): void;
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
  onTheme(theme: "dark" | "midnight" | "light" | "system"): void;
  onSidebarDefault(open: boolean): void;
}

type SettingsSection = "settings" | "models" | "resources" | "capabilities";

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
    if (next === "home" || next === "watchers" || next === "settings") props.onManagementLoad();
    syncRoute(next, settingsSection);
  };
  return (
    <div className="home-shell" data-view={shown}>
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
            {props.error}
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
  if (view === "chats") return <HomeCatalog {...props} />;
  if (view === "activity")
    return (
      <ActivityPanel
        entries={activity}
        onOpenChat={props.onOpenChat}
        {...(props.onUndoActivity ? { onUndo: props.onUndoActivity } : {})}
      />
    );
  if (view === "watchers") return <Management props={props} section="routines" />;
  if (view === "settings")
    return (
      <>
        <SettingsTabs section={settingsSection} onSection={onSettingsSection} />
        {settingsSection === "models" ? (
          props.modelAccounts ? (
            <ModelAccounts {...props.modelAccounts} />
          ) : (
            <p className="aeon-page-empty">Models are not available here.</p>
          )
        ) : (
          <Management props={props} section={settingsSection} />
        )}
      </>
    );
  return (
    <>
      <FirstRunTour />
      <HomeStart props={props} />
      <HomeDashboard
        chats={props.chats.filter((chat) => !chat.archived)}
        runningChatIds={props.runningChatIds ?? new Set()}
        needsChatIds={props.needsChatIds ?? new Set()}
        openChatIds={props.openChatIds}
        routines={props.homeRoutines}
        watchers={props.managementSnapshot?.routines}
        pins={props.managementSnapshot?.pins}
        onOpenChat={props.onOpenChat}
        onChats={() => onView("chats")}
        onWatchers={() => onView("watchers")}
      />
    </>
  );
}

const SETTINGS_TABS: ReadonlyArray<[SettingsSection, string]> = [
  ["settings", "General"],
  ["models", "Models"],
  ["resources", "Skills & extensions"],
  ["capabilities", "MCPs / CLIs"],
];

function SettingsTabs({
  section,
  onSection,
}: {
  section: SettingsSection;
  onSection(section: SettingsSection): void;
}): ReactElement {
  return (
    <div className="home-settings-tabs" role="tablist" aria-label="Settings sections">
      {SETTINGS_TABS.map(([value, label]) => (
        <button
          key={value}
          type="button"
          role="tab"
          aria-selected={section === value}
          onClick={() => onSection(value)}
        >
          {label}
        </button>
      ))}
    </div>
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
    />
  );
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

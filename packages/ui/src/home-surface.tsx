import { CommandPalette, type PaletteItem } from "./command-palette.js";
import type { PrivacySettingsProps } from "./privacy-settings.js";
import type { ModelLoginState } from "./connect-model-card.js";
import { useEffect, useState, type ReactElement, type ReactNode, useMemo } from "react";
import { usePageTitle } from "./page-title.js";
import type { ChatCatalogItemDto } from "@aeon/protocol";
import { HomeCatalog } from "./home-catalog.js";
import type { ManagementSnapshotDto } from "@aeon/protocol";
import type { PiModelCatalogDto } from "@aeon/protocol";
import type { ComposerModel, ComposerAttachment } from "./chat-composer.js";
import { HomeStart } from "./home-start.js";
import { ManagementSurface } from "./management-surface.js";
import type { ManagementActionName, ManagementSection } from "./management-types.js";
import { ActivityPanel } from "./activity-panel.js";
import { type ActivityEntry, useActivityLog } from "./activity-log.js";
import { hashRoute } from "./manage-route.js";
import { ModelAccounts } from "./model-accounts.js";
import { BrowserAccounts } from "./browser-accounts.js";
import { Segmented } from "./segmented.js";
import { PasswordManagerSettings } from "./password-manager-settings.js";
import { FormsSettings, type FormField } from "./forms-settings.js";
import type { ModelAccountsProps } from "./model-accounts-types.js";
import { AdvancedSettings } from "./advanced-settings.js";
import { MANAGE_NAV, viewFromRoute, type ManageView } from "./manage-nav.js";

export interface NewTabHomeProps {
  developmentFixture: boolean;
  connectionLabel: string;
  connected?: boolean;
  chats: readonly ChatCatalogItemDto[];
  /** Chats whose agent is working right now, and chats waiting on the user (the Chats page). */
  runningChatIds?: ReadonlySet<string>;
  needsChatIds?: ReadonlySet<string>;
  modelCatalog: PiModelCatalogDto | null;
  /** Sign-in progress for "Connect a model". */
  modelLogin?: ModelLoginState;
  /** Opens the model sign-in page (every provider Pi supports). */
  onConnectModel?(): void;
  /** Settings → Models: sign-ins, API keys and the default model. */
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
  /** Puts an example in the side panel's ask box (Manage has no composer of its own). */
  onSuggest?(example: string): void;
  /** Manage → Sites → Teach Aeon: opens the site and starts the Teach recorder there. */
  onTeachSite?(host: string): void;
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
  managementLoading: boolean;
  managementError: string;
  managementSelectedChatId: string;
  theme: "dark" | "midnight" | "light" | "system";
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
  /** Autofill & Sign-in: the form profile, its last refusal, and the user's edits. */
  formProfile?: readonly FormField[];
  formProfileRefused?: string;
  onFormFieldSave?(field: string, value: string): void;
  onFormFieldRemove?(field: string): void;
  privacy?: PrivacySettingsProps;
  /** Outside agents may see the user's open tabs (opt-in, stored by the daemon). */
  outsideContext?: boolean;
  onOutsideContext?(enabled: boolean): void;
  onTheme(theme: "dark" | "midnight" | "light" | "system"): void;
}

/** `#sites?host=…` (how other surfaces open Manage) wins over `?view=`. */
function homeRoute(): ManageView {
  const hash = hashRoute().page;
  if (hash) return viewFromRoute(hash);
  return viewFromRoute(new URLSearchParams(globalThis.location?.search ?? "").get("view"));
}

/** Follows a hash route sent to a Manage tab that is already open. */
function useHashNavigation(onRoute: (view: ManageView) => void): void {
  useEffect(() => {
    const follow = (): void => {
      if (hashRoute().page) onRoute(homeRoute());
    };
    addEventListener("hashchange", follow);
    return () => removeEventListener("hashchange", follow);
  }, []);
}

function inPanel(): boolean {
  return new URLSearchParams(globalThis.location?.search ?? "").get("host") === "panel";
}

/**
 * `home.html` is two things: inside the side panel (`?host=panel`) it is the idle canvas, one
 * calm composer; as a tab it is Manage, one sidebar and the page it picks. No landing page.
 */
export function NewTabHome(props: NewTabHomeProps): ReactElement {
  if (inPanel()) return <PanelIdle props={props} />;
  return <ManageHome props={props} />;
}

function PanelIdle({ props }: { props: NewTabHomeProps }): ReactElement {
  usePageTitle("New chat");
  return (
    <main className="home-main" data-screen="new-tab">
      <span id="home-connection" hidden>
        {props.connectionLabel}
      </span>
      <HomeStart props={props} />
      <HomeError props={props} />
    </main>
  );
}

function ManageHome({ props }: { props: NewTabHomeProps }): ReactElement {
  const [route] = useState(homeRoute);
  const [view, setView] = useState<ManageView>(route);
  const activity = useActivityLog();
  useEffect(() => props.onManagementLoad(), []);
  // The chat list is a page reached from ⌘K; the controller still owns its search state.
  const shown: ManageView = props.catalogOpen ? "chats" : view;
  const go = (next: ManageView): void => {
    setView(next);
    if (next === "chats") props.onCatalog();
    else props.onCloseCatalog?.();
    if (next !== "chats" && next !== "activity") props.onManagementLoad();
    syncRoute(next);
  };
  useHashNavigation(go);
  const palette = usePaletteItems(props, go);
  return (
    <div className="home-shell manage-shell" data-view={shown}>
      <CommandPalette items={palette} />
      <ManageSidebar view={shown} onView={go} />
      <main className="home-main" data-screen={shown === "chats" ? "catalog" : "management"}>
        <span id="home-connection" hidden>
          {props.connectionLabel}
        </span>
        <FixtureBadge on={props.developmentFixture === true} />
        <ManagePage view={shown} props={props} activity={activity} onView={go} />
        <HomeError props={props} />
      </main>
    </div>
  );
}

function ManageSidebar({
  view,
  onView,
}: {
  view: ManageView;
  onView(view: ManageView): void;
}): ReactElement {
  return (
    <nav className="manage-sidebar" aria-label="Manage Aeon">
      <p className="manage-sidebar-title">Aeon</p>
      {MANAGE_NAV.map((item) => (
        <div key={item.view} className="manage-sidebar-slot">
          {item.divided && <hr className="manage-sidebar-divider" />}
          <button
            type="button"
            id={`manage-${item.view}-link`}
            aria-current={view === item.view ? "page" : undefined}
            onClick={() => onView(item.view)}
          >
            {item.label}
          </button>
        </div>
      ))}
    </nav>
  );
}

function FixtureBadge({ on }: { on: boolean }): ReactElement | null {
  if (!on) return null;
  return (
    <div className="home-status" role="status">
      <span className="fixture-badge">Development fixture</span>
    </div>
  );
}

function HomeError({ props }: { props: NewTabHomeProps }): ReactElement | null {
  if (!props.error) return null;
  return (
    <p id="home-error" className="home-error" role="status" aria-live="polite">
      <span>{props.error}</span>
      {props.onDismissError && (
        <button type="button" aria-label="Dismiss error" onClick={props.onDismissError}>
          ×
        </button>
      )}
    </p>
  );
}

function ManagePage({
  view,
  props,
  activity,
  onView,
}: {
  view: ManageView;
  props: NewTabHomeProps;
  activity: ReturnType<typeof useActivityLog>;
  onView(view: ManageView): void;
}): ReactElement {
  if (view === "chats" || view === "activity")
    return <ChatsPage view={view} props={props} activity={activity} onView={onView} />;
  if (view === "sites") return <Management props={props} section="sites" />;
  if (view === "automations") return <Management props={props} section="automations" />;
  if (view === "details") return <DetailsPage props={props} />;
  if (view === "signin") return <SignInPage props={props} />;
  if (view === "advanced") return <AdvancedPage props={props} />;
  return <SettingsPage props={props} />;
}

/** Chats and Activity (what Aeon changed on sites) share one page, reached from ⌘K. */
function ChatsPage({
  view,
  props,
  activity,
  onView,
}: {
  view: "chats" | "activity";
  props: NewTabHomeProps;
  activity: ReturnType<typeof useActivityLog>;
  onView(view: ManageView): void;
}): ReactElement {
  return (
    <div className="aeon-page">
      <header className="aeon-page-head">
        <h1 id="catalog-heading">{view === "chats" ? "Chats" : "Activity"}</h1>
        <Segmented
          label="Chats or activity"
          value={view}
          options={[
            ["chats", "Chats"],
            ["activity", "Activity"],
          ]}
          onChange={onView}
        />
      </header>
      {view === "chats" ? (
        <HomeCatalog {...props} />
      ) : (
        <ActivityPanel
          entries={activity}
          onOpenChat={props.onOpenChat}
          {...(props.onUndoActivity ? { onUndo: props.onUndoActivity } : {})}
        />
      )}
    </div>
  );
}

/** My Details: the personal fields Aeon fills forms with, and nothing else. */
function DetailsPage({ props }: { props: NewTabHomeProps }): ReactElement {
  return (
    <SectionPage title="My Details">
      <FormsSettings
        fields={props.formProfile ?? []}
        refused={props.formProfileRefused}
        onSave={(field, value) => props.onFormFieldSave?.(field, value)}
        onRemove={(field) => props.onFormFieldRemove?.(field)}
      />
    </SectionPage>
  );
}

/** Sign-in: a password manager signs Aeon in (the model never sees a password); you otherwise. */
function SignInPage({ props }: { props: NewTabHomeProps }): ReactElement {
  return (
    <SectionPage title="Sign-in">
      <PasswordManagerSettings
        signIn={props.managementSnapshot?.signIn ?? null}
        loading={props.managementLoading}
      />
    </SectionPage>
  );
}

/** Settings: one page heading, the models Aeon thinks with, then everything general. */
function SettingsPage({ props }: { props: NewTabHomeProps }): ReactElement {
  return (
    <SectionPage title="Settings">
      {props.modelAccounts && (
        <>
          <ModelAccounts {...props.modelAccounts} />
          <BrowserAccounts
            snapshot={props.managementSnapshot ?? null}
            chatId={props.managementSelectedChatId}
            onAction={props.onManagementAction}
          />
        </>
      )}
      <Management props={props} section="settings" subsection />
    </SectionPage>
  );
}

/** Advanced: Developer mode, site-pack import, CLI hints, MCPs and Pi extensions. */
function AdvancedPage({ props }: { props: NewTabHomeProps }): ReactElement {
  const chatId = props.managementSelectedChatId || props.managementSnapshot?.chats[0]?.chatId || "";
  return (
    <>
      <SectionPage title="Advanced">
        <AdvancedSettings chatId={chatId} onAction={props.onManagementAction} />
      </SectionPage>
      <Management props={props} section="capabilities" subsection />
      <Management props={props} section="resources" subsection />
    </>
  );
}

function SectionPage({ title, children }: { title: string; children: ReactNode }): ReactElement {
  usePageTitle(title);
  return (
    <section className="management-main" aria-label={title}>
      <header className="management-heading">
        <h1>{title}</h1>
      </header>
      {children}
    </section>
  );
}

function Management({
  props,
  section,
  subsection = false,
}: {
  props: NewTabHomeProps;
  section: ManagementSection;
  subsection?: boolean;
}): ReactElement {
  return (
    <ManagementSurface
      section={section}
      subsection={subsection}
      snapshot={props.managementSnapshot}
      selectedChatId={props.managementSelectedChatId}
      loading={props.managementLoading}
      error={props.managementError}
      connectionLabel={props.connectionLabel}
      theme={props.theme}
      onRefresh={props.onManagementRefresh}
      onSelectChat={props.onManagementSelectChat}
      onOpenChat={props.onManagementOpenChat}
      onAction={props.onManagementAction}
      onTheme={props.onTheme}
      {...(props.blockedSites ? { blockedSites: props.blockedSites } : {})}
      {...(props.onBlockedSiteAdd ? { onBlockedSiteAdd: props.onBlockedSiteAdd } : {})}
      {...(props.onBlockedSiteRemove ? { onBlockedSiteRemove: props.onBlockedSiteRemove } : {})}
      {...(props.outsideContext !== undefined ? { outsideContext: props.outsideContext } : {})}
      privacy={props.privacy}
      {...(props.onOutsideContext ? { onOutsideContext: props.onOutsideContext } : {})}
      {...(props.onSuggest ? { onSuggest: props.onSuggest } : {})}
      {...(props.onTeachSite ? { onTeachSite: props.onTeachSite } : {})}
    />
  );
}

/** What ⌘K offers in Manage: the pages, a new chat, and recent chats. */
function usePaletteItems(props: NewTabHomeProps, go: (view: ManageView) => void): PaletteItem[] {
  return useMemo(() => {
    const pages: PaletteItem[] = [
      ...MANAGE_NAV.map(({ view, label }) => ({ view, label })),
      { view: "chats" as const, label: "Chats" },
      { view: "activity" as const, label: "What Aeon changed" },
    ].map(({ view, label }) => ({ id: "page:" + view, label, hint: "Go", run: () => go(view) }));
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
      ...pages,
      ...chats,
    ];
  }, [props.chats, props.onOpenChat, props.onNewChat, go]);
}

/** Keeps `?view=` in step with the page, so reload and Back land on the same page. */
function syncRoute(view: ManageView): void {
  const location = globalThis.location;
  if (!location) return;
  const url = new URL(location.href);
  // A hash route is a one-time way in; from here `?view=` keeps the page.
  if (url.hash && !(view === "sites" && hashRoute().page === "sites")) url.hash = "";
  url.searchParams.set("view", view);
  globalThis.history?.replaceState(globalThis.history.state, "", url.href);
}

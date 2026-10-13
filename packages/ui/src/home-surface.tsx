import { SidebarResizer } from "./sidebar-resizer.js";
import type { ModelLoginState } from "./connect-model-card.js";
import { useWallpaper } from "./wallpaper-settings.js";
import { useEffect, useState, type ReactElement } from "react";
import type { ChatCatalogItemDto } from "@aeon/protocol";
import { HomeCatalog } from "./home-catalog.js";
import { HomeSidebar } from "./home-sidebar.js";
import type { ManagementSnapshotDto } from "@aeon/protocol";
import type { HomeRoutineCardDto } from "@aeon/protocol";
import type { PiModelCatalogDto } from "@aeon/protocol";
import type { ComposerModel, ComposerAttachment } from "./chat-composer.js";
import { HomeStart } from "./home-start.js";
import { ManagementSurface } from "./management-surface.js";
import type { ManagementActionName, ManagementSection } from "./management-types.js";

export interface NewTabHomeProps {
  developmentFixture: boolean;
  connectionLabel: string;
  connected?: boolean;
  chats: readonly ChatCatalogItemDto[];
  modelCatalog: PiModelCatalogDto | null;
  /** Sign-in progress for "Connect a model". */
  modelLogin?: ModelLoginState;
  /** Opens the model sign-in page (every provider Pi supports). */
  onConnectModel?(): void;
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
  onCatalog(): void;
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

type RenderedHomeProps = NewTabHomeProps & { onManageRoutines(): void };

export function NewTabHome(props: NewTabHomeProps): ReactElement {
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("aeon-sidebar-expanded") !== "true",
  );
  useEffect(() => {
    localStorage.setItem("aeon-sidebar-expanded", String(!collapsed));
  }, [collapsed]);
  useWallpaper();
  const route = new URLSearchParams(globalThis.location?.search ?? "").get("view");
  const sectionRoute = (["settings", "routines", "resources", "capabilities"] as const).find(
    (value) => value === route,
  );
  const settingsRoute = Boolean(sectionRoute);
  const [management, setManagement] = useState(settingsRoute);
  useEffect(() => {
    if (settingsRoute) props.onManagementLoad();
  }, []);
  const [managementSection, setManagementSection] = useState<ManagementSection>(
    sectionRoute ?? "routines",
  );
  const active = props.chats.filter((chat) => !chat.archived);
  useEffect(() => {
    if (props.catalogOpen || management) setCollapsed(false);
  }, [props.catalogOpen, management]);
  const openSection = (section: ManagementSection): void => {
    setManagement(!(management && managementSection === section));
    setManagementSection(section);
    props.onManagementLoad();
  };
  return (
    <div className="home-shell" data-sidebar-collapsed={String(collapsed)}>
      <HomeSidebar
        developmentFixture={props.developmentFixture}
        onNewChat={() => {
          setManagement(false);
          props.onNewChat();
        }}
        onPin={props.onPin}
        onDelete={(chat) => props.onDelete?.(chat)}
        onCatalog={props.onCatalog}
        onOpenChat={props.onOpenChat}
        management={management}
        managementSection={managementSection}
        onManagementOpen={() => openSection("settings")}
        onManagementSection={openSection}
        onReturnHome={() => setManagement(false)}
        sections={homeSections(active)}
        collapsed={collapsed}
        onCollapse={() => setCollapsed((value) => !value)}
      />
      <SidebarResizer open={!collapsed} onCollapse={() => setCollapsed(true)} />
      <HomeMain
        props={{ ...props, onManageRoutines: () => openSection("routines") }}
        active={active}
        management={management}
        section={managementSection}
      />
    </div>
  );
}

function HomeMain({
  props,
  active,
  management,
  section,
}: {
  props: RenderedHomeProps;
  active: readonly ChatCatalogItemDto[];
  management: boolean;
  section: ManagementSection;
}): ReactElement {
  return (
    <main className="home-main" data-screen={homeScreen(management, props.catalogOpen)}>
      <span id="home-connection" hidden>
        {props.connectionLabel}
      </span>
      <div className="home-status" role="status">
        {props.developmentFixture && (
          <span className="fixture-badge">
            <i /> Development fixture
          </span>
        )}
      </div>
      {management ? (
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
      ) : props.catalogOpen ? (
        <HomeCatalog {...props} />
      ) : (
        <HomeStart props={props} active={active} />
      )}
      {props.error && (
        <p id="home-error" className="home-error" role="status" aria-live="polite">
          {props.error}
        </p>
      )}
    </main>
  );
}

function homeScreen(management: boolean, catalog: boolean): string {
  if (management) return "management";
  if (catalog) return "catalog";
  return "new-tab";
}

function homeSections(active: readonly ChatCatalogItemDto[]) {
  return {
    pinned: active.filter((chat) => chat.pinned),
    projects: active.filter((chat) => chat.projectId !== null),
    recent: active.filter((chat) => !chat.pinned && chat.projectId === null),
  };
}

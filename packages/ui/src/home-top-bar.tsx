import { useEffect, type ReactElement } from "react";

// Home has no sidebar: Chrome's own tabs and sidebar already list open chats. A thin bar takes
// you to each of Aeon's pages instead. Escape, or the page you are on again, returns home.

// Manage's pages, in the order people need them: Models, Sites, Watches, Forms, Blocked, Learn.
// Models, Forms and Blocked are Settings sections; the gear opens the rest of Settings. Chats live
// in the side panel; `?view=chats` and the palette still reach the list here.
export type HomeView =
  "home" | "chats" | "activity" | "automations" | "sites" | "learn" | "settings";

export type NavSection = "models" | "forms" | "blocked";

interface NavItem {
  id: string;
  label: string;
  view: Exclude<HomeView, "home" | "chats" | "activity">;
  section?: NavSection;
}

export const MANAGE_NAV: readonly NavItem[] = [
  { id: "models", label: "Models", view: "settings", section: "models" },
  { id: "sites", label: "Sites", view: "sites" },
  { id: "automations", label: "Watches", view: "automations" },
  { id: "forms", label: "Forms", view: "settings", section: "forms" },
  { id: "blocked", label: "Blocked", view: "settings", section: "blocked" },
  { id: "learn", label: "Learn", view: "learn" },
];

function isCurrent(item: NavItem, view: HomeView, section: string | undefined): boolean {
  if (item.view !== view) return false;
  return item.section === undefined || item.section === section;
}

export function HomeTopBar({
  view,
  section,
  onView,
  onSection,
}: {
  view: HomeView;
  /** The Settings section on show, so Models, Forms and Blocked can say they are current. */
  section?: string;
  onView(view: HomeView): void;
  onSection?(section: NavSection): void;
}): ReactElement {
  useHomeEscape(view, onView);
  const choose = (item: NavItem): void => {
    if (isCurrent(item, view, section)) return onView("home");
    if (item.section && onSection) return onSection(item.section);
    onView(item.view);
  };
  return (
    <header className="home-top-bar">
      <nav className="home-top-nav" aria-label="Aeon pages">
        <HomeButton view={view} onView={onView} />
        {MANAGE_NAV.map((item) => (
          <button
            key={item.id}
            type="button"
            id={`home-${item.id}-link`}
            aria-current={isCurrent(item, view, section) ? "page" : undefined}
            onClick={() => choose(item)}
          >
            {item.label}
          </button>
        ))}
        <button
          type="button"
          className="home-top-gear"
          aria-label="Settings"
          title="Settings"
          aria-current={view === "settings" && !isNavSection(section) ? "page" : undefined}
          onClick={() => onView(view === "settings" ? "home" : "settings")}
        >
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
      </nav>
    </header>
  );
}

function isNavSection(section: string | undefined): boolean {
  return section === "models" || section === "forms" || section === "blocked";
}

/** Escape leaves any page for home, the way the browser's back arrow would. */
function useHomeEscape(view: HomeView, onView: (view: HomeView) => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented || view === "home") return;
      onView("home");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [view, onView]);
}

/** `?view=` to a page. Old page names (routines, watchers, sessions, resources…) still land. */
const ROUTES: Record<string, { view: HomeView; settingsSection?: "settings" | "advanced" }> = {
  routines: { view: "automations" },
  watchers: { view: "automations" },
  automations: { view: "automations" },
  sites: { view: "sites" },
  sessions: { view: "sites" },
  chats: { view: "chats" },
  activity: { view: "activity" },
  learn: { view: "learn" },
  settings: { view: "settings", settingsSection: "settings" },
  advanced: { view: "settings", settingsSection: "advanced" },
  resources: { view: "settings", settingsSection: "advanced" },
  capabilities: { view: "settings", settingsSection: "advanced" },
};

export function viewFromRoute(route: string | null): {
  view: HomeView;
  settingsSection?: "settings" | "advanced";
} {
  return (route && Object.hasOwn(ROUTES, route) && ROUTES[route]) || { view: "home" };
}

function HomeButton({
  view,
  onView,
}: {
  view: HomeView;
  onView(view: HomeView): void;
}): ReactElement {
  return (
    <button
      type="button"
      id="home-home-link"
      className="home-top-home"
      aria-label="Home"
      title="Home"
      aria-current={view === "home" ? "page" : undefined}
      onClick={() => onView("home")}
    >
      <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
        <path d="M3.5 9 10 3.5 16.5 9M5.5 7.8v7.7h9V7.8" />
      </svg>
    </button>
  );
}

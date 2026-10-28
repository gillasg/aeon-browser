import { useEffect, type ReactElement } from "react";

// Home has no sidebar: Chrome's own tabs and sidebar already list open chats. A thin bar takes
// you to each of Aeon's pages instead. Escape, or the page you are on again, returns home.

// Chats (with Activity), Automations, Sites, Learn, and Settings behind the gear.
export type HomeView =
  "home" | "chats" | "activity" | "automations" | "sites" | "learn" | "settings";

const PAGES: ReadonlyArray<[Exclude<HomeView, "home" | "settings" | "activity">, string]> = [
  ["chats", "Chats"],
  ["automations", "Automations"],
  ["sites", "Sites"],
  ["learn", "Learn"],
];

export function HomeTopBar({
  view,
  activityCount,
  onView,
}: {
  view: HomeView;
  activityCount: number;
  onView(view: HomeView): void;
}): ReactElement {
  useHomeEscape(view, onView);
  return (
    <header className="home-top-bar">
      <nav className="home-top-nav" aria-label="Aeon pages">
        <HomeButton view={view} onView={onView} />
        {PAGES.map(([page, label]) => (
          <button
            key={page}
            type="button"
            id={`home-${page}-link`}
            aria-current={
              view === page || (page === "chats" && view === "activity") ? "page" : undefined
            }
            onClick={() => onView(view === page ? "home" : page)}
          >
            {label}
            {page === "chats" && activityCount > 0 && (
              <span className="home-top-count" aria-label={`${activityCount} today`}>
                {activityCount}
              </span>
            )}
          </button>
        ))}
        <button
          type="button"
          className="home-top-gear"
          aria-label="Settings"
          title="Settings"
          aria-current={view === "settings" ? "page" : undefined}
          onClick={() => onView(view === "settings" ? "home" : "settings")}
        >
          <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
            <circle cx="10" cy="10" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path
              d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </nav>
    </header>
  );
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
        <path d="M3.5 9.5 10 4l6.5 5.5M5.5 8.5V16h9V8.5" />
      </svg>
    </button>
  );
}

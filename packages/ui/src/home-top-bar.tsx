import { useEffect, type ReactElement } from "react";

// Home has no sidebar: Chrome's own tabs and sidebar already list open chats. A thin bar takes
// you to each of Aeon's pages instead. Escape, or the page you are on again, returns home.

export type HomeView = "home" | "chats" | "watchers" | "activity" | "settings";

const PAGES: ReadonlyArray<[Exclude<HomeView, "home" | "settings">, string]> = [
  ["chats", "Chats"],
  ["watchers", "Routines"],
  ["activity", "Activity"],
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
        {PAGES.map(([page, label]) => (
          <button
            key={page}
            type="button"
            id={`home-${page}-link`}
            aria-current={view === page ? "page" : undefined}
            onClick={() => onView(view === page ? "home" : page)}
          >
            {label}
            {page === "activity" && activityCount > 0 && (
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

/** `?view=` to a page. The page is Routines; "watchers" is its old name, still in old links. */
export function viewFromRoute(route: string | null): {
  view: HomeView;
  settingsSection?: "settings" | "resources" | "capabilities";
} {
  if (route === "routines" || route === "watchers") return { view: "watchers" };
  if (route === "chats" || route === "activity") return { view: route };
  if (route === "settings" || route === "resources" || route === "capabilities")
    return { view: "settings", settingsSection: route };
  return { view: "home" };
}

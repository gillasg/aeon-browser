// Manage's one sidebar, consumer-first: Automations (schedules, watchers, snipers, webhooks),
// Sites (Site APIs, replays, boosts and account per site), My Details (autofill), Sign-in
// (password managers), Settings; Advanced sits below a divider. Chats and Activity stay reachable
// from ⌘K.

export type ManageView =
  "automations" | "sites" | "details" | "signin" | "settings" | "advanced" | "chats" | "activity";

export interface ManageNavItem {
  view: Exclude<ManageView, "chats" | "activity">;
  label: string;
  /** A divider sits above this item. */
  divided?: boolean;
}

export const MANAGE_NAV: readonly ManageNavItem[] = [
  { view: "automations", label: "Automations" },
  { view: "sites", label: "Sites" },
  { view: "details", label: "My Details" },
  { view: "signin", label: "Sign-in" },
  { view: "settings", label: "Settings" },
  { view: "advanced", label: "Advanced", divided: true },
];

/** `?view=` or `#page` to a page. Old page names (routines, skills, forms, blocked…) still land. */
const ROUTES: Record<string, ManageView> = {
  automations: "automations",
  watches: "automations",
  watchers: "automations",
  routines: "automations",
  schedules: "automations",
  snipers: "automations",
  webhooks: "automations",
  sites: "sites",
  sessions: "sites",
  blocked: "sites",
  skills: "sites",
  abilities: "sites",
  learn: "sites",
  details: "details",
  autofill: "details",
  forms: "details",
  signin: "signin",
  settings: "settings",
  models: "settings",
  advanced: "advanced",
  resources: "advanced",
  capabilities: "advanced",
  chats: "chats",
  activity: "activity",
};

export function viewFromRoute(route: string | null): ManageView {
  return (route && Object.hasOwn(ROUTES, route) && ROUTES[route]) || "sites";
}

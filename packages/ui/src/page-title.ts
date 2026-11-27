import { useEffect } from "react";

/** The tab title for a page: "Graft · Sites". Set on every visit so an old title never lingers. */
export function pageTitle(name: string): string {
  return `Graft · ${name}`;
}

/** `on: false` for a section shown inside another page, which keeps that page's title. */
export function usePageTitle(name: string, on = true): void {
  useEffect(() => {
    if (on && typeof document !== "undefined") document.title = pageTitle(name);
  }, [name, on]);
}

import { useEffect } from "react";

/** The tab title for a page: "Aeon · Sites". Set on every visit so an old title never lingers. */
export function pageTitle(name: string): string {
  return `Aeon · ${name}`;
}

export function usePageTitle(name: string): void {
  useEffect(() => {
    if (typeof document !== "undefined") document.title = pageTitle(name);
  }, [name]);
}

import { useEffect, useState, type ReactElement } from "react";
import { ActionRow, AddRow, SettingsGroup } from "./settings-list.js";

// Sites the agent must never touch. Kept in page localStorage like the other agent settings; the
// extension mirrors it into chrome.storage, where the browser engine reads it at every step.
export const blockedSitesKey = "aeonBlockedSites";

export function readBlockedSites(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(blockedSitesKey) ?? "[]") as unknown;
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

function useBlockedSites(): [string[], (sites: string[]) => void] {
  const [sites, setSites] = useState<string[]>([]);
  useEffect(() => {
    const read = () => setSites(readBlockedSites());
    read();
    window.addEventListener("storage", read);
    window.addEventListener(blockedSitesKey, read);
    return () => {
      window.removeEventListener("storage", read);
      window.removeEventListener(blockedSitesKey, read);
    };
  }, []);
  return [
    sites,
    (next) => {
      localStorage.setItem(blockedSitesKey, JSON.stringify(next));
      setSites(next);
      window.dispatchEvent(new Event(blockedSitesKey));
    },
  ];
}

/** "hdfcbank.com" from whatever the user typed: a URL, a host, with or without www. */
export function siteFromInput(value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : "https://" + text);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return host.includes(".") || host === "localhost" ? host : undefined;
  } catch {
    return undefined;
  }
}

export function BlockedSitesSettings({
  sites: given,
  onAdd,
  onRemove,
}: {
  sites?: readonly string[];
  onAdd?(site: string): void;
  onRemove?(site: string): void;
} = {}): ReactElement {
  const [local, setLocal] = useBlockedSites();
  const sites = given ?? local;
  const add = (value: string): void => {
    const site = siteFromInput(value);
    if (!site || sites.includes(site)) return;
    if (onAdd) onAdd(site);
    else setLocal([...local, site].sort());
  };
  const remove = (site: string): void =>
    onRemove ? onRemove(site) : setLocal(local.filter((item) => item !== site));
  return (
    <div className="settings-groups">
      <SettingsGroup
        title="Blocked sites"
        footer="Aeon never opens, reads or calls these sites or their subdomains, even if a page tells it to. Naming one in your own message lets that run use it."
      >
        {sites.map((site) => (
          <ActionRow key={site} label={site} action="Unblock" onClick={() => remove(site)} />
        ))}
        <AddRow
          label="Site to block"
          placeholder="Block a site, e.g. mybank.com"
          action="Block"
          valid={(value) => {
            const site = siteFromInput(value);
            return Boolean(site && !sites.includes(site));
          }}
          onAdd={add}
        />
      </SettingsGroup>
    </div>
  );
}

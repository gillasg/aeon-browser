import { useEffect, useState, type FormEvent, type ReactElement } from "react";

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
  const [draft, setDraft] = useState("");
  const add = (event: FormEvent) => {
    event.preventDefault();
    const site = siteFromInput(draft);
    if (!site || sites.includes(site)) {
      setDraft("");
      return;
    }
    if (onAdd) onAdd(site);
    else setLocal([...local, site].sort());
    setDraft("");
  };
  return (
    <section className="settings-group">
      <h2>Blocked sites</h2>
      <p>
        The agent never opens, reads or calls these sites (or their subdomains), even if a page
        tells it to. Naming one in your own request lets that run use it.
      </p>
      <form className="settings-inline-form" onSubmit={add}>
        <input
          aria-label="Site to block"
          placeholder="hdfcbank.com"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" disabled={!siteFromInput(draft)}>
          Block
        </button>
      </form>
      <BlockedSiteList
        sites={sites}
        onRemove={(site) =>
          onRemove ? onRemove(site) : setLocal(local.filter((item) => item !== site))
        }
      />
    </section>
  );
}

function BlockedSiteList({
  sites,
  onRemove,
}: {
  sites: readonly string[];
  onRemove(site: string): void;
}): ReactElement | null {
  if (!sites.length) return null;
  return (
    <ul className="settings-site-list">
      {sites.map((site) => (
        <li key={site}>
          <span>{site}</span>
          <button type="button" aria-label={`Unblock ${site}`} onClick={() => onRemove(site)}>
            Unblock
          </button>
        </li>
      ))}
    </ul>
  );
}

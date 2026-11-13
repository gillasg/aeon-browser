// What a page can learn about being driven. The probe runs in the page; the engine adds what
// only it knows (an open Runtime domain, scripts queued for every new document). Detection is
// reported, never hidden: page.stealthCheck() is a diagnostic, not a guarantee.

/** A script the engine queued for every document of a tab, and the world it runs in. */
export interface InjectedScript {
  label: string;
  /** `main` runs in the page's own world (a page can see it); `isolated` cannot be read by page code. */
  world: "main" | "isolated";
}

const injected = new Map<number, InjectedScript[]>();

/** Records a script the engine queued for every document of a tab, so checks can name it. */
export function noteInjectedScript(
  tabId: number,
  label: string,
  world: InjectedScript["world"] = "main",
): void {
  const scripts = injected.get(tabId) ?? [];
  if (!scripts.some((script) => script.label === label)) scripts.push({ label, world });
  injected.set(tabId, scripts);
}

export function injectedScripts(tabId: number): InjectedScript[] {
  return [...(injected.get(tabId) ?? [])];
}

export function forgetStealth(tabId: number): void {
  injected.delete(tabId);
}

export interface StealthProbe {
  webdriver?: boolean;
  globals?: string[];
  overlays?: string[];
  wrapped?: string[];
  geolocationShim?: boolean;
  isolatedNames?: string[];
  /** Wrapped functions or the window carrying enumerable own names/symbols an agent added. */
  leaks?: string[];
}

export interface StealthState {
  runtimeEnabled: boolean;
  injectedScripts: InjectedScript[];
}

export interface StealthReport extends StealthState {
  /** True when a page can observe the agent itself; engine-only metadata does not count. */
  detectable: boolean;
  /** One readable line per signal a page can see. */
  signals: string[];
  /** Engine metadata a page cannot read (isolated worlds, scripts queued for documents). */
  diagnostics: string[];
  probe: StealthProbe;
}

/** Turns the page's observations and the engine's own state into named, readable lines. */
export function judgeStealth(probe: StealthProbe, state: StealthState): StealthReport {
  const signals: string[] = [];
  const diagnostics: string[] = [];
  if (probe.webdriver === true)
    signals.push("navigator.webdriver is true (Chrome is in automation mode)");
  if (state.runtimeEnabled)
    signals.push("the Runtime domain is enabled for this tab (console capture is on)");
  for (const name of probe.globals ?? [])
    signals.push(`a page global named ${name} was added by the agent`);
  for (const name of probe.overlays ?? []) signals.push(`an agent overlay is present: ${name}`);
  for (const name of probe.wrapped ?? [])
    signals.push(`${name} is wrapped and its function source is not native`);
  if (probe.geolocationShim === true)
    signals.push("navigator.geolocation is answered by the agent's location shim");
  for (const name of probe.leaks ?? [])
    signals.push(`a wrapper leaves a detectable property: ${name}`);
  for (const script of state.injectedScripts) {
    if (script.world === "main")
      signals.push(`a script runs in the page's own world on every document: ${script.label}`);
    else
      diagnostics.push(
        `an isolated-world helper of Aeon's runs here (page code cannot read it): ${script.label}`,
      );
  }
  return {
    detectable: signals.length > 0,
    signals,
    diagnostics,
    runtimeEnabled: state.runtimeEnabled,
    injectedScripts: state.injectedScripts,
    probe,
  };
}

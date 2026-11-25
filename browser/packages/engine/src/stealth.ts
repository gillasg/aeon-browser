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

/** A tap the engine armed on a tab: what it wraps, the world it runs in, whether it needs Runtime. */
export interface ArmedTap {
  label: string;
  world: "main" | "isolated";
  /** Page functions the tap replaces while armed (restored when it disarms). */
  wraps: string[];
  /** The tap needs the Runtime domain (bindings, evaluation). */
  runtime: boolean;
}

// The tap ledger: every tap arms and disarms here, so stealthCheck reports exactly what is on.
const taps = new Map<number, Map<string, ArmedTap>>();

/** Records an armed tap. Arming the same label twice keeps one entry. */
export function armTap(tabId: number, tap: ArmedTap): void {
  const armed = taps.get(tabId) ?? new Map<string, ArmedTap>();
  armed.set(tap.label, { ...tap, wraps: [...tap.wraps] });
  taps.set(tabId, armed);
}

/** Forgets a tap. Returns whether any tap still armed on the tab needs the Runtime domain. */
export function disarmTap(tabId: number, label: string): { runtimeInUse: boolean } {
  const armed = taps.get(tabId);
  armed?.delete(label);
  if (armed && armed.size === 0) taps.delete(tabId);
  return { runtimeInUse: tapsNeedRuntime(tabId) };
}

export function activeTaps(tabId: number): ArmedTap[] {
  return [...(taps.get(tabId)?.values() ?? [])].map((tap) => ({ ...tap, wraps: [...tap.wraps] }));
}

export function tapsNeedRuntime(tabId: number): boolean {
  return activeTaps(tabId).some((tap) => tap.runtime);
}

export function forgetStealth(tabId: number): void {
  injected.delete(tabId);
  taps.delete(tabId);
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
  /** Taps armed on the tab right now (from the ledger). */
  activeTaps?: ArmedTap[];
}

export interface StealthReport extends StealthState {
  activeTaps: ArmedTap[];
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
  const armed = state.activeTaps ?? [];
  if (state.runtimeEnabled) {
    const users = armed.filter((tap) => tap.runtime).map((tap) => tap.label);
    signals.push(
      users.length
        ? `the Runtime domain is enabled for this tab (used by: ${users.join(", ")})`
        : "the Runtime domain is enabled for this tab (console capture is on)",
    );
  }
  for (const tap of armed) judgeTap(tap, signals, diagnostics);
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
    activeTaps: armed,
    probe,
  };
}

function judgeTap(tap: ArmedTap, signals: string[], diagnostics: string[]): void {
  if (tap.world === "isolated" && tap.wraps.length === 0) {
    diagnostics.push(`an isolated-world tap is armed (page code cannot read it): ${tap.label}`);
    return;
  }
  const wraps = tap.wraps.length ? ` (wraps ${tap.wraps.join(", ")})` : "";
  signals.push(`a tap is armed in the page's own world: ${tap.label}${wraps}`);
}

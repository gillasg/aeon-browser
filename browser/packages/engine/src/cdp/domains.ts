// DOM and Accessibility turn on at the first call that needs them, not at attach.
// Network is not here: it turns on at the first action (see ensureNetwork in the session).

const lazy = new Set(["DOM", "Accessibility"]);
const enabled = new Map<number, Set<string>>();
const inflight = new Map<number, Map<string, Promise<void>>>();
let noteFailure: (label: string) => void = () => undefined;

/** `send` registers this. A failed domain enable is a CDP failure, same as a failed command. */
export function setDomainFailureNote(note: (label: string) => void): void {
  noteFailure = note;
}

/**
 * Starts `Domain.enable` in this turn when the method needs a lazy domain that is still off.
 * The domain is marked only after enable resolves. Concurrent callers share that in-flight
 * promise. Enable is sent on the same debuggee, including `sessionId`. A failure is counted
 * and left unmarked, so the next call retries. The promise still resolves when enable fails.
 * Undefined means nothing to wait for. A caller that has already timed out must not send its
 * command after this resolves.
 */
export function beginLazyDomain(
  debuggee: chrome.debugger.Debuggee,
  method: string,
): Promise<void> | undefined {
  const domain = method.split(".")[0] ?? "";
  if (!lazy.has(domain) || method.endsWith(".enable")) return undefined;
  const tabId = debuggee.tabId;
  if (tabId === undefined || has(tabId, domain)) return undefined;
  const pending = inflight.get(tabId)?.get(domain);
  if (pending) return pending;
  const work = enableDomain(debuggee, tabId, domain);
  const domains = inflight.get(tabId) ?? new Map<string, Promise<void>>();
  domains.set(domain, work);
  inflight.set(tabId, domains);
  return work;
}

export function forgetDomains(tabId: number): void {
  enabled.delete(tabId);
  inflight.delete(tabId);
}

function enableDomain(
  debuggee: chrome.debugger.Debuggee,
  tabId: number,
  domain: string,
): Promise<void> {
  const work = chrome.debugger.sendCommand(debuggee, `${domain}.enable`).then(
    () => {
      mark(tabId, domain);
    },
    () => {
      noteFailure(`${domain}.enable`);
    },
  );
  void work.finally(() => {
    const domains = inflight.get(tabId);
    if (domains?.get(domain) !== work) return;
    domains.delete(domain);
    if (domains.size === 0) inflight.delete(tabId);
  });
  return work;
}

function has(tabId: number, domain: string): boolean {
  return enabled.get(tabId)?.has(domain) === true;
}

function mark(tabId: number, domain: string): void {
  const set = enabled.get(tabId) ?? new Set<string>();
  set.add(domain);
  enabled.set(tabId, set);
}

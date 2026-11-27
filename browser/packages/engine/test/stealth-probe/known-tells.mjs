// Known stealth tells pinned against Graft's current engine.
// Every pin tolerates only that exact signal; any pin that stops firing fails the probe as stale
// so fixes must remove their pin in the same change.

export const knownTells = [
  {
    id: "navigator-webdriver",
    note: "Chrome for Testing launched with --headless=new in the test harness reports navigator.webdriver === true; real user Chrome does not. Stale-pin detection will fail as soon as this clears.",
  },
];

export const STEALTH_CHECKS = [
  {
    id: "navigator-webdriver",
    expected: "navigator.webdriver is false",
    pass: (s) => s.webdriver === false,
  },
  {
    id: "chrome-runtime-hidden",
    expected: "window.chrome.runtime.id is not exposed to web pages",
    pass: (s) => s.chromeRuntimeIdExposed === false,
  },
  {
    id: "no-cdp-globals",
    expected: "no automation globals (cdc_*, __webdriver*, __graft*) on window or document",
    pass: (s) => Array.isArray(s.cdpGlobals) && s.cdpGlobals.length === 0,
  },
  {
    id: "no-runtime-enable-trap",
    expected: "console.debug(Error) does not invoke custom Error.stack getter via Runtime.enable",
    pass: (s) => s.runtimeEnableTrap === false,
  },
  {
    id: "no-stack-leak",
    expected: "Error.stack contains no chrome-extension:// or harness markers",
    pass: (s) => Array.isArray(s.stackLeakMarkers) && s.stackLeakMarkers.length === 0,
  },
  {
    id: "no-dom-expandos",
    expected: "no __graft* expandos or chrome-extension:// iframes leaked into host DOM",
    pass: (s) => Array.isArray(s.domExpandos) && s.domExpandos.length === 0,
  },
  {
    id: "languages-present",
    expected: "navigator.languages is non-empty",
    pass: (s) => Number(s.languagesCount) > 0,
  },
  {
    id: "permissions-api-ok",
    expected: "navigator.permissions.query resolves normally",
    pass: (s) => s.permissionsOk === true,
  },
  {
    id: "trusted-click",
    expected: "page.click dispatches isTrusted=true mouse events with non-zero coordinates",
    pass: (s) => s.allClicksTrusted === true && s.clicksHaveCoords === true,
  },
  {
    id: "trusted-input",
    expected: "page.fill dispatches trusted input events and sets the field value",
    pass: (s) => s.allInputsTrusted === true && s.inputValue === "hello graft",
  },
];

export function evaluateStealthSnapshot(snapshot, pins = knownTells) {
  const pinMap = new Map(pins.map((pin) => [pin.id, pin]));
  const unpinnedFailures = [];
  const pinnedFailures = [];
  const stalePins = [];
  const passed = [];

  for (const check of STEALTH_CHECKS) {
    const ok = Boolean(check.pass(snapshot));
    const pin = pinMap.get(check.id);
    if (ok) {
      passed.push(check.id);
      if (pin) stalePins.push(pin);
    } else if (pin) {
      pinnedFailures.push({ id: check.id, expected: check.expected, note: pin.note });
    } else {
      unpinnedFailures.push({ id: check.id, expected: check.expected });
    }
  }

  return { passed, pinnedFailures, unpinnedFailures, stalePins };
}

// Which tab an ability's page work runs in: the caller's tab when it is on the ability's origin,
// else the user's open tab of that origin (the active one first), else one background tab opened
// on the site. A tab on another origin is never used. The code sets `__tab` in the cell.

const CONTROL_ROLES = [
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "listbox",
  "slider",
  "spinbutton",
];

export function siteTabCode(home: string, callerTab?: number): string {
  const origin = new URL(home).origin;
  return `
const __origin = ${JSON.stringify(origin)};
const __onOrigin = async (t) => { try { return new URL(String(await t.url())).origin === __origin; } catch { return false; } };
const __store = (globalThis.__abilityTabs ??= {});
let __tab;
${callerTab === undefined ? "" : `try { const __caller = await browser.tab(${JSON.stringify(callerTab)}); if (await __onOrigin(__caller)) __tab = __caller; } catch { __tab = undefined; }`}
if (!__tab && __store[__origin] && await __onOrigin(__store[__origin])) __tab = __store[__origin];
if (!__tab) {
  try {
    const __same = (await browser.tabs()).filter((t) => { try { return !t.heldByOther && !t.graftUi && new URL(t.url).origin === __origin; } catch { return false; } });
    const __own = __same.find((t) => t.active) || __same[0];
    if (__own) __tab = await browser.attachTab(__own.target);
  } catch { __tab = undefined; }
  if (!__tab) __tab = await browser.openTab(${JSON.stringify(home)}, { active: false });
  __store[__origin] = __tab;
}
`;
}

/** A script cell: `fn(page, bu, inputs)` on the site's tab; a throw comes back with whether the page was touched. */
export function siteScriptCode(
  home: string,
  code: string,
  inputs: unknown,
  callerTab?: number,
): string {
  return `(async () => {
${siteTabCode(home, callerTab)}
const __fn = (${code});
let __acted = 0;
let __watch = false;
const __orig = typeof __step === "function" ? __step : undefined;
const __acts = ["click","hold","fill","press","scroll","navigate","evaluate","cdp","upload","pointer","keys"];
try { if (__orig) { __step = async function (s, ro) { if (!ro && s && __acts.includes(s.op)) __acted++; return __orig.apply(this, arguments); }; __watch = true; } } catch { __watch = false; }
try { return await __fn(__tab, bu, ${JSON.stringify(inputs)}); }
catch (e) { return { __abilityScriptError: String((e && e.message) || e), touched: !__watch || __acted > 0 }; }
finally { if (__watch) __step = __orig; }
})()`;
}

/** The site tab's controls, as {role, name, text}. */
export function siteControlsCode(home: string, callerTab?: number): string {
  return `(async () => {
${siteTabCode(home, callerTab)}
const __roles = new Set(${JSON.stringify(CONTROL_ROLES)});
const __snap = await __tab.snapshot({});
return (__snap.nodes || []).filter((n) => __roles.has(n.role) && n.name).map((n) => ({ role: n.role, name: String(n.name), text: String(n.name) }));
})()`;
}

/** One saved step through the engine's normal click/fill/select, with its overlay and receipt checks. */
export function siteActCode(
  home: string,
  step: { kind: string; args?: string[]; target?: { role?: string; name?: string } },
  callerTab?: number,
): string {
  const action = {
    method: step.kind,
    args: step.args ?? [],
    ...(step.target?.role ? { role: step.target.role } : {}),
    ...(step.target?.name !== undefined ? { name: step.target.name } : {}),
  };
  return `(async () => {
${siteTabCode(home, callerTab)}
return await __tab.act(${JSON.stringify(action)}, { cache: false });
})()`;
}

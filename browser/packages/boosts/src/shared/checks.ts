import type { Boost, SiteRule } from "./types.js";

// Save-time checks: what is wrong with a boost before it ever runs. Each finding is a warning the
// agent sees in the save reply; nothing here runs the boost's code.

export interface Warning {
  code: string;
  message: string;
}

const SCHEMES = new Set(["*", "http", "https", "ws", "wss", "file", "ftp", "urn"]);
const HOST = /^(\*|(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*|\[[0-9a-f:]+\])(:(\d+|\*))?$/i;

/** Why a Chrome match pattern can never match, or undefined when it is valid. */
export function matchPatternProblem(pattern: string): string | undefined {
  if (pattern === "<all_urls>" || pattern === "*") return undefined;
  const parsed = /^([^:/]+):\/\/([^/]*)(\/.*)?$/.exec(pattern);
  if (!parsed) return "it needs a scheme and a host, like https://example.com/*";
  const [, scheme = "", host = "", path] = parsed;
  if (!SCHEMES.has(scheme.toLowerCase())) return `"${scheme}" is not a scheme (use http or https)`;
  if (scheme !== "file" && !HOST.test(host)) return `"${host}" is not a host name`;
  if (!path) return "it needs a path, such as /*";
  return undefined;
}

function urlProblem(value: string): string | undefined {
  try {
    const url = new URL(value);
    return /^(https?|wss?|file|ftp):$/.test(url.protocol)
      ? undefined
      : `"${url.protocol}" is not a web scheme`;
  } catch {
    return "it is not a full URL with a scheme and a host";
  }
}

function globProblem(value: string): string | undefined {
  if (/\s/.test(value)) return "it contains spaces";
  if (!value.includes("://")) return undefined;
  const scheme = value.slice(0, value.indexOf("://"));
  return /^(\*|https?\*?|wss?|file|ftp)$/i.test(scheme)
    ? undefined
    : `"${scheme}" is not a scheme (use http, https or *)`;
}

/** Why one site rule can never match, or undefined when it is fine. */
export function siteRuleProblem(rule: SiteRule): string | undefined {
  const value = rule.value ?? "";
  switch (rule.type) {
    case "all":
      return undefined;
    case "domain":
      return HOST.test(value.replace(/^www\./i, "")) ? undefined : `"${value}" is not a host name`;
    case "match":
      return matchPatternProblem(value);
    case "glob":
      return globProblem(value);
    case "prefix":
    case "url":
      return urlProblem(value);
    case "regex":
      try {
        new RegExp(value);
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    default:
      return "unknown rule type";
  }
}

/** One finding per site rule (and exclude rule) that can never match. */
export function siteRuleWarnings(boost: Pick<Boost, "sites" | "excludes">): Warning[] {
  return [...boost.sites, ...(boost.excludes ?? [])].flatMap((rule) => {
    const problem = siteRuleProblem(rule);
    return problem
      ? [
          {
            code: "BAD_SITE_RULE",
            message: `BAD_SITE_RULE: ${JSON.stringify(rule.value ?? rule.type)} can never match: ${problem}. Use a host ("example.com"), a match pattern ("https://example.com/path/*") or {type:'glob'|'regex', value}.`,
          },
        ]
      : [];
  });
}

/** The selectors a boost gives directly: zaps, added HTML and widgets, and actions. */
export function boostSelectorList(boost: Boost): string[] {
  const out = new Set<string>();
  for (const zap of boost.zaps ?? []) if (zap.selector) out.add(zap.selector);
  for (const part of [...(boost.html ?? []), ...(boost.widgets ?? [])])
    if (part.selector) out.add(part.selector);
  for (const action of boost.actions ?? [])
    if ("selector" in action && action.selector) out.add(action.selector);
  return [...out];
}

/**
 * Selector findings. `valid` answers with a real CSS parser where one exists (a document); the
 * service worker has none, so it falls back to `selectorProblem`.
 */
export function selectorWarnings(
  boost: Boost,
  valid: (selector: string) => string | undefined = selectorProblem,
): Warning[] {
  return boostSelectorList(boost).flatMap((selector) => {
    const problem = valid(selector);
    return problem
      ? [
          {
            code: "BAD_SELECTOR",
            message: `BAD_SELECTOR: ${JSON.stringify(selector)} is not valid CSS (${problem}); it will never match.`,
          },
        ]
      : [];
  });
}

/** A real parse with the DOM's own CSS parser, when this context has a document. */
export function domSelectorProblem(selector: string): string | undefined {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc) return selectorProblem(selector);
  try {
    doc.createDocumentFragment().querySelector(selector);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const CLOSERS: Record<string, string> = { "[": "]", "(": ")" };

interface Scan {
  stack: string[];
  quote: string;
}

function closeProblem(scan: Scan, ch: string): string | undefined {
  return CLOSERS[scan.stack.pop() ?? ""] === ch ? undefined : `an unmatched ${ch}`;
}

/** One character of a selector; a problem, or undefined to go on. */
function step(scan: Scan, ch: string): string | undefined {
  if (scan.quote) {
    if (ch === scan.quote) scan.quote = "";
    return undefined;
  }
  if (ch === '"' || ch === "'") scan.quote = ch;
  else if (ch === "[" || ch === "(") {
    if (ch === "[" && scan.stack.at(-1) === "[") return "a [ inside another [";
    scan.stack.push(ch);
  } else if (ch === "]" || ch === ")") return closeProblem(scan, ch);
  return undefined;
}

/** Brackets and quotes balance, and an attribute selector never opens inside another. */
function bracketProblem(text: string): string | undefined {
  const scan: Scan = { stack: [], quote: "" };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === "\\") i++;
    else {
      const problem = step(scan, ch);
      if (problem) return problem;
    }
  }
  if (scan.quote) return "an unclosed quote";
  return scan.stack.length ? `an unclosed ${scan.stack.at(-1)}` : undefined;
}

/** Structural CSS selector check for contexts without a DOM: brackets, quotes, combinators. */
export function selectorProblem(selector: string): string | undefined {
  const text = selector.trim();
  if (!text) return "it is empty";
  return bracketProblem(text) ?? combinatorProblem(text);
}

function combinatorProblem(text: string): string | undefined {
  // Outside brackets and parentheses: no empty list items or dangling combinators.
  const flat = text.replace(/\[[^\]]*\]|\([^)]*\)|"[^"]*"|'[^']*'/g, "x");
  if (flat.split(",").some((part) => !part.trim())) return "an empty item in a selector list";
  if (/[>+~]\s*$/.test(flat) || /^\s*[>+~]/.test(flat)) return "a combinator with nothing after it";
  if (/[>+~]\s*[>+~]/.test(flat)) return "two combinators in a row";
  if (/\[\s*\]/.test(text)) return "an empty attribute selector";
  return undefined;
}

/** A strict page CSP seen on this host, for page-world scripts. */
export function cspWarning(host: string, directive: string): Warning {
  return {
    code: "PAGE_WORLD_STRICT_CSP",
    message: `PAGE_WORLD_STRICT_CSP: ${host} enforced a strict Content-Security-Policy (${directive}) on its last load. In jsWorld 'page' inline <style>, style="" and innerHTML (Trusted Types) fail silently there: use GM_addStyle / GM_addElement, or jsWorld 'isolated'.`,
  };
}

/** The wrapper the script's code runs in, for a syntax check (compiled, never run). */
export const syntaxWrapper = (js: string): string =>
  `(async function () { try {\n${js}\n} catch (error) {} })`;

export function syntaxWarning(message: string): Warning {
  return {
    code: "JS_SYNTAX",
    message: `JS_SYNTAX: the js does not parse (${message}); it was saved but will not run until fixed.`,
  };
}

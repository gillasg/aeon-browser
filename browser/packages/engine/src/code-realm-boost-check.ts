// The js syntax check for browser.boosts.save. The extension's service worker cannot compile
// code (its CSP forbids eval), so the realm host compiles the script here, in the same wrapper it
// runs in, without ever running it, and adds a JS_SYNTAX warning to the save reply.
import vm from "node:vm";

type Reply = { value?: unknown; error?: string };

export function boostSyntaxProblem(js: string): string | undefined {
  try {
    new vm.Script(`(async function () { try {\n${js}\n} catch (error) {} })`, {
      filename: "boost.js",
    });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function withBoostSyntax(request: unknown, reply: Reply): Reply {
  const value = request as { boosts?: unknown; boost?: { js?: unknown } } | null;
  if (value?.boosts !== "save" || typeof value.boost?.js !== "string") return reply;
  const saved = reply.value as Record<string, unknown> | null | undefined;
  if (!saved || typeof saved !== "object") return reply;
  const problem = boostSyntaxProblem(value.boost.js);
  if (!problem) return reply;
  const message = `JS_SYNTAX: the js does not parse (${problem}); it was saved but will not run until fixed.`;
  const warnings = [
    ...(Array.isArray(saved.warnings) ? saved.warnings : []),
    { code: "JS_SYNTAX", message },
  ];
  const warning = [saved.warning, message].filter(Boolean).join("\n");
  return { ...reply, value: { ...saved, warnings, warning } };
}

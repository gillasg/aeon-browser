// Ban chrome.debugger.sendCommand outside cdp/: every CDP call goes through send(), which bounds,
// names and records it.
import tseslint from "typescript-eslint";

const SRC = "browser/packages/engine/src";

const SEND_COMMAND = {
  selector:
    "CallExpression[callee.property.name='sendCommand'][callee.object.property.name='debugger'][callee.object.object.name='chrome']",
  message: "Call send() from cdp/send.ts. chrome.debugger.sendCommand stays inside cdp/.",
};

export default [
  {
    files: [`${SRC}/**/*.ts`],
    ignores: [`${SRC}/cdp/**`],
    languageOptions: { parser: tseslint.parser },
    rules: { "no-restricted-syntax": ["error", SEND_COMMAND] },
  },
];

// Ban chrome.debugger.sendCommand outside cdp/. The allow-list is the S2/S3/S4 call-site
// slices, which are migrating in parallel. removed when those slices merge.
import tseslint from "typescript-eslint";

const SRC = "browser/packages/engine/src";

const SLICE_ALLOW = [
  "native-browser-input.ts",
  "native-browser-human-input.ts",
  "native-browser-scroll.ts",
  "native-browser-cursor.ts",
  "native-browser-dry-run.ts",
  "native-browser-dom.ts",
  "native-browser-frames.ts",
  "native-browser-observation.ts",
  "native-browser-preview.ts",
  "native-browser-navigation.ts",
  "native-browser-events.ts",
  "native-browser-network.ts",
  "native-browser-executor.ts",
  "native-browser-recording.ts",
].map((name) => `${SRC}/${name}`);

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
  {
    // removed when those slices merge
    files: SLICE_ALLOW,
    rules: { "no-restricted-syntax": "off" },
  },
];

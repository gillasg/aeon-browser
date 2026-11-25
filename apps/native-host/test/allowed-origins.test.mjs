import assert from "node:assert/strict";
import test from "node:test";
import { allowedOrigins, storeExtensionIds } from "../scripts/allowed-origins.mjs";

const DEV = "npcdopokfkpfmepknhoecppgdgmkmihh";
const CWS = "abcdefghijklmnopabcdefghijklmnop";
const EDGE = "ponmlkjihgfedcbaponmlkjihgfedcba";

test("default: only the unpacked dev origin", () => {
  assert.deepEqual(storeExtensionIds({}), []);
  assert.deepEqual(allowedOrigins(DEV, storeExtensionIds({})), [`chrome-extension://${DEV}/`]);
});

test("store ids add Chrome Web Store and Edge origins after the dev id, once each", () => {
  const ids = storeExtensionIds({ AEON_STORE_EXTENSION_IDS: `${CWS}, ${EDGE} ${CWS},${DEV}` });
  assert.deepEqual(allowedOrigins(DEV, ids), [
    `chrome-extension://${DEV}/`,
    `chrome-extension://${CWS}/`,
    `chrome-extension://${EDGE}/`,
  ]);
});

test("a malformed id is refused", () => {
  assert.throws(() => storeExtensionIds({ AEON_STORE_EXTENSION_IDS: "not-an-id" }), /Not an/);
});

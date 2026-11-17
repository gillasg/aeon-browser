// page.setLocation() presets a point even when the OS will not give the real one. On macOS the
// real geolocation call can stay unanswered instead of denying, so the shim must also have a
// deadline: a page that asks for the position cannot hang until the cell times out.
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { browserCodeApi } from "../dist/code-api.js";

const shim = /function __geolocationShim\(coords\) \{[\s\S]*?\n\}/.exec(browserCodeApi)?.[0];
assert.ok(shim, "the browser_code API carries the geolocation shim");

function install(real) {
  const context = vm.createContext({
    navigator: { geolocation: { getCurrentPosition: real, watchPosition: real } },
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(
    "Function.prototype.toString = () => 'function getCurrentPosition() { [native code] }'",
    context,
  );
  vm.runInContext(
    `${shim}\n__geolocationShim({ latitude: 28.61, longitude: 77.21, accuracy: 50 })`,
    context,
  );
  return context.navigator.geolocation;
}

function latitude(geo) {
  return new Promise((resolve) =>
    geo.getCurrentPosition(
      (position) => resolve(position.coords.latitude),
      (error) => resolve("error " + error.code),
    ),
  );
}

test("a location service that never answers falls back to the preset point", async () => {
  const got = await latitude(install(() => undefined));
  assert.equal(got, 28.61);
});

test("a real answer still wins over the preset point", async () => {
  const got = await latitude(install((ok) => ok({ coords: { latitude: 12.34 } })));
  assert.equal(got, 12.34);
});

test("a denied request still falls back, and another error still fails", async () => {
  const denied = await latitude(install((_ok, fail) => fail({ code: 1 })));
  assert.equal(denied, 28.61);
  const failed = await latitude(install((_ok, fail) => fail({ code: 2 })));
  assert.equal(failed, "error 2");
});

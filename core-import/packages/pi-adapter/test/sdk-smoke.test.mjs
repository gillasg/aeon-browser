import assert from "node:assert/strict";
import test from "node:test";
import { EXPECTED_PI_SDK_VERSION, inspectPiSdkRuntimeSurface } from "../dist/probe.js";

test("pinned Pi SDK public session surface imports without creating a session", () => {
  const surface = inspectPiSdkRuntimeSurface();
  assert.equal(surface.version, EXPECTED_PI_SDK_VERSION);
  assert.equal(surface.factory, true);
  assert.ok(Object.values(surface.sessionMethods).every(Boolean));
  assert.ok(Object.values(surface.sessionAccessors).every(Boolean));
  assert.ok(Object.values(surface.sessionManagerFactories).every(Boolean));
  assert.ok(Object.values(surface.sessionManagerMethods).every(Boolean));
  assert.ok(Object.values(surface.sessionRuntimeMethods).every(Boolean));
  assert.ok(Object.values(surface.extensionRunnerMethods).every(Boolean));
  assert.ok(Object.values(surface.resourceLoaderMethods).every(Boolean));
  assert.ok(Object.values(surface.providerSetupExports).every(Boolean));
});

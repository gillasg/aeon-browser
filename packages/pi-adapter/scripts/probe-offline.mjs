import { inspectPiSdkRuntimeSurface } from "../dist/probe.js";

const surface = inspectPiSdkRuntimeSurface();
const result = {
  probe: "pi-sdk-public-surface",
  package: "@earendil-works/pi-coding-agent",
  version: surface.version,
  sessionCreated: false,
  providerRequestSent: false,
  surface,
};

if (!surface.factory) throw new Error("The pinned package does not export createAgentSession.");
if (Object.values(surface.sessionMethods).some((present) => !present)) {
  throw new Error("A recorded public AgentSession method is missing at runtime.");
}

process.stdout.write(`${JSON.stringify(result)}\n`);

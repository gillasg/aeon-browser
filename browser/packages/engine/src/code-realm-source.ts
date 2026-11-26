// The browser_code runtime source, in the order a realm evaluates it. Every part is JavaScript
// kept in a template string; code-realm.ts evaluates the joined list once per realm.
import { browserCodeApi } from "./code-api.js";
import { browserFastApi } from "./code-api-page.js";
import { browserCapabilityApi, browserDocumentApi } from "./code-api-hooks.js";
import { browserPlaywrightApi } from "./code-api-playwright.js";
import { browserDataApi } from "./code-api-data.js";
import { browserListApi } from "./code-api-list.js";
import { browserScrollersApi } from "./code-api-scrollers.js";
import { browserEventsApi } from "./code-api-events.js";
import { browserDemonstrationApi } from "./code-api-demonstration.js";
import { browserRecordingApi } from "./code-api-recording.js";
import { browserSitesApi } from "./code-api-sites.js";
import { browserContextApi } from "./code-api-context.js";
import { browserSnipeApi } from "./code-api-snipe.js";
import { browserProfilesApi } from "./code-api-profiles.js";
import { browserTimingApi } from "./code-api-timing.js";
import { browserTablesApi } from "./code-api-tables.js";
import { browserHelpApi } from "./code-api-help.js";
import { browserControlsApi } from "./code-api-controls.js";
import { browserMediaChallengesApi } from "./code-api-media-challenges.js";
import { browserMediaApi } from "./code-media-api.js";
import { browserClawsApi } from "./code-api-claws.js";
import { browserRound3ClawsApi } from "./code-api-round3-claws.js";
import { browserVisualMediaClawsApi } from "./code-api-visual-media-claws.js";
import { browserSurfaceApi, browserWindowApi } from "./code-api-surface.js";
import { browserActApi } from "./code-api-act.js";
import { browserSleepApi } from "./code-api-sleep.js";
import { browserSpeedApi } from "./code-api-speed.js";
import { browserMcpApi } from "./code-api-mcp.js";
import { browserL2Api } from "./code-api-l2.js";
import { browserStorageClawsApi } from "./code-api-storage-claws.js";
import { browserWhyApi } from "./code-api-why.js";

/** The whole runtime, evaluated into each fresh realm before its first cell. */
export function realmRuntimeSource(evaluate: (source: string) => unknown): void {
  evaluate(
    [
      browserWindowApi,
      browserVisualMediaClawsApi,
      browserSurfaceApi,
      browserMediaApi,
      browserTimingApi,
      browserCodeApi,
      browserSitesApi,
      browserContextApi,
      browserSnipeApi,
      browserProfilesApi,
      browserTablesApi,
      browserHelpApi,
      browserFastApi,
      browserCapabilityApi,
      browserDocumentApi,
      browserPlaywrightApi,
      browserDataApi,
      browserListApi,
      browserScrollersApi,
      browserEventsApi,
      browserRecordingApi,
      browserDemonstrationApi,
      browserControlsApi,
      browserMediaChallengesApi,
      browserActApi,
      browserSleepApi,
      browserSpeedApi,
      browserMcpApi,
      browserClawsApi,
      browserStorageClawsApi,
      browserRound3ClawsApi,
      browserWhyApi,
      browserL2Api,
    ].join("\n"),
  );
}

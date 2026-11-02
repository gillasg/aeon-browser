import type { ReactElement } from "react";
import type { ManagementSection } from "./management-types.js";
import type { ManagementSurfaceProps } from "./management-surface-props.js";
import { RoutinesPanel } from "./management-routines.js";
import { SitesPage } from "./management-site-page.js";
import { ResourcesPanel } from "./management-resources.js";
import { CapabilitiesPanel } from "./management-capabilities.js";
import { SettingsPanel } from "./management-settings.js";

export type { ManagementSurfaceProps } from "./management-surface-props.js";

export function ManagementSurface(props: ManagementSurfaceProps): ReactElement {
  const titles: Record<ManagementSection, string> = {
    automations: "Automations",
    sites: "Sites",
    resources: "Skills & extensions",
    capabilities: "MCPs / CLIs",
    settings: "Settings",
  };
  return (
    <section className="management-main" aria-label={titles[props.section]}>
      <header className="management-heading">
        <div>
          <h1>{titles[props.section]}</h1>
        </div>
      </header>
      {props.error && (
        <p className="management-error" role="status">
          {props.error}
        </p>
      )}
      {props.section === "automations" && <Automations {...props} />}
      {props.section === "sites" && <SitesPage {...props} />}
      {props.section === "resources" && <ResourcesPanel {...props} />}
      {props.section === "capabilities" && <CapabilitiesPanel {...props} />}
      {props.section === "settings" && <SettingsPanel {...props} />}
    </section>
  );
}

/**
 * Automations: everything that runs without you typing: an instruction on a schedule, a watcher
 * that checks a page or site API and wakes the agent when it changes, and a snipe that acts at an
 * exact moment. What a site can do on request (its abilities) lives on Sites.
 */
function Automations(props: ManagementSurfaceProps): ReactElement {
  return <RoutinesPanel {...props} />;
}

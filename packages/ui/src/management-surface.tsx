import type { ReactElement } from "react";
import type { ManagementSection } from "./management-types.js";
import type { ManagementSurfaceProps } from "./management-surface-props.js";
import { RoutinesPanel } from "./management-routines.js";
import { AutomationsPanel } from "./management-automations.js";
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
        {props.section !== "settings" && (
          <button type="button" onClick={props.onRefresh} disabled={props.loading}>
            {props.loading ? "Refreshing…" : "Refresh"}
          </button>
        )}
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
 * Automations: everything that runs without you typing. Routines (an instruction on a schedule or
 * when something changes) and saved steps (a fixed sequence, no model) on one page.
 */
function Automations(props: ManagementSurfaceProps): ReactElement {
  return (
    <>
      <RoutinesPanel {...props} />
      <h2 className="management-subheading">Saved steps</h2>
      <AutomationsPanel {...props} />
    </>
  );
}

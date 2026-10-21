import type { ReactElement } from "react";
import type { ManagementSection } from "./management-types.js";
import type { ManagementSurfaceProps } from "./management-surface-props.js";
import { RoutinesPanel } from "./management-routines.js";
import { ResourcesPanel } from "./management-resources.js";
import { CapabilitiesPanel } from "./management-capabilities.js";
import { SettingsPanel } from "./management-settings.js";

export type { ManagementSurfaceProps } from "./management-surface-props.js";

export function ManagementSurface(props: ManagementSurfaceProps): ReactElement {
  const titles: Record<ManagementSection, string> = {
    routines: "Watchers",
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
      {props.section === "routines" && <RoutinesPanel {...props} />}
      {props.section === "resources" && <ResourcesPanel {...props} />}
      {props.section === "capabilities" && <CapabilitiesPanel {...props} />}
      {props.section === "settings" && <SettingsPanel {...props} />}
    </section>
  );
}

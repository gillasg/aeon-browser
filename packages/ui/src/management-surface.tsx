import type { ReactElement } from "react";
import type { ManagementSection } from "./management-types.js";
import type { ManagementSurfaceProps } from "./management-surface-props.js";
import { RoutinesPanel } from "./management-routines.js";
import { AbilitiesPanel } from "./management-automations.js";
import { SitesPage } from "./management-site-page.js";
import { ResourcesPanel } from "./management-resources.js";
import { CapabilitiesPanel } from "./management-capabilities.js";
import { SettingsPanel } from "./management-settings.js";
import { usePageTitle } from "./page-title.js";

export type { ManagementSurfaceProps } from "./management-surface-props.js";

export function ManagementSurface(props: ManagementSurfaceProps): ReactElement {
  const titles: Record<ManagementSection, string> = {
    automations: "Automations",
    sites: "Sites",
    skills: "Skills",
    resources: "Pi skills & extensions",
    capabilities: "CLIs & MCP servers",
    settings: "Settings",
  };
  usePageTitle(titles[props.section], props.subsection !== true);
  const sub = props.subsection === true;
  return (
    <section
      className={sub ? "management-main management-sub" : "management-main"}
      aria-label={titles[props.section]}
    >
      {!(sub && props.section === "settings") && (
        <header className="management-heading">
          <div>{sub ? <h2>{titles[props.section]}</h2> : <h1>{titles[props.section]}</h1>}</div>
        </header>
      )}
      {props.error && (
        <p className="management-error" role="status">
          {props.error}
        </p>
      )}
      {props.section === "automations" && <Watches {...props} />}
      {props.section === "skills" && <AbilitiesPanel {...props} />}
      {props.section === "sites" && <SitesPage {...props} />}
      {props.section === "resources" && <ResourcesPanel {...props} />}
      {props.section === "capabilities" && <CapabilitiesPanel {...props} />}
      {props.section === "settings" && <SettingsPanel {...props} />}
    </section>
  );
}

/**
 * Watches: everything that runs without you typing: an instruction on a schedule, a check of a
 * page or site API that wakes the agent when it changes, and a snipe that acts at an exact moment.
 * What a site can do on request (its skills) lives on Skills.
 */
function Watches(props: ManagementSurfaceProps): ReactElement {
  return <RoutinesPanel {...props} />;
}

import type { ReactElement } from "react";
import type { ManagementSurfaceProps } from "./management-surface-props.js";

// Site packs and their stored sessions: what has been mapped, whether it is healthy, and whether
// this chrome still holds a session for it. Demo of the shape a "record a flow" action would use.

export function SitesPanel(props: ManagementSurfaceProps): ReactElement {
  const sites = props.snapshot?.sites ?? [];
  return (
    <div className="management-sites">
      <p className="management-hint">
        A mapped site has an API the agent can call without opening a page. Clear a stored session
        by signing out on the site, or with <code>browserkit sites session clear &lt;site&gt;</code>
        .
      </p>
      {sites.length === 0 ? (
        <p className="management-empty">
          No mapped sites yet. Ask an agent to map a site, or run <code>browserkit map</code>.
        </p>
      ) : (
        <table className="management-table">
          <thead>
            <tr>
              <th scope="col">Site</th>
              <th scope="col">Operations</th>
              <th scope="col">Health</th>
              <th scope="col">Session</th>
              <th scope="col">Updated</th>
            </tr>
          </thead>
          <tbody>
            {sites.map((site) => (
              <tr key={site.site}>
                <td>
                  <strong>{site.site}</strong>
                </td>
                <td>{site.operations}</td>
                <td>
                  <span className={`management-health management-health-${site.health}`}>
                    {site.health}
                  </span>
                </td>
                <td>{site.session ? "Stored" : "Signed out"}</td>
                <td>{formatWhen(site.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function formatWhen(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

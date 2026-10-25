import type { ReactElement } from "react";
import type { ManagementSurfaceProps } from "./management-surface-props.js";

// Saved workflows and their last run. They run from the CLI (`aeon workflow run <name>`), which is
// the same engine with the same browser; this page is the index, not a second runner.

export function AutomationsPanel(props: ManagementSurfaceProps): ReactElement {
  const workflows = props.snapshot?.workflows ?? [];
  return (
    <div className="management-automations">
      <p className="management-hint">
        Workflows run with <code>aeon workflow run &lt;name&gt;</code>; a run keeps its records
        here.
      </p>
      {workflows.length === 0 ? (
        <p className="management-empty">
          No saved workflows yet. A workflow is a fixed sequence across sites; an agent can save one
          with the workflow tool, then it appears here.
        </p>
      ) : (
        <table className="management-table">
          <thead>
            <tr>
              <th scope="col">Workflow</th>
              <th scope="col">Steps</th>
              <th scope="col">Updated</th>
              <th scope="col">Last run</th>
            </tr>
          </thead>
          <tbody>
            {workflows.map((workflow) => (
              <tr key={workflow.slug}>
                <td>
                  <strong>{workflow.name}</strong>
                  {workflow.description && (
                    <p className="management-subtle">{workflow.description}</p>
                  )}
                </td>
                <td>{workflow.steps}</td>
                <td>{formatWhen(workflow.updatedAt)}</td>
                <td>
                  {workflow.lastRun ? (
                    <span className={`management-run management-run-${workflow.lastRun.state}`}>
                      {workflow.lastRun.state} · {formatWhen(workflow.lastRun.at)}
                      {workflow.lastRun.error && (
                        <span className="management-subtle"> — {workflow.lastRun.error}</span>
                      )}
                    </span>
                  ) : (
                    <span className="management-subtle">Never run</span>
                  )}
                </td>
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

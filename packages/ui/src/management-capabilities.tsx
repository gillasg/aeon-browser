import { useState, type ReactElement } from "react";
import type { ManagementSnapshotDto } from "@pippin/protocol";
import type { ManagementActionName } from "./management-types.js";
import type { ManagementSurfaceProps } from "./management-surface-props.js";
import { CapabilityEditor } from "./capability-editor.js";

type Capability = ManagementSnapshotDto["capabilities"][number];

export function CapabilitiesPanel(props: ManagementSurfaceProps): ReactElement {
  const [creating, setCreating] = useState(false);
  return (
    <>
      <div className="management-toolbar">
        <span>Local CLI and MCP registry · revision {props.snapshot?.capabilityRevision ?? 0}</span>
        <button
          type="button"
          disabled={!props.selectedChatId}
          onClick={() => setCreating((open) => !open)}
        >
          {creating ? "Cancel" : "Add capability"}
        </button>
      </div>
      {creating && <CapabilityEditor props={props} onDone={() => setCreating(false)} />}
      <CapabilityList props={props} items={props.snapshot?.capabilities ?? []} />
    </>
  );
}

function CapabilityList({
  props,
  items,
}: {
  props: ManagementSurfaceProps;
  items: readonly Capability[];
}): ReactElement {
  if (!items.length)
    return (
      <p className="management-empty">
        {props.loading ? "Loading configured tools…" : "No configured CLI or MCP capabilities."}
      </p>
    );
  return (
    <div className="management-list">
      {items.map((item) => (
        <CapabilityCard key={item.id} props={props} item={item} />
      ))}
    </div>
  );
}

function CapabilityCard({
  props,
  item,
}: {
  props: ManagementSurfaceProps;
  item: Capability;
}): ReactElement {
  return (
    <article className="management-info-row">
      <div className="management-card-heading">
        <div>
          <strong>{item.displayName}</strong>
          <small>
            {item.kind.toUpperCase()} · {item.id}
          </small>
        </div>
        <span className={`routine-status ${item.verification.state}`}>
          {item.verification.state.replace("_", " ")}
        </span>
      </div>
      <p>{item.description}</p>
      <CapabilityFacts item={item} />
      {item.verification.summary && <small>{item.verification.summary}</small>}
      <CapabilityActions props={props} item={item} />
    </article>
  );
}

function CapabilityFacts({ item }: { item: Capability }): ReactElement {
  return (
    <>
      <dl className="management-facts">
        <div>
          <dt>Configuration</dt>
          <dd>{item.configReference || "Not specified"}</dd>
        </div>
        <div>
          <dt>Credentials</dt>
          <dd data-binding={item.credentialBinding}>
            {credentialBindingLabel(item.credentialBinding)}
          </dd>
        </div>
        <div>
          <dt>Last checked</dt>
          <dd>
            {item.verification.checkedAt
              ? new Date(item.verification.checkedAt).toLocaleString()
              : "Never"}
          </dd>
        </div>
        {item.kind === "mcp" && (
          <div>
            <dt>Pi connection</dt>
            <dd>{connectionLabel(item.connectionState)}</dd>
          </div>
        )}
        <div>
          <dt>Loaded in selected Chat</dt>
          <dd>{loadedLabel(item.loadedInSelectedChat)}</dd>
        </div>
      </dl>
      {item.credentialBinding === "manual_pi_binding_required" && (
        <p className="credential-binding-guidance" role="note">
          Pi needs this MCP credential in its own server configuration. Add the credential setting
          required by this server to <code>~/.pi/agent/mcp.json</code> or this project’s{" "}
          <code>.pi/mcp.json</code>, then reload the Pi session. Aeon does not store or display the
          secret.
        </p>
      )}
    </>
  );
}

function credentialBindingLabel(binding: Capability["credentialBinding"]): string {
  switch (binding) {
    case "not_configured":
      return "No credential reference set";
    case "environment_reference":
      return "Environment variable reference · value hidden";
    case "external_configuration":
      return "Credential managed outside Pi · value hidden";
    case "manual_pi_binding_required":
      return "Manual Pi binding required";
  }
}

function connectionLabel(state: Capability["connectionState"]): string {
  const labels: Record<string, string> = {
    not_reported: "Not reported by Pi",
    not_configured: "Not configured in Pi",
    disabled: "Disabled in Pi",
    starting: "Connecting",
    connecting: "Connecting",
    connected: "Connected",
    disconnected: "Disconnected",
    "needs-auth": "Sign-in required",
    failed: "Connection failed",
    closed: "Closed",
    client_open: "Legacy connection open",
    not_connected: "Not connected",
  };
  return labels[state ?? "not_reported"] ?? "Not reported by Pi";
}

function loadedLabel(loaded: boolean | null): string {
  if (loaded === null) return "Not reported by Pi";
  return loaded ? "Yes" : "No";
}

function CapabilityActions({
  props,
  item,
}: {
  props: ManagementSurfaceProps;
  item: Capability;
}): ReactElement {
  const revision = props.snapshot?.capabilityRevision ?? 0;
  return (
    <div className="capability-actions">
      <button
        type="button"
        disabled={!props.selectedChatId}
        onClick={() =>
          perform(props, "recheck_capability", {
            capabilityId: item.id,
            expectedRevision: revision,
          })
        }
      >
        Recheck
      </button>
      <button
        type="button"
        disabled={!props.selectedChatId}
        onClick={() => {
          if (window.confirm(`Remove ${item.displayName} from the configured registry?`))
            perform(props, "remove_capability", {
              capabilityId: item.id,
              expectedRevision: revision,
            });
        }}
      >
        Remove
      </button>
    </div>
  );
}

function perform(
  props: ManagementSurfaceProps,
  action: ManagementActionName,
  input: Record<string, unknown>,
): void {
  if (props.selectedChatId) props.onAction(props.selectedChatId, action, input);
}

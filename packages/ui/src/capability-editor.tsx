import { useState, type FormEvent, type ReactElement } from "react";
import type { ManagementActionName } from "./management-types.js";
import type { ManagementSurfaceProps } from "./management-surface-props.js";

type CapabilityKind = "cli" | "mcp";
type McpTransport = "stdio" | "streamable-http";

export function CapabilityEditor({
  props,
  onDone,
}: {
  props: ManagementSurfaceProps;
  onDone(): void;
}): ReactElement {
  const [kind, setKind] = useState<CapabilityKind>("cli");
  const [transport, setTransport] = useState<McpTransport>("stdio");
  const [id, setId] = useState("cap_");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [reference, setReference] = useState("");
  const [target, setTarget] = useState("");
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    perform(props, "register_capability", {
      expectedRevision: props.snapshot?.capabilityRevision ?? 0,
      capability: buildCapability({ id, name, description, reference, target, kind, transport }),
    });
    onDone();
  };
  return (
    <form className="capability-editor" onSubmit={submit}>
      <h2>Add configured tool</h2>
      <CapabilityIdentityFields
        values={{ id, name, description, reference }}
        onChange={{ setId, setName, setDescription, setReference }}
      />
      <CapabilityConnectionFields
        kind={kind}
        transport={transport}
        target={target}
        onKind={setKind}
        onTransport={setTransport}
        onTarget={setTarget}
      />
      <p>Credentials stay in your external config or OS store; never enter a secret here.</p>
      <button type="submit" disabled={!props.selectedChatId}>
        Save capability
      </button>
    </form>
  );
}

type IdentityValues = { id: string; name: string; description: string; reference: string };
type IdentitySetters = {
  setId(value: string): void;
  setName(value: string): void;
  setDescription(value: string): void;
  setReference(value: string): void;
};

function CapabilityIdentityFields({
  values,
  onChange,
}: {
  values: IdentityValues;
  onChange: IdentitySetters;
}): ReactElement {
  return (
    <>
      <label>
        Registry ID
        <input
          value={values.id}
          onChange={(event) => onChange.setId(event.target.value)}
          required
          pattern="cap_[a-z0-9][a-z0-9_-]{0,58}"
        />
      </label>
      <label>
        Name
        <input
          value={values.name}
          onChange={(event) => onChange.setName(event.target.value)}
          required
          maxLength={120}
        />
      </label>
      <label>
        Description
        <textarea
          value={values.description}
          onChange={(event) => onChange.setDescription(event.target.value)}
          maxLength={1000}
        />
      </label>
      <label>
        Configuration reference
        <input
          value={values.reference}
          onChange={(event) => onChange.setReference(event.target.value)}
          required
          maxLength={200}
          placeholder="Local configuration location"
        />
      </label>
    </>
  );
}

function CapabilityConnectionFields({
  kind,
  transport,
  target,
  onKind,
  onTransport,
  onTarget,
}: {
  kind: CapabilityKind;
  transport: McpTransport;
  target: string;
  onKind(value: CapabilityKind): void;
  onTransport(value: McpTransport): void;
  onTarget(value: string): void;
}): ReactElement {
  return (
    <>
      <label>
        Type
        <select value={kind} onChange={(event) => onKind(event.target.value as CapabilityKind)}>
          <option value="cli">CLI</option>
          <option value="mcp">MCP server</option>
        </select>
      </label>
      {kind === "mcp" && (
        <label>
          Transport
          <select
            value={transport}
            onChange={(event) => onTransport(event.target.value as McpTransport)}
          >
            <option value="stdio">Local process (stdio)</option>
            <option value="streamable-http">Streamable HTTP</option>
          </select>
        </label>
      )}
      <label>
        {kind === "cli" ? "Executable" : transport === "stdio" ? "Command" : "Endpoint"}
        <input
          value={target}
          onChange={(event) => onTarget(event.target.value)}
          required
          maxLength={2000}
        />
      </label>
    </>
  );
}

function buildCapability({
  id,
  name,
  description,
  reference,
  target,
  kind,
  transport,
}: IdentityValues & { target: string; kind: CapabilityKind; transport: McpTransport }): Record<
  string,
  unknown
> {
  const base = {
    id,
    displayName: name,
    description,
    configReference: reference,
    credentialReference: null,
    relatedSkillIds: [],
  };
  if (kind === "cli")
    return { ...base, kind, launcher: { executable: target, workingDirectory: null } };
  return {
    ...base,
    kind,
    transport,
    command: transport === "stdio" ? target : null,
    args: [],
    endpoint: transport === "streamable-http" ? target : null,
    workingDirectory: null,
  };
}

function perform(
  props: ManagementSurfaceProps,
  action: ManagementActionName,
  input: Record<string, unknown>,
): void {
  if (props.selectedChatId) props.onAction(props.selectedChatId, action, input);
}

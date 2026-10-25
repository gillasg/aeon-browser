import { useEffect, useState, type ReactElement } from "react";
import type { ManagementSnapshotDto } from "@aeon/protocol";
import type { ManagementSurfaceProps } from "./management-surface-props.js";

// Saved workflows: run one with its inputs, cancel a run, import its JSON, record a workflow from
// a chat's last browser run, and watch each step as it runs. Running happens in the daemon with
// the same engine and browser as the CLI.

type Workflow = NonNullable<ManagementSnapshotDto["workflows"]>[number];
type Action = Parameters<ManagementSurfaceProps["onAction"]>[1];

export function AutomationsPanel(props: ManagementSurfaceProps): ReactElement {
  const workflows = props.snapshot?.workflows ?? [];
  const chatId = props.selectedChatId || props.snapshot?.chats[0]?.chatId || "";
  const [importing, setImporting] = useState(false);
  const [recording, setRecording] = useState(false);
  const running = workflows.some((workflow) => workflow.running);
  // Steps change on the daemon while a run is going; refresh only while one is.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(props.onRefresh, 2000);
    return () => clearInterval(timer);
  }, [running, props.onRefresh]);
  return (
    <div className="management-automations">
      <p className="management-hint">
        A workflow is a fixed sequence across sites. Running and cancelling happen here; the CLI (
        <code>aeon workflow run &lt;name&gt;</code>) runs the same engine.
      </p>
      <ActionNote note={props.snapshot?.lastAction} />
      <AutomationToolbar
        importing={importing}
        recording={recording}
        loading={props.loading}
        onRefresh={props.onRefresh}
        onImport={() => setImporting((value) => !value)}
        onRecord={() => setRecording((value) => !value)}
      />
      {importing && <ImportForm chatId={chatId} onAction={props.onAction} />}
      {recording && <RecordForm chatId={chatId} onAction={props.onAction} />}
      <WorkflowTable workflows={workflows} chatId={chatId} onAction={props.onAction} />
    </div>
  );
}

function AutomationToolbar(props: {
  importing: boolean;
  recording: boolean;
  loading: boolean;
  onRefresh: () => void;
  onImport: () => void;
  onRecord: () => void;
}): ReactElement {
  return (
    <div className="management-toolbar">
      <button type="button" onClick={props.onRefresh} disabled={props.loading}>
        Refresh
      </button>
      <button type="button" onClick={props.onImport}>
        {props.importing ? "Close import" : "Import workflow"}
      </button>
      <button type="button" onClick={props.onRecord}>
        {props.recording ? "Close record" : "Record from last run"}
      </button>
    </div>
  );
}

function WorkflowTable(props: {
  workflows: Workflow[];
  chatId: string;
  onAction: ManagementSurfaceProps["onAction"];
}): ReactElement {
  if (!props.workflows.length)
    return (
      <p className="management-empty">
        No saved workflows yet. An agent can save one (workflow tool), or record the last run here.
      </p>
    );
  return (
    <table className="management-table">
      <thead>
        <tr>
          <th scope="col">Workflow</th>
          <th scope="col">Steps</th>
          <th scope="col">Inputs</th>
          <th scope="col">Last run</th>
          <th scope="col">Actions</th>
        </tr>
      </thead>
      <tbody>
        {props.workflows.map((workflow) => (
          <WorkflowRow
            key={workflow.slug}
            workflow={workflow}
            chatId={props.chatId}
            onAction={props.onAction}
          />
        ))}
      </tbody>
    </table>
  );
}

export function ActionNote({
  note,
}: {
  note: { ok: boolean; message: string } | null | undefined;
}): ReactElement | null {
  if (!note) return null;
  return (
    <p className={`management-note ${note.ok ? "management-run-ok" : "management-run-failed"}`}>
      {note.message}
    </p>
  );
}

function ImportForm({
  chatId,
  onAction,
}: {
  chatId: string;
  onAction: ManagementSurfaceProps["onAction"];
}): ReactElement {
  const [json, setJson] = useState("");
  return (
    <div className="management-form">
      <textarea
        value={json}
        onChange={(event) => setJson(event.target.value)}
        placeholder='{"name": "...", "steps": [...]}'
        rows={6}
      />
      <button
        type="button"
        disabled={!json.trim()}
        onClick={() => onAction(chatId, "import_workflow", { json })}
      >
        Import
      </button>
    </div>
  );
}

function RecordForm({
  chatId,
  onAction,
}: {
  chatId: string;
  onAction: ManagementSurfaceProps["onAction"];
}): ReactElement {
  const [name, setName] = useState("");
  return (
    <div className="management-form">
      <label>
        New workflow name
        <input
          value={name}
          placeholder="Recorded from the last run"
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <button
        type="button"
        disabled={!name.trim()}
        onClick={() => onAction(chatId, "record_workflow_from_run", { name })}
      >
        Record
      </button>
    </div>
  );
}

function WorkflowRow({
  workflow,
  chatId,
  onAction,
}: {
  workflow: Workflow;
  chatId: string;
  onAction: ManagementSurfaceProps["onAction"];
}): ReactElement {
  const [running, setRunning] = useState(false);
  const act = (action: Action, input: Record<string, unknown>) => onAction(chatId, action, input);
  return (
    <tr>
      <td>
        <strong>{workflow.name}</strong>
        {workflow.description && <p className="management-subtle">{workflow.description}</p>}
        <p className="management-subtle">Updated {formatWhen(workflow.updatedAt)}</p>
      </td>
      <td>{workflow.steps}</td>
      <td>
        <WorkflowInputs workflow={workflow} />
      </td>
      <td>
        <LastRun workflow={workflow} />
      </td>
      <td>
        <div className="management-actions">
          {workflow.running ? (
            <button type="button" onClick={() => act("cancel_workflow", { name: workflow.name })}>
              Cancel
            </button>
          ) : (
            <button type="button" onClick={() => setRunning((value) => !value)}>
              Run
            </button>
          )}
          <button type="button" onClick={() => act("export_workflow", { name: workflow.name })}>
            Export
          </button>
        </div>
        {running && (
          <RunForm
            workflow={workflow}
            onStart={(inputs) => {
              act("run_workflow", { name: workflow.name, inputs });
              setRunning(false);
            }}
          />
        )}
      </td>
    </tr>
  );
}

function WorkflowInputs({ workflow }: { workflow: Workflow }): ReactElement {
  if (workflow.inputs.length === 0) return <span className="management-subtle">none</span>;
  return (
    <ul className="management-inputs">
      {workflow.inputs.map((input) => (
        <li key={input.name}>
          <code>{input.name}</code>
          {input.required ? " *" : ""}
          {input.default !== undefined && (
            <span className="management-subtle"> default {JSON.stringify(input.default)}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function LastRun({ workflow }: { workflow: Workflow }): ReactElement {
  if (workflow.running)
    return (
      <span className="management-run-running">
        running
        {workflow.progress && ` · step ${workflow.progress.step}/${workflow.progress.total}`}
        {workflow.progress && ` · ${workflow.progress.action}`}
      </span>
    );
  if (!workflow.lastRun) return <span className="management-subtle">Never run</span>;
  return (
    <span className={`management-run management-run-${workflow.lastRun.state}`}>
      {workflow.lastRun.state} · {formatWhen(workflow.lastRun.at)}
      {workflow.lastRun.error && (
        <span className="management-subtle"> — {workflow.lastRun.error}</span>
      )}
    </span>
  );
}

function RunForm({
  workflow,
  onStart,
}: {
  workflow: Workflow;
  onStart(inputs: Record<string, unknown>): void;
}): ReactElement {
  const [values, setValues] = useState<Record<string, string>>({});
  return (
    <div className="management-form">
      {workflow.inputs.map((input) => (
        <label key={input.name}>
          {input.name}
          {input.required ? " *" : ""}
          <input
            value={values[input.name] ?? ""}
            placeholder={input.default === undefined ? "" : JSON.stringify(input.default)}
            onChange={(event) =>
              setValues((current) => ({ ...current, [input.name]: event.target.value }))
            }
          />
        </label>
      ))}
      <button
        type="button"
        onClick={() => {
          const inputs: Record<string, unknown> = {};
          for (const input of workflow.inputs) {
            const raw = values[input.name];
            if (raw !== undefined && raw !== "") inputs[input.name] = parseValue(raw);
          }
          onStart(inputs);
        }}
      >
        Start
      </button>
    </div>
  );
}

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function formatWhen(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

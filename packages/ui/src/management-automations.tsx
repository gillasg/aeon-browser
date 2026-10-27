import { useEffect, useState, type ReactElement } from "react";
import type { ManagementSnapshotDto } from "@aeon/protocol";
import type { ManagementSurfaceProps } from "./management-surface-props.js";

// Saved steps: every ability Aeon has saved across sites, with how it runs (api, steps, script,
// page), its inputs and how often it worked. The agent saves, repairs and prunes these itself;
// the user only runs them. Running happens in the daemon with the same engine as the CLI.

type Ability = NonNullable<ManagementSnapshotDto["abilities"]>[number];

export function AutomationsPanel(props: ManagementSurfaceProps): ReactElement {
  const abilities = props.snapshot?.abilities ?? [];
  const chatId = props.selectedChatId || props.snapshot?.chats[0]?.chatId || "";
  const running = abilities.some((ability) => ability.running);
  // Runs change on the daemon while one is going; refresh only while one is.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(props.onRefresh, 2000);
    return () => clearInterval(timer);
  }, [running, props.onRefresh]);
  return (
    <div className="management-automations">
      <p className="management-hint">
        Things Aeon learned to do on a site. It saves one when a task works, fixes it when the site
        changes and drops it when it keeps failing. <code>aeon abilities run</code> runs the same.
      </p>
      <ActionNote note={props.snapshot?.lastAction} />
      {abilities.length ? (
        <table className="management-table">
          <thead>
            <tr>
              <th scope="col">Ability</th>
              <th scope="col">Inputs</th>
              <th scope="col">Works</th>
              <th scope="col" aria-label="Run" />
            </tr>
          </thead>
          <tbody>
            {abilities.map((ability) => (
              <AbilityRow
                key={`${ability.site}:${ability.name}`}
                ability={ability}
                onRun={(params) =>
                  props.onAction(chatId, "run_site_ability", {
                    site: ability.site,
                    name: ability.name,
                    params,
                  })
                }
              />
            ))}
          </tbody>
        </table>
      ) : (
        <p className="management-empty">
          Nothing saved yet. Aeon saves steps on its own once a task works.
        </p>
      )}
    </div>
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

function AbilityRow({
  ability,
  onRun,
}: {
  ability: Ability;
  onRun(params: Record<string, unknown>): void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <tr>
      <td>
        <strong>{humanize(ability.name)}</strong>
        {ability.description && <p className="management-subtle">{ability.description}</p>}
        <p className="management-subtle">
          {ability.site} · {ability.kind === "write" ? "changes things" : "reads"} ·{" "}
          {ability.ways.join(" → ")}
        </p>
      </td>
      <td>
        {ability.inputs.length ? (
          <ul className="management-inputs">
            {ability.inputs.map((input) => (
              <li key={input.name}>
                <code>{input.name}</code>
                {input.required ? " *" : ""}
              </li>
            ))}
          </ul>
        ) : (
          <span className="management-subtle">none</span>
        )}
      </td>
      <td>
        <Health ability={ability} />
      </td>
      <td>
        {ability.running ? (
          <span className="management-run-running">running</span>
        ) : (
          <button type="button" onClick={() => setOpen((value) => !value)}>
            Run
          </button>
        )}
        {open && (
          <RunForm
            ability={ability}
            onStart={(params) => {
              onRun(params);
              setOpen(false);
            }}
          />
        )}
      </td>
    </tr>
  );
}

function Health({ ability }: { ability: Ability }): ReactElement {
  const stats = ability.stats;
  if (!stats?.runs) return <span className="management-subtle">Not run yet</span>;
  const ok = stats.runs - stats.failures;
  return (
    <span className={`management-run management-run-${stats.failures ? "failed" : "ok"}`}>
      {ok}/{stats.runs}
      {stats.lastOkAt && (
        <span className="management-subtle"> · last worked {formatWhen(stats.lastOkAt)}</span>
      )}
    </span>
  );
}

function RunForm({
  ability,
  onStart,
}: {
  ability: Ability;
  onStart(params: Record<string, unknown>): void;
}): ReactElement {
  const [values, setValues] = useState<Record<string, string>>({});
  return (
    <div className="management-form">
      {ability.inputs.map((input) => (
        <label key={input.name}>
          {input.name}
          {input.required ? " *" : ""}
          <input
            value={values[input.name] ?? ""}
            placeholder={input.description ?? ""}
            onChange={(event) =>
              setValues((current) => ({ ...current, [input.name]: event.target.value }))
            }
          />
        </label>
      ))}
      <button
        type="button"
        onClick={() => {
          const params: Record<string, unknown> = {};
          for (const [name, raw] of Object.entries(values))
            if (raw !== "") params[name] = parseValue(raw);
          onStart(params);
        }}
      >
        Start
      </button>
    </div>
  );
}

/** search_videos → "Search videos": names are saved for code, shown for people. */
export function humanize(name: string): string {
  const words = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
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

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
    <section className="settings-group management-automations">
      <h2>Saved steps</h2>
      <ActionNote note={props.snapshot?.lastAction} />
      {abilities.length ? (
        <ul className="aeon-list ability-list">
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
        </ul>
      ) : (
        <p className="management-empty">Nothing saved yet.</p>
      )}
      <p className="settings-footnote">
        Things Aeon learned to do on a site. It saves one when a task works, fixes it when the site
        changes and drops it when it keeps failing. <code>aeon actions run</code> runs the same.
      </p>
    </section>
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
    <li className="ability-row">
      <div className="ability-main">
        <span className="ability-text">
          <strong>{humanize(ability.name)}</strong>
          {ability.description && <span className="ability-about">{ability.description}</span>}
          <small>
            {ability.site} · {ability.kind === "write" ? "Changes things" : "Reads"}
            {ability.inputs.length > 0 &&
              ` · ${ability.inputs.map((input) => input.name).join(", ")}`}
          </small>
        </span>
        <Health ability={ability} />
        {ability.running ? (
          <span className="management-run-running">Running</span>
        ) : (
          <button type="button" className="aeon-button" onClick={() => setOpen((value) => !value)}>
            {open ? "Cancel" : "Run"}
          </button>
        )}
      </div>
      {open && (
        <RunForm
          ability={ability}
          onStart={(params) => {
            onRun(params);
            setOpen(false);
          }}
        />
      )}
    </li>
  );
}

function Health({ ability }: { ability: Ability }): ReactElement {
  const stats = ability.stats;
  if (!stats?.runs) return <span className="ability-health">New</span>;
  const ok = stats.runs - stats.failures;
  return (
    <span
      className="ability-health"
      data-tone={stats.failures ? "needs" : "ok"}
      title={stats.lastOkAt ? `Last worked ${formatWhen(stats.lastOkAt)}` : undefined}
    >
      {ok}/{stats.runs}
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
    <form
      className="ability-form"
      onSubmit={(event) => {
        event.preventDefault();
        const params: Record<string, unknown> = {};
        for (const [name, raw] of Object.entries(values))
          if (raw !== "") params[name] = parseValue(raw);
        onStart(params);
      }}
    >
      {ability.inputs.map((input) => (
        <input
          key={input.name}
          className="settings-row-input"
          aria-label={input.name}
          placeholder={`${input.name}${input.required ? "" : " (optional)"}`}
          title={input.description ?? undefined}
          value={values[input.name] ?? ""}
          onChange={(event) =>
            setValues((current) => ({ ...current, [input.name]: event.target.value }))
          }
        />
      ))}
      <button type="submit" className="aeon-button" data-tone="primary">
        Start
      </button>
    </form>
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

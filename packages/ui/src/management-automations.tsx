import { useEffect, useState, type ReactElement } from "react";
import type { ManagementSnapshotDto } from "@graft/protocol";
import { AbilitySource, CodeBadge, wayLabel } from "./ability-source.js";
import type { ManagementSurfaceProps } from "./management-surface-props.js";

// Abilities: every ability Graft has saved across sites, with how it runs (api, steps, script,
// page), its inputs and how often it worked. The agent saves, repairs and prunes these itself;
// the user only runs them. Running happens in the daemon with the same engine as the CLI.

type Ability = NonNullable<ManagementSnapshotDto["abilities"]>[number];

export function AbilitiesPanel(props: ManagementSurfaceProps): ReactElement {
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
      <ActionNote note={props.snapshot?.lastAction} />
      {abilities.length ? (
        <ul className="graft-list ability-list">
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
        <p className="management-empty">No skills yet. Graft saves one each time a task works.</p>
      )}
      <p className="settings-footnote">
        Things Graft learned to do on a site. It saves one when a task works, fixes it when the site
        changes and drops it when it keeps failing.
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
            {ability.ways.length > 0 && ` · ${ability.ways.map(wayLabel).join(", ")}`}
            {ability.inputs.length > 0 &&
              ` · ${ability.inputs.map((input) => input.name).join(", ")}`}
          </small>
          <CodeBadge ways={ability.ways} />
          <AbilitySource sources={ability.sources} />
          {ability.checkNote && (
            <small className="ability-check-note">
              {ability.checkNote.repairFailed
                ? `Needs a look: ${ability.checkNote.detail}`
                : `${ability.checkNote.reason}: ${ability.checkNote.detail}`}
            </small>
          )}
        </span>
        <Health ability={ability} />
        {ability.running ? (
          <span className="management-run-running">Running</span>
        ) : (
          <button type="button" className="graft-button" onClick={() => setOpen((value) => !value)}>
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
  const needsRepair = Boolean(ability.checkNote?.repairFailed);
  const label = needsRepair ? "Needs repair" : stats?.runs ? "Works" : "New";
  return (
    <span
      className="ability-health"
      title={
        stats?.runs
          ? `Worked ${stats.runs - stats.failures} of ${stats.runs} runs` +
            (stats.lastOkAt ? ` · last ${formatWhen(stats.lastOkAt)}` : "")
          : undefined
      }
    >
      {label}
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
      <button type="submit" className="graft-button" data-tone="primary">
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

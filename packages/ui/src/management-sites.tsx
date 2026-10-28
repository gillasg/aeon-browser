import { useState, type ReactElement } from "react";
import type { ManagementSnapshotDto } from "@aeon/protocol";
import { humanize } from "./management-automations.js";
import type { ManagementSurfaceProps } from "./management-surface-props.js";

// Mapped sites: health, recipes, the stored session, and real actions — run an operation or a
// recipe, export or import a pack or its recipes, clear or switch the stored session. Everything
// runs in the daemon with the user's browser session.

type Site = NonNullable<ManagementSnapshotDto["sites"]>[number];

export function ImportPath({
  chatId,
  onAction,
}: {
  chatId: string;
  onAction: ManagementSurfaceProps["onAction"];
}): ReactElement {
  return (
    <label className="management-path">
      Import pack
      <input
        placeholder="path to a .zip"
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          const path = event.currentTarget.value.trim();
          if (path) onAction(chatId, "import_site", { path });
        }}
      />
    </label>
  );
}

export function SiteAbilities({ site }: { site: Site }): ReactElement {
  if (site.abilities.length === 0) return <span className="management-subtle">no actions</span>;
  return (
    <ul className="management-inputs">
      {site.abilities.map((ability) => (
        <li key={ability.name}>
          <strong>{humanize(ability.name)}</strong>{" "}
          <span className="management-subtle">
            {ability.kind}, {ability.ways.join(" + ")}
            {ability.description ? ` — ${ability.description}` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function SiteActions({
  site,
  chatId,
  onAction,
  open,
  onToggle,
}: {
  site: Site;
  chatId: string;
  onAction: ManagementSurfaceProps["onAction"];
  open: boolean;
  onToggle(): void;
}): ReactElement {
  const act = (action: Parameters<typeof onAction>[1], input: Record<string, unknown>) =>
    onAction(chatId, action, input);
  return (
    <div className="management-actions">
      <button type="button" onClick={onToggle}>
        {open ? "Close" : "Run"}
      </button>
      <button type="button" onClick={() => act("export_site", { site: site.site })}>
        Export pack
      </button>
      <button type="button" onClick={() => act("export_recipes", { site: site.site })}>
        Export recipes
      </button>
      <button type="button" onClick={() => act("clear_site_session", { site: site.site })}>
        Clear session
      </button>
      <button type="button" onClick={() => act("switch_site_account", { site: site.site })}>
        Switch account
      </button>
      {site.recording ? (
        <button type="button" onClick={() => act("stop_site_recording", { site: site.site })}>
          Stop recording
        </button>
      ) : (
        <button type="button" onClick={() => act("start_site_recording", { site: site.site })}>
          Record flow
        </button>
      )}
    </div>
  );
}

export function SiteRunForm({
  site,
  chatId,
  onAction,
}: {
  site: Site;
  chatId: string;
  onAction: ManagementSurfaceProps["onAction"];
}): ReactElement {
  const [operation, setOperation] = useState("");
  const [ability, setAbility] = useState("");
  const [params, setParams] = useState("");
  const act = (action: Parameters<typeof onAction>[1], input: Record<string, unknown>) =>
    onAction(chatId, action, input);
  return (
    <div className="management-form">
      <OperationFields
        operation={operation}
        params={params}
        onOperation={setOperation}
        onParams={setParams}
        onRun={() => {
          act("run_site_operation", {
            site: site.site,
            operation: operation.trim(),
            params: parseObject(params),
          });
          setOperation("");
        }}
      />
      {site.abilities.length > 0 && (
        <RecipePicker
          site={site}
          recipe={ability}
          onRecipe={setAbility}
          onRun={() => {
            act("run_site_ability", {
              site: site.site,
              name: ability,
              params: parseObject(params),
            });
            setAbility("");
          }}
        />
      )}
      <RecipeImportPath site={site} chatId={chatId} onAction={onAction} />
    </div>
  );
}

function OperationFields({
  operation,
  params,
  onOperation,
  onParams,
  onRun,
}: {
  operation: string;
  params: string;
  onOperation(value: string): void;
  onParams(value: string): void;
  onRun(): void;
}): ReactElement {
  return (
    <>
      <label>
        Operation
        <input
          value={operation}
          placeholder="an operation id"
          onChange={(event) => onOperation(event.target.value)}
        />
      </label>
      <label>
        Params (JSON)
        <input value={params} placeholder="{}" onChange={(event) => onParams(event.target.value)} />
      </label>
      <button type="button" disabled={!operation.trim()} onClick={onRun}>
        Run operation
      </button>
    </>
  );
}

function RecipePicker({
  site,
  recipe,
  onRecipe,
  onRun,
}: {
  site: Site;
  recipe: string;
  onRecipe(value: string): void;
  onRun(): void;
}): ReactElement {
  return (
    <>
      <label>
        Action
        <select value={recipe} onChange={(event) => onRecipe(event.target.value)}>
          <option value="">Choose an action</option>
          {site.abilities.map((item) => (
            <option key={item.name} value={item.name}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <button type="button" disabled={!recipe} onClick={onRun}>
        Run action
      </button>
    </>
  );
}

function RecipeImportPath({
  site,
  chatId,
  onAction,
}: {
  site: Site;
  chatId: string;
  onAction: ManagementSurfaceProps["onAction"];
}): ReactElement {
  return (
    <label>
      Import recipes from
      <input
        placeholder="path to a recipes JSON file"
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          const path = event.currentTarget.value.trim();
          if (path) onAction(chatId, "import_recipes", { site: site.site, path });
        }}
      />
    </label>
  );
}

function parseObject(value: string): Record<string, unknown> {
  if (!value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function formatWhen(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

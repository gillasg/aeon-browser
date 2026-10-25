import { useState, type ReactElement } from "react";
import type { ManagementSnapshotDto } from "@aeon/protocol";
import type { ManagementSurfaceProps } from "./management-surface-props.js";
import { ActionNote } from "./management-automations.js";

// Mapped sites: health, recipes, the stored session, and real actions — run an operation or a
// recipe, export or import a pack or its recipes, clear or switch the stored session. Everything
// runs in the daemon with the user's browser session.

type Site = NonNullable<ManagementSnapshotDto["sites"]>[number];

export function SitesPanel(props: ManagementSurfaceProps): ReactElement {
  const sites = props.snapshot?.sites ?? [];
  const chatId = props.selectedChatId || props.snapshot?.chats[0]?.chatId || "";
  return (
    <div className="management-sites">
      <p className="management-hint">
        A mapped site has an API the agent can call without opening a page. Running an operation or
        recipe here uses the stored session; a write recipe keeps its receipt.
      </p>
      <ActionNote note={props.snapshot?.lastAction} />
      <div className="management-toolbar">
        <button type="button" onClick={props.onRefresh} disabled={props.loading}>
          Refresh
        </button>
        <ImportPath chatId={chatId} onAction={props.onAction} />
      </div>
      {sites.length === 0 ? (
        <p className="management-empty">
          No mapped sites yet. Ask an agent to map a site, or run <code>browserkit map</code>.
        </p>
      ) : (
        <table className="management-table">
          <thead>
            <tr>
              <th scope="col">Site</th>
              <th scope="col">Operations / recipes</th>
              <th scope="col">Health</th>
              <th scope="col">Session</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sites.map((site) => (
              <SiteRow key={site.site} site={site} chatId={chatId} onAction={props.onAction} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ImportPath({
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

function SiteRow({
  site,
  chatId,
  onAction,
}: {
  site: Site;
  chatId: string;
  onAction: ManagementSurfaceProps["onAction"];
}): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <tr>
      <td>
        <strong>{site.site}</strong>
        <p className="management-subtle">Updated {formatWhen(site.updatedAt)}</p>
        {site.suggestions.length > 0 && (
          <ul className="management-inputs">
            {site.suggestions.map((suggestion) => (
              <li key={suggestion} className="management-subtle">
                {suggestion}
              </li>
            ))}
          </ul>
        )}
      </td>
      <td>
        {site.operations} operations
        <SiteRecipes site={site} />
      </td>
      <td>
        <span className={`management-health management-health-${site.health}`}>{site.health}</span>
      </td>
      <td>
        <SiteSession site={site} />
      </td>
      <td>
        <SiteActions
          site={site}
          chatId={chatId}
          onAction={onAction}
          open={open}
          onToggle={() => setOpen((value) => !value)}
        />
        {open && <SiteRunForm site={site} chatId={chatId} onAction={onAction} />}
      </td>
    </tr>
  );
}

function SiteRecipes({ site }: { site: Site }): ReactElement {
  if (site.recipes.length === 0) return <span className="management-subtle">no recipes</span>;
  return (
    <ul className="management-inputs">
      {site.recipes.map((recipe) => (
        <li key={recipe.name}>
          <code>{recipe.name}</code>{" "}
          <span className="management-subtle">
            {recipe.kind}, {recipe.fields} fields
          </span>
        </li>
      ))}
    </ul>
  );
}

function SiteSession({ site }: { site: Site }): ReactElement {
  if (!site.session) return <span className="management-subtle">None</span>;
  return (
    <>
      <span>Stored</span>
      {site.sessionAccount && <p className="management-subtle">{site.sessionAccount}</p>}
      {site.sessionSavedAt && (
        <p className="management-subtle">{formatWhen(site.sessionSavedAt)}</p>
      )}
    </>
  );
}

function SiteActions({
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

function SiteRunForm({
  site,
  chatId,
  onAction,
}: {
  site: Site;
  chatId: string;
  onAction: ManagementSurfaceProps["onAction"];
}): ReactElement {
  const [operation, setOperation] = useState("");
  const [recipe, setRecipe] = useState("");
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
      {site.recipes.length > 0 && (
        <RecipePicker
          site={site}
          recipe={recipe}
          onRecipe={setRecipe}
          onRun={() => {
            act("run_site_recipe", { site: site.site, name: recipe, params: parseObject(params) });
            setRecipe("");
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
        Recipe
        <select value={recipe} onChange={(event) => onRecipe(event.target.value)}>
          <option value="">Choose a recipe</option>
          {site.recipes.map((item) => (
            <option key={item.name} value={item.name}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <button type="button" disabled={!recipe} onClick={onRun}>
        Run recipe
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

function formatWhen(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

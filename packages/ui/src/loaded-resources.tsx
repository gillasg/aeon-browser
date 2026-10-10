import type { EffectivePiResourcesDto } from "@aeon/protocol";
import { useState, type ReactElement } from "react";

export type LoadedResourcesState =
  | { kind: "idle" | "loading" }
  | { kind: "loaded"; resources: EffectivePiResourcesDto }
  | { kind: "unavailable"; message: string };

export interface LoadedResourcesProps {
  chatTitle: string;
  state: LoadedResourcesState;
  onRefresh(): void;
  onReturn(): void;
}

export function LoadedResources(props: LoadedResourcesProps): ReactElement {
  const loading = props.state.kind === "loading";
  return (
    <section className="loaded-resources" aria-labelledby="resources-heading">
      <header className="resources-header">
        <div>
          <p className="resources-eyebrow">Selected Chat</p>
          <h1 id="resources-heading">Skills, extensions &amp; tools</h1>
          <p className="resources-chat-name">{props.chatTitle}</p>
        </div>
        <div className="resources-actions">
          <button type="button" onClick={props.onRefresh} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>
      {props.state.kind === "idle" && (
        <p className="resources-status" role="status">
          Choose Refresh to read this Chat&apos;s loaded resources.
        </p>
      )}
      {loading && (
        <p className="resources-status" role="status">
          Reading this Chat&apos;s Pi resources…
        </p>
      )}
      {props.state.kind === "unavailable" && (
        <div className="resources-status resources-error" role="status" aria-live="polite">
          <strong>Unavailable</strong>
          <p>{props.state.message}</p>
        </div>
      )}
      {props.state.kind === "loaded" && props.state.resources.sessionState === "not_started" && (
        <div className="resources-status" role="status">
          <strong>Pi session not started</strong>
          <p>This Chat has no loaded skills, extensions, or tools yet.</p>
        </div>
      )}
      {props.state.kind === "loaded" && props.state.resources.sessionState === "loaded" && (
        <LoadedInventory resources={props.state.resources} />
      )}
    </section>
  );
}

function LoadedInventory({ resources }: { resources: EffectivePiResourcesDto }): ReactElement {
  const [tab, setTab] = useState("Skills");
  return (
    <div className="resources-inventory" data-revision={resources.revision}>
      <div className="resource-tabs" role="tablist" aria-label="Resource type">
        {["Skills", "Extensions", "Tools"].map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            onClick={() => setTab(name)}
          >
            {name}
          </button>
        ))}
      </div>
      {tab === "Skills" && <SkillsInventory resources={resources} />}
      {tab === "Extensions" && (
        <>
          <ExtensionsInventory resources={resources} />
          <DiagnosticsInventory resources={resources} />
        </>
      )}
      {tab === "Tools" && <ToolsInventory resources={resources} />}
    </div>
  );
}

function SkillsInventory({ resources }: { resources: EffectivePiResourcesDto }): ReactElement {
  return (
    <ResourceSection title="Skills" count={resources.skills.length}>
      {resources.skills.map((skill) => (
        <article className="resource-row" key={`${skill.source}:${skill.name}`}>
          <div className="resource-row-title">
            <strong>{skill.name}</strong>
            <span>Loaded</span>
          </div>
          <p>{skill.description || "No description"}</p>
          <small>{skill.source}</small>
        </article>
      ))}
    </ResourceSection>
  );
}

function ExtensionsInventory({ resources }: { resources: EffectivePiResourcesDto }): ReactElement {
  return (
    <ResourceSection title="Pi extensions" count={resources.extensions.length}>
      {resources.extensions.map((extension) => (
        <article className="resource-row" key={extension.path}>
          <div className="resource-row-title">
            <strong>{extension.path}</strong>
            <span>Loaded</span>
          </div>
          <p>
            {extension.tools.length ? `Tools: ${extension.tools.join(", ")}` : "No tools reported"}
          </p>
        </article>
      ))}
    </ResourceSection>
  );
}

function ToolsInventory({ resources }: { resources: EffectivePiResourcesDto }): ReactElement {
  return (
    <ResourceSection title="Effective tools" count={resources.tools.length}>
      {resources.tools.map((tool) => (
        <article className="resource-row" key={tool.name}>
          <div className="resource-row-title">
            <strong>{tool.name}</strong>
            <span>{tool.active ? "Active" : "Available"}</span>
          </div>
          <p>{tool.description || "No description"}</p>
          <small>
            {resources.extensions.find((extension) => extension.tools.includes(tool.name))?.path ??
              "Pi session"}
          </small>
        </article>
      ))}
    </ResourceSection>
  );
}

function DiagnosticsInventory({ resources }: { resources: EffectivePiResourcesDto }): ReactElement {
  return (
    <ResourceSection title="Load diagnostics" count={resources.extensionErrors.length}>
      {resources.extensionErrors.map((item, index) => (
        <article className="resource-row resources-error" key={`${item.path}:${index}`}>
          <div className="resource-row-title">
            <strong>{item.path}</strong>
            <span>Failed to load</span>
          </div>
          <p>{item.error}</p>
        </article>
      ))}
    </ResourceSection>
  );
}
function ResourceSection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactElement[];
}): ReactElement {
  return (
    <section className="resource-section" aria-label={`${title} (${count})`}>
      <div className="resource-section-heading">
        <h2>{title}</h2>
        <span>{count}</span>
      </div>
      {children.length ? children : <p className="resource-empty">None loaded for this Chat.</p>}
    </section>
  );
}

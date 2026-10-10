import { useState, type ReactElement } from "react";
import type { ManagementSnapshotDto } from "@aeon/protocol";
import type { ManagementSurfaceProps } from "./management-surface-props.js";

type Resources = NonNullable<ManagementSnapshotDto["resources"]>;
type ResourceTab = "Skills" | "Extensions" | "Tools";
const RESOURCE_TABS: ResourceTab[] = ["Skills", "Extensions", "Tools"];

export function ResourcesPanel(props: ManagementSurfaceProps): ReactElement {
  const [tab, setTab] = useState<ResourceTab>("Skills");
  return (
    <>
      <ChatPicker props={props} />
      <ResourceTabs active={tab} onSelect={setTab} />
      <ResourcePane props={props} tab={tab} resources={props.snapshot?.resources ?? null} />
    </>
  );
}

function ChatPicker({ props }: { props: ManagementSurfaceProps }): ReactElement {
  return (
    <div className="management-toolbar">
      <label>
        Chat
        <select
          value={props.selectedChatId}
          onChange={(event) => props.onSelectChat(event.target.value)}
        >
          <option value="">Choose a Chat</option>
          {props.snapshot?.chats.map((chat) => (
            <option key={chat.chatId} value={chat.chatId}>
              {chat.title}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function ResourceTabs({
  active,
  onSelect,
}: {
  active: ResourceTab;
  onSelect(tab: ResourceTab): void;
}): ReactElement {
  return (
    <nav className="management-tabs" aria-label="Resource categories">
      {RESOURCE_TABS.map((item) => (
        <button
          key={item}
          type="button"
          aria-current={active === item ? "page" : undefined}
          onClick={() => onSelect(item)}
        >
          {item}
        </button>
      ))}
    </nav>
  );
}

function ResourcePane({
  props,
  tab,
  resources,
}: {
  props: ManagementSurfaceProps;
  tab: ResourceTab;
  resources: Resources | null;
}): ReactElement {
  if (props.snapshot?.resourceError)
    return <p className="management-error">{props.snapshot.resourceError}</p>;
  if (!props.selectedChatId)
    return <p className="management-empty">Select a Chat to see what Pi loaded for it.</p>;
  if (resources) return <ResourceContent tab={tab} resources={resources} />;
  return (
    <p className="management-empty">
      {props.loading ? "Loading Pi resources…" : "Refresh to load this Chat’s Pi resources."}
    </p>
  );
}

function ResourceContent({
  tab,
  resources,
}: {
  tab: ResourceTab;
  resources: Resources;
}): ReactElement {
  switch (tab) {
    case "Skills":
      return <SkillsContent resources={resources} />;
    case "Extensions":
      return <ExtensionsContent resources={resources} />;
    case "Tools":
      return <ToolsContent resources={resources} />;
    default:
      return <OverviewContent resources={resources} />;
  }
}

function SkillsContent({ resources }: { resources: Resources }): ReactElement {
  return (
    <div className="management-list">
      {resources.skills.map((skill) => (
        <article className="management-info-row" key={`${skill.source}:${skill.name}`}>
          <strong>{skill.name}</strong>
          <p>{skill.description}</p>
          <small>{skill.source}</small>
        </article>
      ))}
    </div>
  );
}

function ExtensionsContent({ resources }: { resources: Resources }): ReactElement {
  return (
    <div className="management-list">
      {resources.extensions.map((extension) => (
        <article className="management-info-row" key={extension.path}>
          <strong>{extension.path}</strong>
          <small>Tools: {extension.tools.join(", ") || "None reported"}</small>
        </article>
      ))}
      {resources.extensionErrors.map((item) => (
        <article className="management-info-row error" key={item.path}>
          <strong>{item.path}</strong>
          <p>{item.error}</p>
        </article>
      ))}
    </div>
  );
}

function ToolsContent({ resources }: { resources: Resources }): ReactElement {
  return (
    <div className="management-list">
      {resources.tools.map((tool) => (
        <article className="management-info-row" key={tool.name}>
          <div className="management-card-heading">
            <strong>{tool.name}</strong>
            <small>{tool.active ? "Active" : "Available"}</small>
          </div>
          <p>{tool.description}</p>
          <small>
            {resources.extensions.find((extension) => extension.tools.includes(tool.name))?.path ??
              "Pi session"}
          </small>
        </article>
      ))}
    </div>
  );
}

function OverviewContent({ resources }: { resources: Resources }): ReactElement {
  return (
    <div className="management-overview">
      <p>
        Pi session:{" "}
        <strong>{resources.sessionState === "loaded" ? "Loaded" : "Not started"}</strong>
      </p>
      <p>
        {resources.skills.length} skills · {resources.extensions.length} extensions ·{" "}
        {resources.tools.length} tools
      </p>
      <small>Resource revision {resources.revision.slice(0, 12)}</small>
    </div>
  );
}

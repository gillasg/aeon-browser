import { useEffect, useState, type ReactElement } from "react";
import type { ChatSummaryDto, ProjectDto } from "@aeon/protocol";
import { SidebarChatItem } from "./sidebar-chat-item.js";
import { SidebarSectionHeading } from "./sidebar-section-heading.js";
import { ProjectRowActions } from "./project-row-actions.js";
import { CreateProjectDialog } from "./create-project-dialog.js";
import { requestProject, newProjectChat } from "./project-requests.js";
interface Props {
  chats: readonly ChatSummaryDto[];
  currentChatId?: string;
  onOpen(chatId: string): void;
  onPin?(chatId: string): void;
  onDelete?(chatId: string): void;
}
export function ProjectsSidebar(props: Props): ReactElement {
  const { projects, setProjects, error } = useProjects();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ProjectDto | undefined>(undefined);
  return (
    <section className="home-nav-section sidebar-projects" aria-label="Projects">
      <SidebarSectionHeading label="Projects" onAdd={() => setCreating(true)} />
      {projects.map((project) => (
        <ProjectRow
          key={project.projectId}
          project={project}
          onEdit={() => setEditing(project)}
          {...props}
        />
      ))}
      {error && (
        <p className="home-empty-note" role="status">
          {error}
        </p>
      )}
      {(creating || editing) && (
        <CreateProjectDialog
          project={editing}
          onClose={() => {
            setCreating(false);
            setEditing(undefined);
          }}
          onCreated={(project) => {
            setProjects((current) =>
              editing
                ? current.map((item) => (item.projectId === project.projectId ? project : item))
                : [...current, project],
            );
            setEditing(undefined);
            setCreating(false);
          }}
        />
      )}
    </section>
  );
}
function ProjectRow({
  project,
  chats,
  currentChatId,
  onOpen,
  onPin,
  onDelete,
  onEdit,
}: Props & { project: ProjectDto; onEdit(): void }): ReactElement {
  const [expanded, setExpanded] = useState(
    chats.some((chat) => chat.projectId === project.projectId && chat.chatId === currentChatId),
  );
  const children = chats.filter((chat) => chat.projectId === project.projectId);
  return (
    <div className="sidebar-project">
      <div className="sidebar-project-row">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          title={project.folders.join("\n")}
        >
          <FolderIcon open={expanded} />
          <span>{project.name}</span>
        </button>
        <ProjectRowActions
          name={project.name}
          onNew={() => newProjectChat(project.projectId)}
          onEdit={onEdit}
        />
      </div>
      {expanded && (
        <div className="sidebar-project-chats">
          {children.map((chat) => (
            <SidebarChatItem
              key={chat.chatId}
              chat={chat}
              current={chat.chatId === currentChatId}
              onOpen={onOpen}
              {...(onPin ? { onPin: () => onPin(chat.chatId) } : {})}
              {...(onDelete ? { onDelete: () => onDelete(chat.chatId) } : {})}
            />
          ))}
        </div>
      )}
    </div>
  );
}
export function FolderIcon({ open }: { open: boolean }): ReactElement {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <path
        d={
          open
            ? "M3 8V5a2 2 0 0 1 2-2h5l3 3h6a2 2 0 0 1 2 2v2M3 8h18l-3 11H3Z"
            : "M3 8h18M3 5a2 2 0 0 1 2-2h5l3 3h6a2 2 0 0 1 2 2v11H3Z"
        }
      />
    </svg>
  );
}

function useProjects() {
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void requestProject("project.list").then(
        (result) => {
          if (active) {
            setProjects(result.projects ?? []);
            setError("");
          }
        },
        (cause) => {
          if (active) setError(cause instanceof Error ? cause.message : "Projects unavailable.");
        },
      );
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
    };
  }, []);
  return { projects, setProjects, error };
}

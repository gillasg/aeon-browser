import { useEffect, useRef, type ReactElement } from "react";
import type { ProjectDto } from "@aeon/protocol";
import { useCreateProject } from "./use-create-project.js";
import { ProjectForm } from "./project-form.js";
export function CreateProjectDialog({
  onClose,
  onCreated,
  project,
}: {
  project?: ProjectDto | undefined;
  onClose(): void;
  onCreated(project: ProjectDto): void;
}): ReactElement {
  const dialog = useRef<HTMLDialogElement>(null);
  const state = useCreateProject(onCreated, project);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="create-project-dialog"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) {
          const bounds = dialog.current.getBoundingClientRect();
          if (
            event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom
          )
            onClose();
        }
      }}
    >
      <header>
        <h2>{project ? "Edit project" : "Create project"}</h2>
        <button type="button" aria-label="Close create project" onClick={onClose}>
          ×
        </button>
      </header>
      <ProjectForm state={state} onClose={onClose} editing={Boolean(project)} />
    </dialog>
  );
}

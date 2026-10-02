import { ProjectFolderIcon } from "./project-folder-icon.js";
import type { ReactElement } from "react";
import type { useCreateProject } from "./use-create-project.js";
export function ProjectForm({
  state,
  onClose,
  editing,
}: {
  state: ReturnType<typeof useCreateProject>;
  onClose(): void;
  editing: boolean;
}): ReactElement {
  const { name, setName, busy, error, create } = state;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <label className="project-name">
        <ProjectFolderIcon />
        <input
          autoFocus
          aria-label="Project name"
          placeholder="Project name"
          value={name}
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <h3>Source folder</h3>
      <ProjectFolders state={state} />
      {error && <p role="alert">{error}</p>}
      <footer>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" disabled={busy || !name.trim() || (editing && !state.folders.length)}>
          {busy ? "Please wait…" : editing ? "Save changes" : "Create project"}
        </button>
      </footer>
    </form>
  );
}

function ProjectFolders({ state }: { state: ReturnType<typeof useCreateProject> }): ReactElement {
  const { folders, setFolders, busy, addFolder } = state;
  return (
    <div className="project-source-folders">
      {folders.map((folder) => (
        <div className="project-source-row" key={folder}>
          <span title={folder}>{folder}</span>
          <button
            type="button"
            aria-label={"Remove " + folder}
            onClick={() => setFolders((current) => current.filter((item) => item !== folder))}
          >
            ×
          </button>
        </div>
      ))}
      <p>Add a folder on this computer</p>
      <button type="button" disabled={busy || folders.length >= 1} onClick={() => void addFolder()}>
        <ProjectFolderIcon /> {busy ? "Choosing folder…" : "Add"}
      </button>
    </div>
  );
}

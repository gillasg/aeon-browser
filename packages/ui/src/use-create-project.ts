import { useState, type Dispatch, type SetStateAction } from "react";
import type { ProjectDto } from "@pippin/protocol";
import { requestProject } from "./project-requests.js";
export interface CreateProjectState {
  name: string;
  folders: string[];
  busy: boolean;
  error: string;
  setName: Dispatch<SetStateAction<string>>;
  setFolders: Dispatch<SetStateAction<string[]>>;
  addFolder(): Promise<void>;
  create(): Promise<void>;
}
export function useCreateProject(
  onCreated: (project: ProjectDto) => void,
  project?: ProjectDto,
): CreateProjectState {
  const [name, setName] = useState(project?.name ?? "");
  const [folders, setFolders] = useState<string[]>(project?.folders.slice(0, 1) ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function addFolder(): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const result = await requestProject("project.pick-folder");
      const path = result.path;
      if (path) setFolders([path]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not choose a folder.");
    } finally {
      setBusy(false);
    }
  }
  async function create(): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const result = await requestProject(project ? "project.update" : "project.create", {
        name,
        folders,
        ...(project ? { projectId: project.projectId } : {}),
      });
      if (result.project) onCreated(result.project);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the project.");
    } finally {
      setBusy(false);
    }
  }
  return { name, setName, folders, setFolders, busy, error, addFolder, create };
}

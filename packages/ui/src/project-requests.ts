import type { ProjectDto } from "@aeon/protocol";
export interface ProjectResult {
  projects?: ProjectDto[];
  project?: ProjectDto;
  path?: string | null;
}
export function requestProject(operation: string, payload: unknown = {}): Promise<ProjectResult> {
  return new Promise((resolve, reject) =>
    window.dispatchEvent(
      new CustomEvent("aeon.project-request", {
        detail: { operation, payload, resolve, reject },
      }),
    ),
  );
}
export function newProjectChat(projectId: string): void {
  window.dispatchEvent(new CustomEvent("aeon.project-new-chat", { detail: projectId }));
}

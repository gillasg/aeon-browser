import type { WebSocket } from "ws";
import type { CommandRequest } from "./dev-chat-command-types.js";
import type { ChatService } from "./chat-service.js";
import { completeCommand } from "./chat-command-complete.js";
import { pickProjectFolder } from "./project-service.js";
export type ProjectCommand = Extract<
  CommandRequest,
  { operation: "project.list" | "project.create" | "project.update" | "project.pick-folder" }
>;
export async function sendProjectCommand(
  socket: WebSocket,
  service: ChatService,
  request: ProjectCommand,
): Promise<void> {
  if (request.operation === "project.list")
    return completeCommand(socket, request, {
      kind: "project.list",
      projects: service.projects.list(),
    });
  if (request.operation === "project.pick-folder")
    return completeCommand(socket, request, {
      kind: "project.folder",
      path: await pickProjectFolder(),
    });
  if (request.operation === "project.update")
    return completeCommand(socket, request, {
      kind: "project.updated",
      project: await service.projects.update(
        request.payload.projectId,
        request.payload.name,
        request.payload.folders,
      ),
    });
  const project = await service.projects.create(request.payload.name, request.payload.folders);
  completeCommand(socket, request, { kind: "project.created", project });
}

export function isProjectCommand(request: CommandRequest): request is ProjectCommand {
  return ["project.list", "project.create", "project.update", "project.pick-folder"].includes(
    request.operation,
  );
}

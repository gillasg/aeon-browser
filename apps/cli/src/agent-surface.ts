import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { buildAgentSurface, type AgentSurface, type AgentSurfaceTool } from "@aeon/pi-adapter";
import { dataDirectory } from "./client.js";

export async function runAgentSurface(json: boolean): Promise<number> {
  const root = join(dataDirectory(), "agent-surface");
  await mkdir(root, { recursive: true });
  const run = await mkdtemp(join(root, "run-"));
  try {
    const surface = await buildAgentSurface({
      workingDirectory: join(root, "workspace"),
      agentDirectory: join(run, "agent"),
      sessionDirectory: join(run, "sessions"),
    });
    process.stdout.write(
      json ? JSON.stringify(surface, null, 2) + "\n" : formatAgentSurface(surface),
    );
    return 0;
  } finally {
    await rm(run, { recursive: true, force: true });
  }
}

export function formatAgentSurface(surface: AgentSurface): string {
  return [
    `hash ${surface.hash}`,
    "",
    "System prompt",
    surface.systemPrompt,
    "",
    "Tools",
    ...surface.tools.map(formatTool),
    "",
    "First turn",
    surface.firstTurn,
    "",
  ].join("\n");
}

function formatTool(tool: AgentSurfaceTool): string {
  return ["", tool.name, tool.description, JSON.stringify(tool.parameters)].join("\n");
}

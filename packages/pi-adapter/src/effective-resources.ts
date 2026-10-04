import { createHash } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ChatId, EffectivePiResources } from "@pippin/domain";

export function projectEffectiveResources(
  session: AgentSession,
  chatId: ChatId,
  mcpServers: readonly import("@pippin/domain").PiMcpServerStatus[],
): EffectivePiResources {
  const active = new Set(session.getActiveToolNames());
  const extensions = session.resourceLoader.getExtensions();
  const tools = session.getAllTools();
  const skills = session.resourceLoader.getSkills();
  const resources = {
    chatId,
    sessionState: "loaded" as const,
    mcpServers,
    skills: skills.skills.slice(0, 200).map((skill) => ({
      name: bounded(skill.name, 120),
      description: bounded(skill.description, 2000),
      source: bounded(skill.sourceInfo.source, 300),
    })),
    extensions: extensions.extensions.slice(0, 100).map((extension) => ({
      path: bounded(extension.path, 1000),
      tools: [...extension.tools.keys()].slice(0, 64).map((name) => bounded(name, 120)),
    })),
    extensionErrors: extensions.errors.slice(0, 50).map(({ path, error }) => ({
      path: bounded(path, 1000),
      error: bounded(error, 500),
    })),
    tools: tools.slice(0, 256).map((tool) => ({
      name: bounded(tool.name, 120),
      description: bounded(tool.description, 1000),
      active: active.has(tool.name),
    })),
  };
  const revision = createHash("sha256").update(JSON.stringify(resources)).digest("hex");
  return { ...resources, revision };
}

function bounded(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

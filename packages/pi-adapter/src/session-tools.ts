import { builtinCommands } from "./builtin-commands.js";
import { contentText } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type {
  PiAttachment,
  PiMessageEditResult,
  PiSessionHandle,
  PiSlashCommand,
  PiTreeEntry,
  PiTreeNavigationResult,
} from "@pippin/domain";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { toEntryProjection } from "./session-entry-projection.js";

const MAX_EDIT_TEXT_CHARS = 50_000;
const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 1_048_576;
const MAX_ATTACHMENT_BYTES = 2_097_152;

type SessionTools = Pick<
  PiSessionHandle,
  "tree" | "slashCommands" | "navigateTree" | "editMessage" | "compact"
>;

type MessageEditUnsupportedReason = Extract<
  PiMessageEditResult,
  { status: "unsupported" }
>["reason"];

export function createSessionTools(session: AgentSession, manager: SessionManager): SessionTools {
  return {
    tree: () => readTree(manager),
    slashCommands: () => readSlashCommands(session),
    navigateTree: async (entryId): Promise<PiTreeNavigationResult> => {
      if (!manager.getEntry(entryId)) throw new Error("The requested Pi entry does not exist.");
      const result = await session.navigateTree(entryId);
      return {
        entryId,
        cancelled: result.cancelled,
        editorText: result.cancelled ? null : (result.editorText ?? null),
      };
    },
    editMessage: async (entryId): Promise<PiMessageEditResult> => {
      const entry = manager.getEntry(entryId);
      if (!entry || entry.type !== "message" || entry.message.role !== "user")
        return { status: "unsupported", entryId, reason: "not_user_message" };

      const editorText = contentText(entry.message.content, "");
      if (editorText.length > MAX_EDIT_TEXT_CHARS)
        return { status: "unsupported", entryId, reason: "text_exceeds_composer_limit" };

      const restored = restoreImageAttachments(entry.message.content);
      if (restored.reason) return { status: "unsupported", entryId, reason: restored.reason };

      const result = await session.navigateTree(entryId);
      if (result.cancelled) return { status: "cancelled", entryId };
      return {
        status: "ready",
        entryId,
        editorText: result.editorText ?? editorText,
        attachments: restored.attachments,
        notice: hasInlinedTextAttachment(editorText) ? "text_attachments_remain_inline" : null,
      };
    },
    compact: async (customInstructions) => {
      await session.compact(customInstructions);
    },
  };
}

function restoreImageAttachments(
  content: string | readonly { type: string; data?: string; mimeType?: string }[],
): { attachments: PiAttachment[]; reason?: MessageEditUnsupportedReason } {
  if (typeof content === "string") return { attachments: [] };
  const images = content.filter((block) => block.type === "image");
  if (images.length > MAX_IMAGES)
    return { attachments: [], reason: "image_attachment_limit_exceeded" };
  let totalBytes = 0;
  const attachments: PiAttachment[] = [];
  for (const [index, image] of images.entries()) {
    if (
      !image.data ||
      !image.mimeType ||
      !isSupportedImageMime(image.mimeType) ||
      !isBase64(image.data)
    )
      return { attachments: [], reason: "image_attachment_not_supported" };
    const byteLength = Buffer.byteLength(image.data, "base64");
    totalBytes += byteLength;
    if (byteLength < 1 || byteLength > MAX_IMAGE_BYTES || totalBytes > MAX_ATTACHMENT_BYTES)
      return { attachments: [], reason: "image_attachment_limit_exceeded" };
    attachments.push({
      name: `image-${index + 1}.${imageExtension(image.mimeType)}`,
      mimeType: image.mimeType,
      data: image.data,
      byteLength,
    });
  }
  return { attachments };
}

function hasInlinedTextAttachment(text: string): boolean {
  return /(?:^|\n)--- Attached file: [^\r\n]{1,200} ---\r?\n/.test(text);
}

function isSupportedImageMime(value: string): boolean {
  return ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(value);
}

function imageExtension(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "png";
  }
}

function isBase64(value: string): boolean {
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function readTree(manager: SessionManager): PiTreeEntry[] {
  const result: PiTreeEntry[] = [];
  const leaf = manager.getLeafId();
  const visit = (nodes: ReturnType<SessionManager["getTree"]>, depth: number): void => {
    if (depth > 64 || result.length >= 1000) return;
    for (const node of nodes) {
      if (result.length >= 1000) return;
      const entry = toEntryProjection(node.entry);
      result.push({
        entryId: entry.entryId,
        parentEntryId: entry.parentEntryId,
        category: entry.category,
        timestamp: entry.timestamp,
        label: node.label?.slice(0, 160) ?? null,
        preview:
          entry.message?.role === "tool"
            ? `Tool result · ${entry.message.toolName ?? "tool"}`
            : previewOf(entry.message?.content ?? []),
        currentLeaf: entry.entryId === leaf,
      });
      visit(node.children, depth + 1);
    }
  };
  visit(manager.getTree(), 0);
  return result;
}

function readSlashCommands(session: AgentSession): PiSlashCommand[] {
  const commands = new Map<string, PiSlashCommand>();
  for (const command of session.extensionRunner.getRegisteredCommands()) {
    addCommand(commands, {
      kind: "extension",
      name: command.name,
      invocation: `/${command.invocationName}`,
      description: command.description ?? "Pi extension command",
      argumentHint: null,
    });
  }
  for (const skill of session.resourceLoader.getSkills().skills) {
    if (skill.disableModelInvocation) continue;
    addCommand(commands, {
      kind: "skill",
      name: skill.name,
      invocation: `/skill:${skill.name}`,
      description: skill.description,
      argumentHint: null,
    });
  }
  for (const template of session.promptTemplates) {
    addCommand(commands, {
      kind: "prompt-template",
      name: template.name,
      invocation: `/${template.name}`,
      description: template.description,
      argumentHint: template.argumentHint ?? null,
    });
  }
  for (const command of builtinCommands()) addCommand(commands, command);
  return [...commands.values()].slice(0, 256);
}

function addCommand(target: Map<string, PiSlashCommand>, item: PiSlashCommand): void {
  if (!target.has(item.invocation)) target.set(item.invocation, item);
}

function previewOf(blocks: readonly { type: string; text?: string; toolName?: string }[]): string {
  const text = blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join(" ");
  return (
    text ||
    blocks
      .filter((block) => block.type === "tool-call")
      .map((block) => `Tool call · ${block.toolName ?? "tool"}`)
      .join(", ") ||
    blocks
      .filter((block) => block.type === "thinking")
      .map((block) => (block.text?.trim() ? "Thinking" : ""))
      .join("")
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

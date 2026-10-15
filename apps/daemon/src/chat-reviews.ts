import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Marks which chats have been reviewed (their traces and tool calls read), with the findings saved
// next to the mark. A chat used again after its review counts as unreviewed again.

interface ReviewEntry {
  reviewedAt: string;
  note?: string;
}
interface ReviewableChat {
  chatId: string;
  title: string;
  updatedAt: string;
}
type Content = { content: { type: "text"; text: string }[]; isError: boolean };

export const CHAT_REVIEW_TOOL = {
  name: "chat_review",
  description: [
    "Track which Aeon chats have been reviewed (trace and tool calls read).",
    "action=list: recent chats not reviewed yet, or used again since their review (newest first; limit, default 20; all=true lists reviewed ones too).",
    "action=mark: mark chatId reviewed; note is saved as the findings (reviews/<chatId>.md in Aeon's data folder).",
    "action=get: the review for chatId. action=unmark: clear it.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "mark", "get", "unmark"] },
      chatId: { type: "string", maxLength: 100 },
      note: { type: "string", maxLength: 50000 },
      limit: { type: "number", minimum: 1, maximum: 500 },
      all: { type: "boolean" },
      session: { type: "string", maxLength: 100 },
    },
    required: ["action"],
    additionalProperties: false,
  },
};

const text = (value: unknown, isError = false): Content => ({
  content: [
    { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 1) },
  ],
  isError,
});

export class ChatReviews {
  private readonly folder: string;
  constructor(
    dataDirectory: string,
    private readonly chats: (limit: number) => readonly ReviewableChat[],
  ) {
    this.folder = join(dataDirectory, "reviews");
  }

  async run(args: Record<string, unknown>): Promise<Content> {
    const chatId = typeof args.chatId === "string" ? args.chatId : "";
    if (args.action === "list")
      return text(await this.list(Number(args.limit) || 20, args.all === true));
    if (!chatId) return text("chatId is required", true);
    if (!this.chats(1000).some((chat) => chat.chatId === chatId))
      return text(`No chat ${chatId}`, true);
    if (args.action === "mark") return text(await this.mark(chatId, args.note));
    if (args.action === "unmark") return text(await this.unmark(chatId));
    if (args.action === "get") return text(await this.get(chatId));
    return text("action must be list, mark, get or unmark", true);
  }

  private async list(limit: number, all: boolean) {
    const index = await this.index();
    const rows = this.chats(1000).map((chat) => {
      const review = index[chat.chatId];
      const reviewed = Boolean(review && review.reviewedAt >= chat.updatedAt);
      return { ...chat, reviewed, reviewedAt: review?.reviewedAt };
    });
    return rows.filter((row) => all || !row.reviewed).slice(0, limit);
  }

  private async mark(chatId: string, note: unknown) {
    const index = await this.index();
    const entry: ReviewEntry = { reviewedAt: new Date().toISOString() };
    if (typeof note === "string" && note.trim()) {
      entry.note = `reviews/${chatId}.md`;
      await writeFile(join(this.folder, `${chatId}.md`), note);
    }
    index[chatId] = entry;
    await this.save(index);
    return { chatId, ...entry };
  }

  private async unmark(chatId: string) {
    const index = await this.index();
    delete index[chatId];
    await this.save(index);
    return { chatId, reviewed: false };
  }

  private async get(chatId: string) {
    const entry = (await this.index())[chatId];
    if (!entry) return { chatId, reviewed: false };
    const note = entry.note
      ? await readFile(join(this.folder, `${chatId}.md`), "utf8").catch(() => undefined)
      : undefined;
    return { chatId, ...entry, note };
  }

  private async index(): Promise<Record<string, ReviewEntry>> {
    await mkdir(this.folder, { recursive: true });
    try {
      return JSON.parse(await readFile(join(this.folder, "index.json"), "utf8")) as Record<
        string,
        ReviewEntry
      >;
    } catch {
      return {};
    }
  }

  private save(index: Record<string, ReviewEntry>): Promise<void> {
    return writeFile(join(this.folder, "index.json"), JSON.stringify(index, null, 1));
  }
}

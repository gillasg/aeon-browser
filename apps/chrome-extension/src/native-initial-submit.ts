import { ChatIdSchema, PiAttachmentSchema, type PiAttachmentDto } from "@pippin/protocol";
import { z } from "zod";

const HANDOFF_TTL_MS = 2 * 60 * 1000;
const PREFIX = "pippin.initial-submit.";

interface InitialSubmit {
  requestId: string;
  text: string;
  model: { provider: string; id: string };
  thinkingLevel: string;
  attachments?: PiAttachmentDto[] | undefined;
}

const InitialSubmitRecordSchema = z
  .object({
    requestId: z.string().uuid(),
    text: z.string().min(1).max(50_000),
    model: z
      .object({ provider: z.string().min(1).max(120), id: z.string().min(1).max(300) })
      .strict(),
    thinkingLevel: z.string().min(1).max(40),
    attachments: z.array(PiAttachmentSchema).max(3).optional(),
    chatId: ChatIdSchema,
    tabId: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
  })
  .strict();

const takeLocks = new Map<number, Promise<void>>();

export async function stageInitialSubmit(
  tabId: number,
  chatId: string,
  initialSubmit: InitialSubmit,
): Promise<void> {
  const record = InitialSubmitRecordSchema.parse({
    ...initialSubmit,
    chatId: ChatIdSchema.parse(chatId),
    tabId,
    expiresAt: Date.now() + HANDOFF_TTL_MS,
  });
  await chrome.storage.session.set({ [storageKey(tabId)]: record });
}

export async function clearInitialSubmit(tabId: number): Promise<void> {
  await chrome.storage.session.remove(storageKey(tabId));
}

export async function takeInitialSubmit(
  tabId: number,
  chatId: string,
): Promise<InitialSubmit | undefined> {
  const previous = takeLocks.get(tabId);
  let release!: () => void;
  const lock = new Promise<void>((resolve) => (release = resolve));
  takeLocks.set(tabId, lock);
  if (previous) await previous;
  try {
    const key = storageKey(tabId);
    const values = await chrome.storage.session.get(key);
    await chrome.storage.session.remove(key);
    return validateInitialSubmitRecord(values[key], tabId, chatId);
  } finally {
    release();
    if (takeLocks.get(tabId) === lock) takeLocks.delete(tabId);
  }
}

function storageKey(tabId: number): string {
  return `${PREFIX}${tabId}`;
}

export function validateInitialSubmitRecord(
  value: unknown,
  tabId: number,
  chatId: string,
  now = Date.now(),
): InitialSubmit | undefined {
  const result = InitialSubmitRecordSchema.safeParse(value);
  if (!result.success) return undefined;
  const record = result.data;
  if (record.tabId !== tabId || record.chatId !== chatId || record.expiresAt <= now)
    return undefined;
  return {
    requestId: record.requestId,
    text: record.text,
    model: { ...record.model },
    thinkingLevel: record.thinkingLevel,
    ...(record.attachments ? { attachments: record.attachments } : {}),
  };
}

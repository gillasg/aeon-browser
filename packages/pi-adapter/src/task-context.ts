// The user's task for this chat, so a later cell can tell an asked submit from an official form.

const tasks = new Map<string, string>();

export function rememberTask(chatId: string, prompt: string): void {
  tasks.set(chatId, prompt);
}

export function taskOf(chatId: string): string {
  return tasks.get(chatId) ?? "";
}

/** A later user message is part of the task. The original prompt is not stored twice. */
export function noteSteer(chatId: string, text: string): void {
  const next = text.trim();
  if (!chatId || !next) return;
  const current = tasks.get(chatId) ?? "";
  if (!current) {
    tasks.set(chatId, next);
    return;
  }
  if (current === next || current.startsWith(`${next}\n`) || current.endsWith(`\n${next}`)) return;
  tasks.set(chatId, `${current}\n${next}`);
}

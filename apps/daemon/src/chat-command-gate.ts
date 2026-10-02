import type { ChatId } from "@pippin/domain";

export class ChatCommandGate {
  private readonly tails = new Map<ChatId, Promise<void>>();

  async run<T>(chatId: ChatId, command: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(chatId) ?? Promise.resolve();
    let release = (): void => {};
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => next);
    this.tails.set(chatId, tail);
    await previous;
    try {
      return await command();
    } finally {
      release();
      if (this.tails.get(chatId) === tail) this.tails.delete(chatId);
    }
  }
}

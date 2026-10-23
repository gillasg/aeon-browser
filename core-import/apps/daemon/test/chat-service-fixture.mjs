import { resolve } from "node:path";
import { ChatService as ProductionChatService } from "../dist/chat-service.js";

const services = new Map();
export class ChatService extends ProductionChatService {
  constructor(options) {
    super(options);
    const directory = resolve(options.dataDirectory);
    const current = services.get(directory) ?? [];
    current.push(this);
    services.set(directory, current);
  }
}
export function closeProjectServices(directory) {
  const key = resolve(directory);
  for (const service of services.get(key) ?? []) service.projects.close();
  services.delete(key);
}

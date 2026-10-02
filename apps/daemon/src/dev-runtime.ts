import { join, resolve } from "node:path";
import { ChatService } from "./chat-service.js";
import { PiSdkSessionAdapter } from "@pippin/pi-adapter";
import { openChatStore } from "@pippin/store";
import { ThreadCoordinationService } from "./thread-coordination-service.js";

export function createLocalFixtureRuntime(dataDirectory: string): {
  service: ChatService;
  threadCoordination: ThreadCoordinationService;
  ready: Promise<void>;
  close(): Promise<void>;
} {
  const dataRoot = resolve(dataDirectory);
  const store = openChatStore(dataRoot);
  const pi = new PiSdkSessionAdapter({
    sessionDirectory: join(dataRoot, "pi-sessions"),
    agentDirectory: join(dataRoot, "pi-agent-config"),
    testModel: "local-faux",
  });
  const service = new ChatService({ dataDirectory: dataRoot, store, pi });
  const threadCoordination = new ThreadCoordinationService(service, store);
  pi.setThreadToolHost(threadCoordination);
  const ready = threadCoordination.recover();
  return {
    service,
    threadCoordination,
    ready,
    close: async () => {
      threadCoordination.close();
      await pi.closeAll();
      service.projects.close();
      store.close();
    },
  };
}

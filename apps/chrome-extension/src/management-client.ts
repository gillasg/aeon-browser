import type { UiClient } from "./ui-client-core.js";
import { connectNativeUi } from "./native-ui-client.js";

export function createManagementClient(
  native: boolean,
  catalog: () => UiClient | undefined,
): () => Promise<UiClient | undefined> {
  let pending: Promise<UiClient> | undefined;
  return async () => {
    if (!native) return catalog();
    pending ??= connectNativeUi({ kind: "management" })
      .then((result) => {
        if (result.kind !== "connected") {
          pending = undefined;
          throw new Error(`Management connection unavailable · ${result.code}`);
        }
        result.client.socket.addEventListener(
          "close",
          () => {
            pending = undefined;
          },
          { once: true },
        );
        return result.client;
      })
      .catch((error: unknown) => {
        pending = undefined;
        throw error;
      });
    return pending;
  };
}

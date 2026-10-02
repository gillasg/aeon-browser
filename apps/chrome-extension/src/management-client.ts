import type { DevUiClient } from "./dev-ui-client.js";
import { connectNativeUi } from "./native-ui-client.js";

export function createManagementClient(
  native: boolean,
  catalog: () => DevUiClient | undefined,
): () => Promise<DevUiClient | undefined> {
  let pending: Promise<DevUiClient> | undefined;
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

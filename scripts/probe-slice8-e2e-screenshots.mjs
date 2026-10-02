import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function captureScreenshot(send, sessionId, path, captureBeyondViewport = false) {
  await mkdir(dirname(path), { recursive: true });
  const captured = await send(
    "Page.captureScreenshot",
    { format: "png", captureBeyondViewport },
    sessionId,
  );
  await writeFile(path, Buffer.from(captured.data, "base64"));
}

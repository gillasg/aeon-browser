// A way whose result no longer has the fields its schema names fails that way and queues a
// background heal. The ability falls through to the next way.

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { siteDir, siteName } from "./registry.js";

export async function queueHeal(
  site: string,
  name: string,
  way: string,
  reason: string,
): Promise<void> {
  const folder = siteDir(siteName(site));
  await mkdir(folder, { recursive: true });
  const line = JSON.stringify({ at: new Date().toISOString(), name, way, reason }) + "\n";
  await appendFile(join(folder, "heal.jsonl"), line, "utf8");
}

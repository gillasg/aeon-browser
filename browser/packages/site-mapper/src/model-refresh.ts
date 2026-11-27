import { INFERENCE_VERSION } from "./pipeline.js";
import { listFlows, loadModel, siteName } from "./registry.js";
import type { SiteModel } from "./types.js";
import { rebuild } from "./workflow.js";

// A saved model built by older inference rules is rebuilt from the site's stored flows when it
// is opened, so engine upgrades reach every saved site. A rebuild that fails keeps the saved
// model: a refresh never takes a working site away.

const REFRESH_MS = 60_000;
const refreshing = new Map<string, Promise<SiteModel | undefined>>();

export function isStaleModel(model: SiteModel | undefined): boolean {
  return !!model && (model.inferenceVersion ?? 0) < INFERENCE_VERSION;
}

/** The site's model, rebuilt in place first when older rules made it and flows exist. */
export async function loadCurrentModel(site: string): Promise<SiteModel | undefined> {
  const name = siteName(site);
  const model = await loadModel(name);
  if (!isStaleModel(model)) return model;
  let pending = refreshing.get(name);
  if (!pending) {
    pending = refresh(name, model).finally(() => refreshing.delete(name));
    refreshing.set(name, pending);
  }
  return pending;
}

async function refresh(site: string, model: SiteModel | undefined): Promise<SiteModel | undefined> {
  if (!(await listFlows(site).catch(() => [])).length) return model;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), REFRESH_MS);
    timer.unref?.();
  });
  try {
    const rebuilt = await Promise.race([rebuild(site).then((result) => result.model), timeout]);
    return rebuilt?.operations.length ? rebuilt : model;
  } catch {
    return model;
  } finally {
    clearTimeout(timer);
  }
}

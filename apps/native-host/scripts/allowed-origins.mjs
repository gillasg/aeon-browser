// The origins a native messaging manifest allows. The unpacked build's fixed id always comes
// first; store builds (Chrome Web Store, Edge Add-ons) add their own ids through
// AEON_STORE_EXTENSION_IDS, a comma- or space-separated list. Unset, nothing changes.

const ID = /^[a-p]{32}$/;

/** Store extension ids from the environment, validated and de-duplicated. */
export function storeExtensionIds(env = process.env) {
  const raw = env.AEON_STORE_EXTENSION_IDS ?? "";
  const ids = raw.split(/[\s,]+/).filter(Boolean);
  for (const id of ids) if (!ID.test(id)) throw new Error(`Not an extension id: ${id}`);
  return [...new Set(ids)];
}

export function allowedOrigins(devId, extraIds = []) {
  return [...new Set([devId, ...extraIds])].map((id) => `chrome-extension://${id}/`);
}

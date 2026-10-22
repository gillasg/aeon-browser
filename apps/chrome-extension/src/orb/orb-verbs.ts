// The site's own verbs as chips in the orb: what Aeon learned it can do on this site, from the
// site's operations ("List orders", "Remove from watch later"). A read runs at once; a write
// fills the prompt so the user says which items.

export interface SiteVerb {
  label: string;
  /** Sent as is (reads), or put in the prompt to finish (writes). */
  prompt: string;
  run: boolean;
}

interface Operation {
  id: string;
  writes?: boolean;
}

// Plumbing nobody would ask for by name.
const NOISE =
  /^(graphql[0-9a-f]+|get(metadata|config|settings|token|session|csrf|user|me|flags?|experiments?)|log|track|ping|heartbeat|root|get|list)$/i;

export function siteVerbs(host: string, operations: readonly Operation[]): SiteVerb[] {
  const named = operations.filter(
    (operation) => operation.id.length > 3 && !NOISE.test(operation.id),
  );
  const reads = named.filter((operation) => !operation.writes).slice(0, 3);
  const writes = named.filter((operation) => operation.writes).slice(0, 2);
  return [...reads, ...writes].slice(0, 4).map((operation) => {
    const label = words(operation.id);
    return operation.writes
      ? { label, prompt: `${label}: `, run: false }
      : { label, prompt: `${label} on ${host}`, run: true };
  });
}

/** listOrders → "List orders", removeFromWatchLater → "Remove from watch later". */
function words(id: string): string {
  const text = id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

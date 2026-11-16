// Answers for the browser's private-network preflight. An IP literal is that address. Anything
// else is a name and must be resolved: echoing a hex-looking name would skip the real lookup.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type DnsLookup = (host: string) => Promise<readonly string[]>;

function bareHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
}

async function machineLookup(host: string): Promise<string[]> {
  const rows = await lookup(host, { all: true, verbatim: true });
  return rows.map((row) => row.address);
}

/** Addresses for `host`. Never returns a name, a mapped spelling that is not an IP, or brackets. */
export async function dnsAnswers(
  host: string,
  resolve: DnsLookup = machineLookup,
): Promise<string[]> {
  const bare = bareHost(host);
  if (!bare) return [];
  if (isIP(bare)) return [bare];
  const found = await resolve(bare);
  return found.filter((address) => isIP(address) !== 0);
}

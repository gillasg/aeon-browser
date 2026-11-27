// A webhook only ever reaches a public address. The URL is parsed once, its host resolved at send
// time, every address checked, and the socket pinned to the checked address so a DNS rebind
// between the check and the connect cannot win. Redirects are never followed.
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { connectionAddress, privateAddress } from "@browserkit/protocol";

export type Resolve = (host: string) => Promise<{ address: string; family: number }[]>;

export interface Pinned {
  url: URL;
  address: string;
  family: 4 | 6;
}

export interface PostResult {
  status: number;
  location: string;
}

/** The host has no address right now: not a private one, so creating it is fine; sending waits. */
export class UnresolvedWebhookHost extends Error {}

const LOCAL_NAMES = /(^|\.)(localhost|local|internal)$/;
const PUBLIC_ONLY = "webhook url must target a public host, not a local or private network address";

const defaultResolve: Resolve = (host) => dnsLookup(host, { all: true, verbatim: true });

const bare = (host: string): string => host.toLowerCase().replace(/^\[|\]$/g, "");

/** Why this URL may never be a webhook, before any lookup. `new URL` folds 0x7f000001, 127.1… */
export function webhookUrlRefusal(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "webhook url must be an http(s) URL.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return "webhook url must be an http(s) URL.";
  if (url.username || url.password) return "webhook url must not carry a user name or password.";
  const host = bare(url.hostname);
  if (!host || LOCAL_NAMES.test(host)) return `${PUBLIC_ONLY} (${host || "no host"}).`;
  const reason = isIP(host) ? addressRefusal(host) : undefined;
  return reason ? `${PUBLIC_ONLY} (${reason}).` : undefined;
}

function addressRefusal(address: string): string | undefined {
  if (!connectionAddress(address)) return `${address} is not an address`;
  return privateAddress(address);
}

/** Resolves the host and checks every address it has. Throws with the reason when one is private. */
export async function resolveWebhook(
  raw: string,
  resolve: Resolve = defaultResolve,
): Promise<Pinned> {
  const refused = webhookUrlRefusal(raw);
  if (refused) throw new Error(refused);
  const url = new URL(raw);
  const host = bare(url.hostname);
  const family = isIP(host);
  if (family === 4 || family === 6) return { url, address: host, family };
  let found: { address: string; family: number }[];
  try {
    found = await resolve(host);
  } catch (error) {
    throw new UnresolvedWebhookHost(`webhook host ${host} did not resolve: ${errorText(error)}`);
  }
  if (!found.length) throw new UnresolvedWebhookHost(`webhook host ${host} did not resolve.`);
  for (const entry of found) {
    const reason = addressRefusal(entry.address);
    if (reason) throw new Error(`${PUBLIC_ONLY} (${host} resolves to ${reason}).`);
  }
  const [first] = found;
  if (!first) throw new UnresolvedWebhookHost(`webhook host ${host} did not resolve.`);
  return { url, address: first.address, family: first.family === 6 ? 6 : 4 };
}

function pinLookup(address: string, family: 4 | 6): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

/** One POST to the pinned address. Host and TLS SNI keep the name; a 3xx is returned, not followed. */
export function postPinned(
  pinned: Pinned,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<PostResult> {
  return new Promise((resolve, reject) => {
    const options = {
      method: "POST",
      headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
      lookup: pinLookup(pinned.address, pinned.family),
      agent: false as const,
      timeout: timeoutMs,
    };
    const onResponse = (res: IncomingMessage): void => {
      res.resume();
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, location: String(res.headers.location ?? "") }),
      );
      res.on("error", reject);
    };
    const req: ClientRequest =
      pinned.url.protocol === "https:"
        ? httpsRequest(
            pinned.url,
            { ...options, servername: bare(pinned.url.hostname) },
            onResponse,
          )
        : httpRequest(pinned.url, options, onResponse);
    const timer = setTimeout(
      () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)),
      timeoutMs,
    );
    req.on("close", () => clearTimeout(timer));
    req.on("timeout", () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)));
    req.on("error", reject);
    req.on("socket", (socket) => {
      const verify = (): void => {
        const peer = socket.remoteAddress ?? "";
        // The pin was checked by resolveWebhook; the socket must land on exactly that address.
        if (connectionAddress(peer) === connectionAddress(pinned.address)) req.end(body);
        else req.destroy(new Error(`${PUBLIC_ONLY} (connected to ${peer || "nothing"}).`));
      };
      if (socket.remoteAddress) verify();
      else socket.once("connect", verify);
    });
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

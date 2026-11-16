// Connect to the address the guard already checked. The URL keeps its name, so the Host header
// and TLS SNI stay the name the site expects. A second lookup would reopen the rebinding window.
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type RequestOptions,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction, type Socket } from "node:net";
import { connectionAddress, privateAddress } from "@browserkit/protocol";

export interface PinnedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  address: string;
  host: string;
  /** A public site may not land on a private or mapped address, even when that matches the pin. */
  publicReach: boolean;
}

export interface PinnedResult {
  status: number;
  headers: Record<string, string>;
  location: string;
  setCookies: string[];
  text: string;
}

/** Why this pin must not be connected to, before any socket exists. */
export function rejectPin(address: string, publicReach: boolean): string | undefined {
  if (!connectionAddress(address)) return "pinned address is not an address";
  if (!publicReach) return undefined;
  return privateAddress(address);
}

function peerReason(pinned: string, peer: string, publicReach: boolean): string | undefined {
  if (!peer) return "connected without a peer address";
  if (publicReach) {
    const blocked = privateAddress(peer);
    if (blocked) return blocked;
  }
  if (connectionAddress(peer) !== connectionAddress(pinned))
    return `connected to ${peer} instead of ${pinned}`;
  return undefined;
}

function pinLookup(address: string): LookupFunction {
  const family = isIP(address);
  return (_hostname, options, callback) => {
    if (family !== 4 && family !== 6) {
      callback(new Error("PRIVATE_NETWORK: pinned address is not an address"), "", 0);
      return;
    }
    if (options.all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
}

function requestOptions(input: PinnedCall): RequestOptions {
  return {
    method: input.method,
    headers: input.headers,
    lookup: pinLookup(input.address),
    agent: false,
  };
}

function start(
  target: URL,
  input: PinnedCall,
  onResponse: (res: IncomingMessage) => void,
): ClientRequest {
  const options = requestOptions(input);
  if (target.protocol === "https:")
    return httpsRequest(target, { ...options, servername: input.host }, onResponse);
  return httpRequest(target, options, onResponse);
}

function sendAfterCheck(
  req: ClientRequest,
  socket: Socket,
  input: PinnedCall,
  fail: (error: unknown) => void,
): void {
  const verify = (): void => {
    const reason = peerReason(input.address, socket.remoteAddress ?? "", input.publicReach);
    if (reason) {
      socket.destroy();
      req.destroy();
      fail(new Error(`PRIVATE_NETWORK: ${reason}`));
      return;
    }
    if (input.body !== undefined) req.end(input.body);
    else req.end();
  };
  if (socket.remoteAddress) verify();
  else socket.once("connect", verify);
}

function resultOf(res: IncomingMessage, text: string): PinnedResult {
  const headers: Record<string, string> = {};
  const setCookies: string[] = [];
  for (const [name, value] of Object.entries(res.headers)) {
    if (value === undefined) continue;
    if (name === "set-cookie" && Array.isArray(value)) {
      setCookies.push(...value);
      headers[name] = value.join(", ");
      continue;
    }
    headers[name] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return {
    status: res.statusCode ?? 0,
    headers,
    location: headers.location ?? "",
    setCookies,
    text,
  };
}

function readResponse(res: IncomingMessage): Promise<PinnedResult> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    res.on("end", () => resolve(resultOf(res, Buffer.concat(chunks).toString("utf8"))));
    res.on("error", reject);
  });
}

function openPinned(input: PinnedCall): Promise<PinnedResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const done = (result: PinnedResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const req = start(new URL(input.url), input, (res) => {
      void readResponse(res).then(done, fail);
    });
    req.on("error", fail);
    req.on("socket", (socket) => sendAfterCheck(req, socket, input, fail));
  });
}

/** One HTTP request to `address`, with Host and SNI taken from the original name. */
export function pinnedRequest(input: PinnedCall): Promise<PinnedResult> {
  const refused = rejectPin(input.address, input.publicReach);
  if (refused) return Promise.reject(new Error(`PRIVATE_NETWORK: ${refused}`));
  return openPinned(input);
}

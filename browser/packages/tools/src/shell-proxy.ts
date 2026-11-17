// The shell is a second browser. curl, wget and anything else that honors the proxy environment
// goes through here, including a redirect from an allowed host into a blocked one. The page is
// never contacted: the answer is the same SITE_BLOCKED the browser would give.
//
// COVERAGE, STATED HONESTLY: this guard is proxy environment variables injected into the child
// process, not a network-level sandbox. It covers clients that honour HTTP(S)_PROXY/ALL_PROXY and
// NO_PROXY. A command that opts out (`curl --noproxy`, `env -u HTTP_PROXY`, an explicit NO_PROXY,
// an `unset`) or a program that ignores proxy env vars entirely (raw sockets, PowerShell/WinHTTP,
// many native clients) reaches the site without asking this proxy. useBrowser tools are the
// enforced path for those; do not treat the shell proxy as a guarantee.
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { connect as netConnect } from "node:net";
import type { Duplex } from "node:stream";
import { blockedSiteReason } from "./web-gate.js";

const REDIRECT = new Set([301, 302, 303, 307, 308]);
let listening: Promise<string> | undefined;

/** One local proxy for the life of the process. */
export function shellProxyUrl(): Promise<string> {
  listening ??= listen();
  return listening;
}

/** Environment that sends a shell's HTTP clients through the gate. */
export async function shellProxyEnv(): Promise<Record<string, string>> {
  const url = await shellProxyUrl();
  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    ALL_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    all_proxy: url,
    NO_PROXY: "",
    no_proxy: "",
  };
}

function listen(): Promise<string> {
  const server = createServer((req, res) => {
    void forward(req, res);
  });
  server.on("connect", (req, socket, head) => {
    void tunnel(req, socket, head);
  });
  server.unref();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("shell proxy did not bind"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function refuse(res: ServerResponse, reason: string, status = 403): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(reason);
}

async function forward(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let target: URL;
  try {
    target = new URL(req.url ?? "");
  } catch {
    refuse(res, "SITE_UNREACHABLE: that address is not a URL the shell proxy can check", 400);
    return;
  }
  const reason = await blockedSiteReason(target.href);
  if (reason) {
    refuse(res, reason);
    return;
  }
  const headers = { ...req.headers };
  delete headers.host;
  delete headers["proxy-connection"];
  delete headers["proxy-authorization"];
  const outbound = httpRequest(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: req.method,
      headers,
    },
    (upstream) => {
      void answer(target.href, upstream, res);
    },
  );
  // A transport failure on an ALLOWED host is a network problem, never a user block. Saying
  // SITE_BLOCKED here made agents stop and tell the user the site was blocked when it was merely
  // unreachable, and the terminal no-recovery SITE_BLOCKED handling made them stop for good.
  outbound.on("error", (error: NodeJS.ErrnoException) =>
    refuse(
      res,
      `SITE_UNREACHABLE: the shell proxy could not reach ${target.host} (${error.code ?? "network error"}). ` +
        "This is a connection failure, not a blocked site; retry or report the network problem.",
      502,
    ),
  );
  req.pipe(outbound);
}

async function redirectReason(
  page: string,
  upstream: IncomingMessage,
): Promise<string | undefined> {
  const location = upstream.headers.location;
  if (!location || !REDIRECT.has(upstream.statusCode ?? 0)) return undefined;
  try {
    return await blockedSiteReason(new URL(location, page).href);
  } catch {
    return undefined;
  }
}

async function answer(page: string, upstream: IncomingMessage, res: ServerResponse): Promise<void> {
  upstream.pause();
  const reason = await redirectReason(page, upstream);
  if (reason) {
    upstream.destroy();
    refuse(res, reason);
    return;
  }
  res.writeHead(upstream.statusCode ?? 502, upstream.headers);
  upstream.resume();
  upstream.pipe(res);
}

async function tunnel(req: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
  const reason = await blockedSiteReason(`https://${req.url ?? ""}`);
  if (reason) {
    client.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\n${reason}`);
    return;
  }
  const [hostname, portText] = (req.url ?? "").split(":");
  const remote = netConnect(Number(portText || 443), hostname ?? "", () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) remote.write(head);
    remote.pipe(client);
    client.pipe(remote);
  });
  remote.on("error", () => client.end());
}

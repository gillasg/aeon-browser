import { createServer, type Server } from "node:http";
import { matchPath } from "./serve.js";
import type { Operation, Sample, SiteModel } from "./types.js";

// A replay-only local server for a model built from a capture: each request is matched to an
// operation by method and path template (the same matcher `serve` uses) and answered with the
// recorded response. Nothing is forwarded to the real site. For tests, evals and offline work.

export interface MockServer {
  url: string;
  close(): Promise<void>;
}

export function pickSample(operation: Operation, path: string, search: string): Sample | undefined {
  const exact = operation.samples.filter((sample) => {
    try {
      const url = new URL(sample.url);
      return url.pathname === path;
    } catch {
      return false;
    }
  });
  const pool = exact.length ? exact : operation.samples;
  return (
    pool.find((sample) => sample.url.endsWith(search) && search) ??
    pool.find((sample) => sample.status < 400) ??
    pool[0]
  );
}

function mimeOf(operation: Operation, status: number): string {
  return operation.responses[String(status)]?.mime || "application/json";
}

export async function serveMock(
  model: SiteModel,
  options: { port?: number } = {},
): Promise<MockServer> {
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const method = request.method ?? "GET";
    for (const operation of model.operations) {
      if (!matchPath(operation, method, url.pathname)) continue;
      const sample = pickSample(operation, url.pathname, url.search);
      if (!sample) continue;
      response.writeHead(sample.status || 200, {
        "content-type": mimeOf(operation, sample.status),
        "x-graft-mock": operation.id,
      });
      response.end(sample.responseBody ?? "");
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: `no recorded operation for ${method} ${url.pathname}` }));
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

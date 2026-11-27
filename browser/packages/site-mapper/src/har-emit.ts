import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { toOpenApi } from "./emit/openapi.js";
import { generateDirectClient } from "./emit/standalone-client.js";
import { loadCapture } from "./load/index.js";
import { serveMock, type MockServer } from "./mock-serve.js";
import { exportSitePack } from "./pack.js";
import { buildSiteModel } from "./pipeline.js";
import type { SiteModel } from "./types.js";
import { importCaptures, rebuild } from "./workflow.js";

// One saved HAR (or mitmproxy) file, turned into something usable without a browser:
// a standalone typed client, a site pack whose OpenAPI carries x-graft-observations, or a local
// replay-only mock server.

export type HarEmit = "client" | "pack" | "mock";

export interface HarEmitOptions {
  emit: HarEmit;
  /** Output directory (client) or file (pack, a .zip). */
  out?: string;
  /** Site name; defaults to the capture's most common host. */
  site?: string;
  port?: number;
}

export interface HarEmitResult {
  site: string;
  operations: number;
  written: string[];
  server?: MockServer;
  summary: string;
}

/** The model a capture builds, without saving anything. */
export async function modelFromCapture(file: string, site?: string): Promise<SiteModel> {
  const exchanges = await loadCapture(file);
  if (!exchanges.length) throw new Error(`${file} holds no requests`);
  const name = site ?? mostCommonHost(exchanges.map((exchange) => exchange.url));
  return (await buildSiteModel(exchanges, { site: name })).model;
}

function mostCommonHost(urls: string[]): string {
  const counts = new Map<string, number>();
  for (const url of urls) {
    try {
      const host = new URL(url).hostname.replace(/^www\./, "");
      counts.set(host, (counts.get(host) ?? 0) + 1);
    } catch {
      // skip unparsable URLs
    }
  }
  const best = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!best) throw new Error("capture has no http(s) requests");
  return best;
}

export async function emitFromHar(file: string, options: HarEmitOptions): Promise<HarEmitResult> {
  if (options.emit === "pack") return emitPack(file, options);
  const model = await modelFromCapture(file, options.site);
  const operations = model.operations.length;
  if (options.emit === "mock") {
    const server = await serveMock(model, options.port ? { port: options.port } : {});
    return {
      site: model.site,
      operations,
      written: [],
      server,
      summary: `Replaying ${operations} operations of ${model.site} at ${server.url}`,
    };
  }
  const dir = resolve(options.out ?? `${model.site}-client`);
  await mkdir(dir, { recursive: true });
  const client = join(dir, "client.ts");
  const spec = join(dir, "openapi.json");
  await writeFile(client, generateDirectClient(model));
  await writeFile(spec, JSON.stringify(toOpenApi(model), null, 2));
  return {
    site: model.site,
    operations,
    written: [client, spec],
    summary: `Wrote a typed client for ${operations} operations of ${model.site}`,
  };
}

async function emitPack(file: string, options: HarEmitOptions): Promise<HarEmitResult> {
  const model = await modelFromCapture(file, options.site);
  await importCaptures(model.site, [file]);
  await rebuild(model.site);
  const out = resolve(options.out ?? `${model.site}-${basename(file, extname(file))}.zip`);
  const pack = await exportSitePack({ site: model.site, out, publish: "warn" });
  return {
    site: model.site,
    operations: model.operations.length,
    written: [out],
    summary: `Wrote a site pack for ${model.site} (${pack.files.length} files) to ${out}`,
  };
}

import type { SiteModel } from "../types.js";

// Published API descriptions: OpenAPI/Swagger documents at their usual paths, and the schema of
// each GraphQL endpoint the site uses (introspection). Read from the site's own page, so the
// user's session applies. They list operations nobody has clicked yet; call them with
// browser.fetch, or explore with a goal that uses them so they get mapped.

const DOC_PATHS = [
  "/openapi.json",
  "/swagger.json",
  "/api/openapi.json",
  "/api/swagger.json",
  "/v3/api-docs",
  "/v2/api-docs",
  "/api-docs",
  "/api/docs/openapi.json",
  "/.well-known/openapi.json",
  "/swagger/v1/swagger.json",
];

const INTROSPECTION =
  "query{__schema{queryType{name}mutationType{name}subscriptionType{name}types{kind name description fields{name description args{name type{kind name ofType{kind name ofType{kind name}}}}type{kind name ofType{kind name ofType{kind name}}}}inputFields{name type{kind name ofType{kind name}}}enumValues{name}}}}";

export interface SiteDocs {
  openapi: { url: string; title?: string; document: Record<string, unknown> }[];
  graphql: { url: string; schema: Record<string, unknown> }[];
}

export interface DocsSummary {
  openapi: { url: string; title?: string; operations: string[] }[];
  graphql: {
    url: string;
    queries: string[];
    mutations: string[];
    subscriptions: string[];
    types: number;
  }[];
}

/** Where to look: the usual doc paths on each origin, and every GraphQL endpoint in the model. */
export function docsTargets(model: SiteModel): { docs: string[]; graphql: string[] } {
  const origins = model.origins.length ? model.origins : [`https://${model.site}`];
  const graphql = new Set<string>();
  for (const op of model.operations)
    if (op.kind === "graphql") graphql.add(new URL(op.path, op.origin).href);
  return {
    docs: origins.flatMap((origin) => DOC_PATHS.map((path) => new URL(path, origin).href)),
    graphql: [...graphql],
  };
}

/** What one fetch may take, how many run at once, and how long the whole probe may last. */
export const DOCS_FETCH_MS = 2500;
export const DOCS_CONCURRENCY = 4;
export const DOCS_TOTAL_MS = 8000;

/**
 * Page code that fetches the candidates and returns what answered. Most sites answer none of the
 * doc paths, and a host that hangs instead of refusing must not stall mapping: every fetch has
 * its own timeout, a few run at once, and the probe as a whole gives up after a fixed budget
 * and returns what it has.
 */
export function docsExpression(
  targets: { docs: string[]; graphql: string[] },
  limits: { fetchMs?: number; totalMs?: number; concurrency?: number } = {},
): string {
  const fetchMs = limits.fetchMs ?? DOCS_FETCH_MS;
  const totalMs = limits.totalMs ?? DOCS_TOTAL_MS;
  const concurrency = limits.concurrency ?? DOCS_CONCURRENCY;
  return `(async () => {
  const t = ${JSON.stringify(targets)};
  const started = Date.now();
  const left = () => ${totalMs} - (Date.now() - started);
  const signalFor = (ms) => {
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) return { signal: AbortSignal.timeout(ms) };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    return { signal: controller.signal, done: () => clearTimeout(timer) };
  };
  const json = async (url, init) => {
    const budget = Math.min(${fetchMs}, left());
    if (budget <= 0) return undefined;
    const limit = signalFor(budget);
    try {
      const response = await fetch(url, { credentials: 'include', ...init, signal: limit.signal });
      if (!response.ok) return undefined;
      return await response.json();
    } catch { return undefined; } finally { if (limit.done) limit.done(); }
  };
  const results = new Map();
  const jobs = [
    ...t.docs.map((url, index) => ({ index, run: async () => {
      const doc = await json(url);
      if (doc && (doc.openapi || doc.swagger) && doc.paths) results.set(index, { kind: 'openapi', value: { url, title: doc.info?.title, document: doc } });
    } })),
    ...t.graphql.map((url, index) => ({ index: t.docs.length + index, run: async () => {
      const body = await json(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: ${JSON.stringify(INTROSPECTION)} }),
      });
      if (body?.data?.__schema) results.set(t.docs.length + index, { kind: 'graphql', value: { url, schema: body.data.__schema } });
    } })),
  ];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length && left() > 0) await jobs[next++].run();
  };
  const pool = Promise.all(Array.from({ length: Math.min(${concurrency}, jobs.length) }, worker));
  // A fetch that ignores its abort cannot hold the probe past the budget.
  await Promise.race([pool, new Promise((done) => setTimeout(done, ${totalMs}))]);
  const found = [...results.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1]);
  return {
    openapi: found.filter((item) => item.kind === 'openapi').map((item) => item.value),
    graphql: found.filter((item) => item.kind === 'graphql').map((item) => item.value),
  };
})()`;
}

type Field = { name: string; args?: { name: string }[] };
type GqlType = { name: string; fields?: Field[] | null };

function rootFields(schema: Record<string, unknown>, root: string): string[] {
  const name = (schema[root] as { name?: string } | null)?.name;
  const types = (schema.types ?? []) as GqlType[];
  const type = types.find((item) => item.name === name);
  return (type?.fields ?? []).map(
    (field) => `${field.name}(${(field.args ?? []).map((arg) => arg.name).join(", ")})`,
  );
}

/** Short listing of what the documents describe. */
export function summarizeDocs(docs: SiteDocs): DocsSummary {
  return {
    openapi: docs.openapi.map(({ url, title, document }) => ({
      url,
      ...(title ? { title } : {}),
      operations: Object.entries((document.paths ?? {}) as Record<string, Record<string, unknown>>)
        .flatMap(([path, item]) =>
          Object.entries(item)
            .filter(([method]) => /^(get|post|put|patch|delete)$/.test(method))
            .map(([method, op]) => {
              const summary = (op as { summary?: string; operationId?: string }) ?? {};
              return `${method.toUpperCase()} ${path}${summary.summary ? ` (${summary.summary})` : summary.operationId ? ` (${summary.operationId})` : ""}`;
            }),
        )
        .slice(0, 500),
    })),
    graphql: docs.graphql.map(({ url, schema }) => ({
      url,
      queries: rootFields(schema, "queryType"),
      mutations: rootFields(schema, "mutationType"),
      subscriptions: rootFields(schema, "subscriptionType"),
      types: ((schema.types ?? []) as unknown[]).length,
    })),
  };
}

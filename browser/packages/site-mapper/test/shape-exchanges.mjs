// Exchanges shaped like a real browser capture, built by hand for inference tests.
let next = 0;
const encode = (json) => (json === undefined ? undefined : JSON.stringify(json));
const optional = (key, value) => (value === undefined ? {} : { [key]: value });
export function exchange(url, options = {}) {
  const {
    method = "GET",
    json,
    body,
    mime = "application/json",
    headers = {},
    status = 200,
  } = options;
  const text = body ?? encode(json);
  return {
    id: `t#${next++}`,
    source: "t",
    startedAt: next,
    method,
    url,
    requestHeaders: { ...headers },
    status,
    responseHeaders: { "content-type": mime },
    responseMime: mime,
    resourceType: options.type ?? "fetch",
    ...optional("responseBody", text),
    ...optional("requestBody", options.requestBody),
    ...optional("pageUrl", options.pageUrl),
    ...optional("provenance", options.provenance),
  };
}

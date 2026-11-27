// Small HAR builders for tests that store a flow by hand.
export function harEntry(url, { method = "GET", headers = {}, status = 200, json, page } = {}) {
  return {
    startedDateTime: new Date().toISOString(),
    time: 10,
    ...(page ? { pageref: page } : {}),
    request: {
      method,
      url,
      httpVersion: "HTTP/1.1",
      headers: Object.entries({ accept: "application/json", ...headers }).map(([name, value]) => ({
        name,
        value,
      })),
      queryString: [...new URL(url).searchParams].map(([name, value]) => ({ name, value })),
      cookies: [],
      headersSize: -1,
      bodySize: 0,
    },
    response: {
      status,
      statusText: "OK",
      httpVersion: "HTTP/1.1",
      headers: [{ name: "content-type", value: "application/json" }],
      cookies: [],
      content: { size: 0, mimeType: "application/json", text: JSON.stringify(json ?? {}) },
      redirectURL: "",
      headersSize: -1,
      bodySize: -1,
    },
    cache: {},
    timings: { send: 0, wait: 10, receive: 0 },
  };
}

export const har = (entries) => ({ log: { version: "1.2", creator: { name: "test" }, entries } });

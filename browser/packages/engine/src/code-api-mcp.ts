// The chat's connected MCP tools, callable inside browser_code as mcp.<server>.<tool>(args),
// where <server> is the slug of the server's name (mcp.notion.create_page) or its capability id.
// The realm owns only the call shape; the daemon owns the real tool list. A proxy gives one
// function per (server, tool) without shipping the list into the sandbox, so a loop can call a
// tool per page item in one cell. The host validates names, parses JSON, throws a tool's text as
// an error, and rejects an unknown tool with the available names. No browser tool lives here, so
// mcp can never call browser_code (no recursion).

export const browserMcpApi = `
var __mcpApi = {
  // Per-server tool counts and up to 20 one-line tool refs; use search for the rest.
  list: () => __call({ mcp: { list: true } }),
  // The best-matching tools for a query, as [{server, slug, name, description, inputKeys}].
  search: (query, options) => __call({ mcp: { search: String(query ?? ''), limit: options && typeof options.limit === 'number' ? options.limit : undefined } }),
  // The same as mcp[server][tool](args), for names held in variables.
  call: (server, tool, args) => __call({ mcp: { server: String(server), tool: String(tool), args: args === undefined ? {} : args } }),
};
var mcp = new Proxy(__mcpApi, {
  get: (target, server) => {
    if (Object.prototype.hasOwnProperty.call(target, server)) return target[server];
    if (typeof server !== 'string' || !server || server === 'then' || server === 'toJSON') return undefined;
    return new Proxy({}, {
      get: (_tools, tool) => {
        if (typeof tool !== 'string' || !tool || tool === 'then' || tool === 'toJSON') return undefined;
        return (args) => __call({ mcp: { server, tool, args: args === undefined ? {} : args } });
      },
    });
  },
});
globalThis.mcp = mcp;
`;

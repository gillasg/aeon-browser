// The chat's connected MCP tools, callable inside browser_code as mcp.<server>.<tool>(args).
// The realm owns only the call shape; the daemon owns the real tool list. A proxy gives one
// function per (server, tool) without shipping the list into the sandbox, so a loop can call a
// tool per page item in one cell. The host validates names, parses JSON, throws a tool's text as
// an error, and rejects an unknown tool with the available names. No browser tool lives here, so
// mcp can never call browser_code (no recursion).

export const browserMcpApi = `
var __mcpApi = {
  // Names and one-line descriptions of the connected MCP tools, as [{name: 'server.tool', description}].
  list: () => __call({ mcp: { list: true } }),
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

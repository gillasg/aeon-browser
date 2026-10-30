import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";

export interface CapabilityToolHost {
  execute(
    chatId: string,
    toolCallId: string,
    toolName: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<string>;
}

const empty = Type.Object({}, { additionalProperties: false });
const record = Type.Record(Type.String(), Type.Unknown());
const revisioned = Type.Object(
  { expectedRevision: Type.Integer({ minimum: 0 }), capability: record },
  { additionalProperties: false },
);
const capabilityId = Type.Object(
  {
    expectedRevision: Type.Integer({ minimum: 0 }),
    capabilityId: Type.String({ minLength: 1, maxLength: 64 }),
  },
  { additionalProperties: false },
);
const routineCreate = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 120 }),
    instruction: Type.String({ minLength: 1, maxLength: 20_000 }),
    check: Type.Optional(Type.String({ minLength: 1, maxLength: 8000 })),
    sites: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 50 }),
    ),
    schedule: record,
    requiredBrowserInstanceId: Type.Optional(Type.String({ format: "uuid" })),
  },
  { additionalProperties: false },
);
const routinePreview = Type.Object({ schedule: record }, { additionalProperties: false });
const routineUpdate = Type.Object(
  {
    routineId: Type.String({ minLength: 1, maxLength: 64 }),
    expectedRevision: Type.Integer({ minimum: 1 }),
    title: Type.String({ minLength: 1, maxLength: 120 }),
    instruction: Type.String({ minLength: 1, maxLength: 20_000 }),
    check: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 8000 }), Type.Null()])),
    sites: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 50 }),
    ),
    schedule: record,
    enabled: Type.Boolean(),
    requiredBrowserInstanceId: Type.Optional(
      Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
    ),
  },
  { additionalProperties: false },
);
const routineId = Type.Object(
  { routineId: Type.String({ minLength: 1, maxLength: 64 }) },
  { additionalProperties: false },
);
const routineDelete = Type.Object(
  {
    routineId: Type.String({ minLength: 1, maxLength: 64 }),
    expectedRevision: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
const pinResult = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 120 }),
    value: Type.Optional(Type.String({ maxLength: 200 })),
    detail: Type.Optional(Type.String({ maxLength: 300 })),
    condition: Type.Optional(Type.String({ maxLength: 200 })),
    site: Type.Optional(Type.String({ maxLength: 200 })),
    operation: Type.Optional(Type.String({ maxLength: 200 })),
    params: Type.Optional(record),
    refreshMinutes: Type.Optional(Type.Integer({ minimum: 5, maximum: 1440 })),
    remove: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export function createCapabilityTools(
  chatId: string,
  host?: CapabilityToolHost,
): ReturnType<typeof defineTool>[] {
  return [
    ...createRegistryTools(chatId, host),
    ...createRoutineTools(chatId, host),
    ...createPinTools(chatId, host),
  ];
}

/** Keeping an answer on the new-tab home, where it stays current on its own when it can. */
function createPinTools(
  chatId: string,
  host?: CapabilityToolHost,
): ReturnType<typeof defineTool>[] {
  return [
    tool(
      chatId,
      host,
      "pin_result",
      "Keep an answer on the new-tab home. Call it when the user says 'pin this', 'keep this on my home' " +
        "or asks for something to stay visible. Pass the answer as value, plus site and operation when it " +
        "came from a mapped site API read (the pin then refreshes itself with no model; add params when the " +
        "read needs them and refreshMinutes for how often). A saved answer stays as it was. " +
        "For a watcher, create a routine with a check instead: its checks update its pin by themselves. " +
        "remove: true unpins the card with the same title.",
      pinResult,
    ),
  ];
}

function createRegistryTools(
  chatId: string,
  host?: CapabilityToolHost,
): ReturnType<typeof defineTool>[] {
  return [
    tool(
      chatId,
      host,
      "list_configured_capabilities",
      "When a task may need an external CLI or MCP, query this live registry first. Use explicitly registered CLIs through Pi's pippin_cli tools or use Pi's shell. Treat verification as historical unless rechecked.",
      empty,
    ),
    tool(
      chatId,
      host,
      "register_capability",
      "Register a non-secret CLI or MCP capability.",
      revisioned,
    ),
    tool(
      chatId,
      host,
      "update_capability",
      "Update a configured CLI or MCP capability.",
      revisioned,
    ),
    tool(
      chatId,
      host,
      "remove_capability",
      "Remove a configured CLI or MCP capability.",
      capabilityId,
    ),
    tool(
      chatId,
      host,
      "recheck_capability",
      "Run a safe CLI version probe or MCP handshake.",
      capabilityId,
    ),
  ];
}

function createRoutineTools(
  chatId: string,
  host?: CapabilityToolHost,
): ReturnType<typeof defineTool>[] {
  return [
    tool(
      chatId,
      host,
      "create_routine",
      "Create a routine. Optionally require the browser's clientInstanceId from " +
        "browser.tabs() in browser_code; absent instances are recorded unavailable before Pi starts. " +
        "The user says it in plain words ('check this every 3 hours', 'tell me when it drops'); pick the " +
        "cheapest form yourself and never ask them to choose: a check whenever a site's learned API or a " +
        "page read can tell whether there is something to report (no model call until it passes), " +
        "otherwise just the instruction, which runs the agent on schedule. " +
        "For a check, add check: browser_code that runs on each slot without a model call " +
        "(e.g. const p = await browser.openTab(url); const price = await p.evaluate(() => ...); " +
        "await p.close(); price < 400 ? {price} : false). You are woken with the instruction only " +
        "when its last expression is truthy, and receive that value. Watchers may run every minute. " +
        "Use them as event triggers: new items from a mapped API " +
        "(const r = await siteMapper.watch('shop.com', 'searchListings', {q: 'lamp'}); r.new.length ? r.new : false), " +
        "a new message or email (siteMapper.watch on the inbox's API, or count unread on the page), " +
        "a page changing (const t = (await browser.fetch(url, {as: 'text'})).text; " +
        "const changed = globalThis.last !== undefined && globalThis.last !== t; globalThis.last = t; changed). " +
        "Check variables persist between runs. " +
        "When the user wants it kept to particular sites ('only example.com'), pass sites: ['example.com']: " +
        "its own runs then use those sites and no others. " +
        'For instant triggers, start the check with "use listen"; and make it wait: it then runs continuously ' +
        "(each run up to a minute) and wakes you the moment it returns something truthy, e.g. " +
        "\"use listen\"; const p = await browser.openTab(url); await p.waitForChange('.inbox', {timeoutMs: 55000}) " +
        "(also p.waitForResponse('/api/messages'), p.waitForMessage(/new_message/) for WebSockets). " +
        "Schedules: {kind: 'interval', everyMinutes}, {kind: 'calendar', daysOfWeek, localTime} or {kind: 'once', atUtc} for one run at an exact time. " +
        "To act at an exact moment (a drop, a ticket or booking release, a slot opening): if it is under 55 minutes away call browser.snipe now; " +
        "otherwise create a routine with {kind: 'once', atUtc: about 3 minutes before} whose instruction calls browser.snipe({at, url, prepare, fire, done}) (help('snipe')).",
      routineCreate,
    ),
    tool(
      chatId,
      host,
      "preview_routine_schedule",
      "Preview the next three schedule instants in the stored timezone before creating a routine.",
      routinePreview,
    ),
    tool(
      chatId,
      host,
      "update_routine",
      "Update or disable one of this Chat's routines.",
      routineUpdate,
    ),
    tool(chatId, host, "list_routines", "List this Chat's routines and recent run history.", empty),
    tool(
      chatId,
      host,
      "run_routine",
      "Run one of this Chat's routines now without shifting its schedule.",
      routineId,
    ),
    tool(
      chatId,
      host,
      "delete_routine",
      "Delete one of this Chat's routines while retaining its run history.",
      routineDelete,
    ),
  ];
}

function tool(
  chatId: string,
  host: CapabilityToolHost | undefined,
  name: string,
  description: string,
  parameters: TSchema,
): ReturnType<typeof defineTool> {
  return defineTool({
    name,
    label: name.replaceAll("_", " "),
    description,
    parameters,
    execute: async (toolCallId, input, signal) => {
      const result = host
        ? await host.execute(chatId, toolCallId, name, input, signal)
        : JSON.stringify({ error: "CAPABILITY_TOOLS_OFFLINE" });
      return { content: [{ type: "text", text: result }], details: undefined };
    },
  });
}

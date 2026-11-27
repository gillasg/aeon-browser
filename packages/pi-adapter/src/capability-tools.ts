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
const routineListen = Type.Object(
  {
    url: Type.String({ minLength: 1, maxLength: 2000 }),
    type: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  },
  { additionalProperties: false },
);
const routineWebhook = Type.Object(
  {
    url: Type.String({ minLength: 1, maxLength: 2000 }),
    secret: Type.Optional(Type.String({ maxLength: 200 })),
  },
  { additionalProperties: false },
);
const routineEffect = Type.Union([
  Type.Literal("read"),
  Type.Literal("write"),
  Type.Literal("irreversible"),
]);
const routineCreate = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 120 }),
    instruction: Type.String({ minLength: 1, maxLength: 20_000 }),
    check: Type.Optional(Type.String({ minLength: 1, maxLength: 8000 })),
    listen: Type.Optional(routineListen),
    sites: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 50 }),
    ),
    schedule: record,
    requiredBrowserInstanceId: Type.Optional(Type.String({ format: "uuid" })),
    webhook: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 2000 }), routineWebhook]),
    ),
    webhookSecret: Type.Optional(Type.String({ maxLength: 200 })),
    webhookOnly: Type.Optional(Type.Boolean()),
    effect: Type.Optional(routineEffect),
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
    listen: Type.Optional(Type.Union([routineListen, Type.Null()])),
    sites: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 50 }),
    ),
    schedule: record,
    enabled: Type.Boolean(),
    requiredBrowserInstanceId: Type.Optional(
      Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
    ),
    webhook: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 2000 }), routineWebhook, Type.Null()]),
    ),
    webhookSecret: Type.Optional(Type.String({ maxLength: 200 })),
    webhookOnly: Type.Optional(Type.Boolean()),
    effect: Type.Optional(routineEffect),
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
export function createCapabilityTools(
  chatId: string,
  host?: CapabilityToolHost,
): ReturnType<typeof defineTool>[] {
  return [...createRegistryTools(chatId, host), ...createRoutineTools(chatId, host)];
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
        "Watcher shape: {title, instruction, schedule: {kind: 'interval', everyMinutes: 5}, check: \"...\"}. " +
        "The check is browser_code that runs on each slot with no model call; its last expression decides: " +
        "truthy wakes you with the instruction and that value, false does nothing and costs nothing " +
        "(e.g. const p = await browser.openTab(url); const price = await p.evaluate(() => ...); " +
        "await p.close(); price < 400 ? {price} : false). The schedule is the polling: never loop, sleep or wait inside a check, " +
        "and never wait for the condition yourself; 'tell me when' is this watcher, created now, then end the turn. " +
        "Set everyMinutes from how fast the watched condition changes, not from how far off it is (watchers may run every minute): " +
        "a condition that can flip in minutes needs a minute-level poll, not 10-30 minutes; keep long intervals for steady things and one-time moments. " +
        "Event triggers: new items from a mapped API " +
        "(const r = await siteMapper.watch('shop.com', 'searchListings', {q: 'lamp'}); r.new.length ? r.new : false), " +
        "a new message or email (siteMapper.watch on the inbox's API, or count unread on the page), " +
        "new rows on a page (const r = browser.changes('lamps', (await p.list()).items); r.new.length ? r.new : false; " +
        "browser.changes returns {new, changed, gone} against its last run, keyed by id, url or href). " +
        "Check variables persist between runs (declare them: let seen = false). " +
        "A tell-me-when-it-opens check tests that today's text ('opens at', 'sold out', the old price) is gone, not for wording you guess. " +
        "For a tell-me-when on a site the user keeps open, set listen: {url: '<part of the response URL>', type?: 'json'} beside the schedule: the check gets `response` (its `body` is that response, parsed when JSON) on each matching load, with no extra requests; the timer runs when no such tab is open. " +
        "When the user wants it kept to particular sites ('only example.com'), pass sites: ['example.com']: " +
        "its own runs then use those sites and no others. " +
        'For instant triggers, start the check with "use listen"; and make it wait: it then runs continuously ' +
        "(each run up to a minute) and wakes you the moment it returns something truthy, e.g. " +
        "\"use listen\"; const p = await browser.openTab(url); await p.waitForChange('.inbox', {timeoutMs: 55000}) " +
        "(also p.waitForResponse('/api/messages'), p.waitForMessage(/new_message/) for WebSockets). " +
        "Schedules: {kind: 'interval', everyMinutes}, {kind: 'calendar', daysOfWeek, localTime} or {kind: 'once', atUtc} for one run at an exact time. " +
        "A once schedule runs its check one time: a page a second early returns false and nothing fires, so a 'tell me when it opens' watcher polls every minute (or listens) from now instead. " +
        "The instruction is what you are woken with when the check passes, so write it as that moment's job ('The lamp is now under 2000: tell the user the price from the check value and the link'), not as the user's original request. " +
        "Acting at an exact moment (buying at a drop, booking at a release) under 55 minutes away: call browser.snipe in browser_code now, without wait (it runs in the background). Only telling the user when it comes is a watcher like the one above. " +
        "Later: a watcher with schedule {kind: 'once', atUtc: '<3 minutes before>'} whose check is exactly " +
        "return await browser.snipe({at: '2026-12-01T09:00:00Z', url: 'https://shop.example/drop', prepare: async (page) => { await page.getByLabel('Seats').fill('2'); }, " +
        "fire: async (page) => { await page.getByRole('button', {name: 'Book'}).click(); return 'clicked'; }, " +
        "done: async (page, result) => result === 'clicked', wait: true}). " +
        "It fires with no model call and its result wakes you; the options are exactly at, url, prepare, fire, done, wait (help('snipe')). " +
        "webhook {url, secret?} POSTs {routineId, title, value, firedAt} when the check passes (HMAC-SHA256 in X-Graft-Signature when secret is set). webhookOnly delivers that and does not wake you. effect is read, write or irreversible (inferred when omitted).",
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
      "Update or disable one of this Chat's routines. Omit webhook, webhookOnly and effect to keep them; webhook null removes it.",
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

export interface ActivityReply {
  idle: boolean;
  busy: string[];
}

export interface UpdateIdleOptions {
  probe: () => Promise<ActivityReply | null>;
  update: () => Promise<number> | number;
  write: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  intervalMs?: number;
}

const WAIT_MS = 2000;

/**
 * Polls until the daemon reports idle. A daemon that is not running is idle for this purpose:
 * there is no chat to interrupt. A busy daemon is never stopped; the caller can Ctrl+C the update.
 */
export async function waitUntilDaemonIdle(
  options: Omit<UpdateIdleOptions, "update">,
): Promise<"idle" | "down"> {
  let announced = "";
  let waited = false;
  for (;;) {
    const reply = await readProbe(options.probe);
    if (!reply) {
      options.write("Aeon is not running, so this update will not interrupt a chat.\n");
      return "down";
    }
    if (reply.idle) {
      if (waited) options.write("Aeon is idle. Updating.\n");
      return "idle";
    }
    waited = true;
    const line = waitingLine(reply.busy);
    if (line !== announced) {
      options.write(line);
      announced = line;
    }
    await options.sleep(options.intervalMs ?? WAIT_MS);
  }
}

export async function runUpdateWhenIdle(options: UpdateIdleOptions): Promise<number> {
  await waitUntilDaemonIdle(options);
  return options.update();
}

/** The daemon's own report wins. An older daemon still blocks on a working or asking chat. */
export function mergeActivity(
  reported: ActivityReply | undefined,
  chats: { working?: boolean; asking?: unknown }[],
): ActivityReply {
  if (reported) return { idle: reported.idle, busy: [...reported.busy] };
  const busy: string[] = [];
  const working = chats.filter((chat) => chat.working).length;
  const asking = chats.filter((chat) => Boolean(chat.asking)).length;
  if (working) busy.push(working === 1 ? "1 chat working" : `${working} chats working`);
  if (asking) busy.push(asking === 1 ? "1 chat waiting on you" : `${asking} chats waiting on you`);
  return { idle: busy.length === 0, busy };
}

/** Null when nothing is listening. A failed activity read falls back to the attention snapshot. */
export async function probeDaemonActivity(): Promise<ActivityReply | null> {
  const { AeonClient } = await import("./client.js");
  let client: InstanceType<typeof AeonClient> | undefined;
  try {
    client = await AeonClient.connect();
  } catch {
    return null;
  }
  try {
    try {
      return await client.activity();
    } catch {
      return mergeActivity(undefined, client.snapshotChats());
    }
  } finally {
    client.close();
  }
}

async function readProbe(
  probe: () => Promise<ActivityReply | null>,
): Promise<ActivityReply | null> {
  try {
    return await probe();
  } catch {
    return null;
  }
}

function waitingLine(busy: string[]): string {
  const why = busy.length ? busy.join("; ") : "work is still running";
  return `Waiting for Aeon to finish (${why}). The update has not started; Ctrl+C leaves that work running.\n`;
}

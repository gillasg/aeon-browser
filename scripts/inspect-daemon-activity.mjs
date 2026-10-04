import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const { WebSocket } = createRequire(new URL("../apps/daemon/package.json", import.meta.url))("ws");
const root = join(process.env.LOCALAPPDATA ?? "", "Pippin", "Slice3Dev");
const config = JSON.parse(await readFile(join(root, "host-config.json"), "utf8"));
const origin = "chrome-extension://" + config.extensionId;
const identity = { clientInstanceId: randomUUID(), browserRunId: randomUUID() };
const protocolVersion = { major: 1, minor: 1 };
const sockets = [];

function bootstrap() {
  return new Promise((resolve, reject) => {
    const child = spawn(join(root, "pippin-native-host.exe"), [origin + "/"], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const chunks = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(Error("Native bootstrap timed out"));
    }, 10000);
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.once("error", reject);
    child.once("close", () => {
      clearTimeout(timer);
      try {
        const data = Buffer.concat(chunks);
        resolve(JSON.parse(data.subarray(4, 4 + data.readInt32LE(0)).toString()));
      } catch {
        reject(Error("Invalid native bootstrap response"));
      }
    });
    const payload = Buffer.from(
      JSON.stringify({ kind: "native.bootstrap", protocolVersion, ...identity }),
    );
    const header = Buffer.alloc(4);
    header.writeInt32LE(payload.length);
    child.stdin.end(Buffer.concat([header, payload]));
  });
}
function request(socket, payload, predicate) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", read);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(Error("Read-only activity request timed out"));
    }, 15000);
    const read = (data) => {
      const value = JSON.parse(String(data));
      if (predicate(value)) {
        cleanup();
        resolve(value);
      }
    };
    socket.on("message", read);
    socket.send(JSON.stringify(payload));
  });
}
async function connect(endpoint, grant, role, pageInstanceId) {
  const socket = new WebSocket(endpoint, { origin });
  sockets.push(socket);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const reply = await request(
    socket,
    {
      kind: "auth.hello",
      protocolVersion,
      role,
      ...identity,
      connectionGrant: grant,
      ...(pageInstanceId ? { pageInstanceId } : {}),
    },
    (value) => ["auth.ready", "auth.rejected"].includes(value.kind),
  );
  if (reply.kind !== "auth.ready") throw Error(reply.code);
  return socket;
}
async function page(executor, endpoint, scope) {
  const requestId = randomUUID(),
    pageInstanceId = randomUUID();
  const grant = await request(
    executor,
    { kind: "grant.page.issue", requestId, pageInstanceId, scope },
    (value) => value.requestId === requestId,
  );
  if (!grant.ok) throw Error(grant.code);
  return connect(endpoint, grant.connectionGrant, "ui", pageInstanceId);
}
async function command(socket, operation, payload) {
  const requestId = randomUUID();
  const reply = await request(
    socket,
    { kind: "command", requestId, operation, payload },
    (value) =>
      value.requestId === requestId && ["command.completed", "command.failed"].includes(value.kind),
  );
  if (reply.kind === "command.failed") throw Error(reply.code);
  return reply.result;
}
try {
  const grant = await bootstrap();
  if (!grant.ok) throw Error(grant.code);
  const executor = await connect(grant.endpoint, grant.connectionGrant, "extension-executor");
  const catalog = await page(executor, grant.endpoint, { kind: "catalog" });
  const { chats } = await command(catalog, "chat.list", { limit: 100, includeArchived: true });
  let active = 0,
    unknown = chats.length >= 100 ? 1 : 0;
  for (const chat of chats) {
    if (chat.status === "draft") continue;
    const socket = await page(executor, grant.endpoint, { kind: "chat", chatId: chat.chatId });
    const { controls } = await command(socket, "chat.controls", { chatId: chat.chatId });
    if (!controls) unknown++;
    else if (controls.active) active++;
    socket.close();
  }
  process.stdout.write(
    JSON.stringify({
      checkedChats: chats.length,
      activeChats: active,
      unknownChats: unknown,
      safeToRestart: active === 0 && unknown === 0,
    }) + "\n",
  );
} finally {
  for (const socket of sockets) socket.close();
}

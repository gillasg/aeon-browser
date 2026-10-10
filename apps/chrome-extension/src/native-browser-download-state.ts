import type { BrowserTargetKey } from "@pippin/protocol";
interface Owner {
  chatId: string;
  target: BrowserTargetKey;
}
const key = "aeon-download-owners",
  owners = new Map<number, Owner>();
let loading: Promise<void> | undefined,
  writes: Promise<unknown> = Promise.resolve();
export async function ownsDownload(
  id: number,
  chatId: string,
  target: BrowserTargetKey,
): Promise<boolean> {
  await load();
  const owner = owners.get(id);
  return (
    !!owner &&
    owner.chatId === chatId &&
    owner.target.clientInstanceId === target.clientInstanceId &&
    owner.target.browserRunId === target.browserRunId
  );
}
export async function rememberDownload(
  id: number,
  chatId: string,
  target: BrowserTargetKey,
): Promise<boolean> {
  await load();
  const owner = owners.get(id);
  if (owner && owner.chatId !== chatId) throw new Error("CLAIM_CONFLICT");
  owners.set(id, { chatId, target });
  while (owners.size > 256) owners.delete(owners.keys().next().value ?? -1);
  if (chrome.storage?.session) {
    const data = [...owners];
    writes = writes.catch(() => undefined).then(() => chrome.storage.session.set({ [key]: data }));
    try {
      await writes;
    } catch {
      return false;
    }
  }
  return true;
}
async function load(): Promise<void> {
  loading ??= readStored();
  return loading;
}
async function readStored(): Promise<void> {
  if (!chrome.storage?.session) return;
  const data = (await chrome.storage.session.get(key))[key] as [number, Owner][] | undefined;
  for (const [id, owner] of data ?? []) if (!owners.has(id)) owners.set(id, owner);
}

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { PiSessionHandle } from "@pippin/domain";
type Input = Parameters<NonNullable<PiSessionHandle["editQueue"]>>[0];
export function editSessionQueue(session: AgentSession, input: Input): void {
  const steering = [...session.getSteeringMessages()];
  const followUp = [...session.getFollowUpMessages()];
  if (JSON.stringify([steering, followUp]) !== JSON.stringify([input.steering, input.followUp]))
    throw new Error("The queue changed. Please try again.");
  type Message = ReturnType<AgentSession["agent"]["peekQueuedMessages"]>[number];
  const queues = session.agent as unknown as {
    steeringQueue: { peek(): Message[] }; followUpQueue: { peek(): Message[] };
  };
  if (!queues.steeringQueue?.peek || !queues.followUpQueue?.peek)
    throw new Error("This Pi version does not support queue editing.");
  const messages = [...queues.steeringQueue.peek(), ...queues.followUpQueue.peek()];
  if (messages.length !== steering.length + followUp.length)
    throw new Error("The queue is being delivered. Please try again.");
  const items = messages.map((message, index) => ({
    text: index < steering.length ? (steering[index] ?? "") : (followUp[index - steering.length] ?? ""),
    images: message.role === "user" && Array.isArray(message.content)
      ? message.content.filter((block) => block.type === "image") : [],
  }));
  const groups = { steer: items.slice(0, steering.length), followUp: items.slice(steering.length) };
  updateItems(groups, input);
  // Pi 0.99.1 exposes no queue replacement API. Its internal enqueue methods
  // retain expanded text and image attachments without expanding commands twice.
  type Images = Parameters<AgentSession["steer"]>[1];
  const enqueue = session as unknown as {
    _queueSteer(text: string, images?: Images): Promise<void>;
    _queueFollowUp(text: string, images?: Images): Promise<void>;
  };
  if (typeof enqueue._queueSteer !== "function" || typeof enqueue._queueFollowUp !== "function")
    throw new Error("This Pi version does not support queue editing.");
  session.clearQueue();
  for (const entry of groups.steer) void enqueue._queueSteer(entry.text, entry.images as Images);
  for (const entry of groups.followUp) void enqueue._queueFollowUp(entry.text, entry.images as Images);
}

type Item = { text: string; images: unknown[] };
function updateItems(groups: { steer: Item[]; followUp: Item[] }, input: Input): void {
  const list = groups[input.mode], item = list[input.index];
  if (!item) throw new Error("This queued message has already been delivered.");
  if (input.action === "edit") {
    if (!input.text) throw new Error("Enter a message.");
    item.text = input.text;
  } else if (input.action === "delete") list.splice(input.index, 1);
  else if (input.action === "steer") {
    if (input.mode === "steer") return;
    list.splice(input.index, 1); groups.steer.push(item);
  } else {
    const target = input.index + (input.action === "up" ? -1 : 1);
    if (target < 0 || target >= list.length) return;
    [list[input.index], list[target]] = [list[target] as Item, item];
  }
}

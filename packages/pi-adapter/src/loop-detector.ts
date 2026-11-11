// Three identical calls (same arguments and same result), or three errors on one
// arguments key, get one steer. The next repeat stops. A poll whose text changes does not.

export interface LoopState {
  recent: LoopCall[];
  steered: boolean;
}

export interface LoopCall {
  key: string;
  tool: string;
  error: boolean;
  result: string;
}

export interface LoopNote {
  tool: string;
  args: unknown;
  error: boolean;
  result: string;
}

export function freshLoop(): LoopState {
  return { recent: [], steered: false };
}

export function noteLoop(state: LoopState, call: LoopNote): { steer?: string; stop?: string } {
  const key = `${call.tool} ${stable(call.args)}`;
  state.recent.push({ key, tool: call.tool, error: call.error, result: call.result.slice(0, 180) });
  if (state.recent.length > 6) state.recent.shift();
  const streak = repeating(state.recent, key);
  if (!streak) {
    state.steered = false;
    return {};
  }
  const shown = state.recent
    .slice(-3)
    .map((item) => `${item.key} → ${item.result}`)
    .join("\n");
  if (!state.steered) {
    state.steered = true;
    return { steer: `The last three calls repeated:\n${shown}` };
  }
  return { stop: `Stopped: the same call repeated after a steer.\n${shown}` };
}

function repeating(recent: LoopCall[], key: string): boolean {
  const last = recent.slice(-3);
  if (last.length < 3 || last.some((item) => item.key !== key)) return false;
  if (last.every((item) => item.error)) return true;
  const result = last[0]?.result;
  return last.every((item) => item.result === result);
}

function stable(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

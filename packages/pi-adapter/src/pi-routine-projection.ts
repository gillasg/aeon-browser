import type { PiMessageProjection } from "@pippin/domain";
import { isRecord, stringProperty } from "./pi-thread-delivery-evidence.js";

export const PI_ROUTINE_INVOCATION_TYPE = "pippin.routine-invocation.v1";
export const PI_ROUTINE_SETTLEMENT_TYPE = "pippin.routine-settlement.v1";

export function projectRoutineInvocation(
  customType: string,
  details: unknown,
): PiMessageProjection | undefined {
  if (customType !== PI_ROUTINE_INVOCATION_TYPE || !isRecord(details)) return;
  const runId = stringProperty(details, "runId");
  const routineId = stringProperty(details, "routineId");
  const title = stringProperty(details, "title");
  const scheduledSlot = stringProperty(details, "scheduledSlot");
  const instruction = stringProperty(details, "instruction");
  if (!runId || !routineId || !title || !scheduledSlot || !instruction) return;
  return {
    role: "custom",
    content: [{ type: "routine-invocation", runId, routineId, title, scheduledSlot, instruction }],
  };
}

export function projectRoutineSettlement(
  customType: string,
  data: unknown,
): PiMessageProjection | undefined {
  if (customType !== PI_ROUTINE_SETTLEMENT_TYPE || !isRecord(data)) return;
  const runId = stringProperty(data, "runId");
  const routineId = stringProperty(data, "routineId");
  const acceptedTurnId = stringProperty(data, "acceptedTurnId");
  const piEntryId = stringProperty(data, "piEntryId");
  if (
    !runId ||
    !routineId ||
    !acceptedTurnId ||
    !piEntryId ||
    (data.state !== "completed" && data.state !== "failed")
  )
    return;
  return {
    role: "custom",
    content: [
      { type: "routine-result", runId, routineId, state: data.state, piEntryId, acceptedTurnId },
    ],
  };
}

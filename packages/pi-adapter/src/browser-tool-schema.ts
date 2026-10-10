import { Type } from "typebox";
import { BrowserStepSchema } from "@aeon/protocol";
// One validation contract for the low-level tool and the executor bridge.
const step = Type.Unsafe(BrowserStepSchema.toJSONSchema({ io: "input", target: "draft-7" }));
export const browserParameters = Type.Object(
  { steps: Type.Array(step, { minItems: 1, maxItems: 8 }) },
  { additionalProperties: false },
);
